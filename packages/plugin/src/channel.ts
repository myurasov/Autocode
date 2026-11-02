/*
 * The plugin's end of the channel to the Autocode server: keeps this host
 * connected, runs the server's instructions and sends the plugin's events.
 */

import { VERSION } from "@autocode/shared"
import { request, ServerError } from "./client.ts"
import type { ClientConfig } from "./config.ts"

/*
 * The plugin's channel to the server: hello, then long polls for instructions,
 * each acknowledged through events. Any failure ends the cycle; the next hello
 * comes after a backoff that doubles up to a maximum and starts over only once
 * a poll succeeds. Instructions run beside the polls (a long one never stops
 * them), each ID once.
 */

export interface Instruction {
  id: string
  type: string
  payload: any
}

export interface ChannelOptions {
  config: ClientConfig
  host: string
  instance: string
  machine: string
  directory: string
  opencodeVersion: string
  // The OpenCode process the plugin runs in (processOf).
  process?: { pid: number; kind: string }
  // Whether the plugin can set its sessions' shell values (localapi.ts).
  shellValues?: boolean
  onInstruction: (instruction: Instruction) => Promise<unknown>
  // Given the sessions the server holds for this host, returns the ones that no
  // longer exist.
  goneSessions?: (sessions: string[]) => Promise<string[]>
  // The top-level sessions OpenCode holds in this folder, reported with each
  // hello.
  sessions?: () => Promise<{ id: string; directory?: string }[]>
  log?: (line: string) => void
  backoffMs?: { min: number; max: number }
  supersededWaitMs?: number
}

export type ChannelState =
  | "starting"
  | "connected"
  | "backoff"
  | "wrong_server"
  | "superseded"
  | "stopped"

export class Channel {
  state: ChannelState = "starting"
  serverId?: string
  pollWait = 50
  private readonly abort = new AbortController()
  private outbox: unknown[] = []
  private looping?: Promise<void>
  // After being superseded, the instance only takes the host back once the
  // newer instance is gone.
  private takeover = true
  private connectedWaiters: (() => void)[] = []
  // Instructions being handled, and the acknowledgements of the latest handled
  // ones (sent again if one comes again).
  private readonly running = new Set<string>()
  private readonly acked = new Map<string, Record<string, unknown>>()
  private readonly log: (line: string) => void

  constructor(private readonly options: ChannelOptions) {
    this.log = options.log ?? (() => {})
  }

  private get base() {
    return `/v1/hosts/${encodeURIComponent(this.options.host)}`
  }

  private call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
  ) {
    return request(
      this.options.config.url,
      this.options.config.consumer_token,
      method,
      path,
      body,
      timeoutMs,
      this.abort.signal,
    )
  }

  start() {
    this.looping ??= this.loop()
  }

  async stop() {
    this.state = "stopped"
    this.abort.abort()
    await this.looping?.catch(() => {})
  }

  // Whether a request to the server is worth making now: not while it is known
  // to be down or the wrong one.
  get reachable(): boolean {
    return this.state === "connected" || this.state === "superseded"
  }

  // Queues an event (for example session.deleted) for the server; it is sent
  // with the next flush.
  report(event: unknown) {
    this.outbox.push(event)
    void this.flush()
  }

  whenConnected(timeoutMs: number): Promise<boolean> {
    if (this.state === "connected") return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve(this.state === "connected"),
        timeoutMs,
      )
      this.connectedWaiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private setConnected() {
    this.state = "connected"
    for (const wake of this.connectedWaiters.splice(0)) wake()
  }

  // Sent while connected, and while superseded too: what only this process sees
  // (its sessions' deletions) still counts.
  private async flush() {
    if (!this.reachable || !this.outbox.length) return
    const events = this.outbox.splice(0)
    try {
      await this.call("POST", `${this.base}/events`, {
        instance: this.options.instance,
        events,
      })
    } catch (err) {
      this.outbox.unshift(...events)
      this.log(`events not sent yet: ${(err as Error).message}`)
    }
  }

  private async sleep(ms: number) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      this.abort.signal.addEventListener("abort", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private async hello() {
    // An expected server ID is checked first, without the token: a wrong server
    // never hears from this plugin.
    const expected = this.options.config.server_id
    if (expected) {
      const info = await request(
        this.options.config.url,
        undefined,
        "GET",
        "/v1/info",
        undefined,
        10_000,
        this.abort.signal,
      )
      if (info?.id !== expected) {
        this.state = "wrong_server"
        throw new Error(
          `the server at ${this.options.config.url} is ${info?.id}, ` +
            `not ${expected}`,
        )
      }
    }
    const sessions = this.options.sessions
      ? await this.options.sessions().catch(() => undefined)
      : undefined
    const res = await this.call("POST", `${this.base}/hello`, {
      instance: this.options.instance,
      machine: this.options.machine,
      directory: this.options.directory,
      opencode: { version: this.options.opencodeVersion },
      plugin: { version: VERSION },
      ...(this.options.process ? { process: this.options.process } : {}),
      ...(this.options.shellValues === undefined
        ? {}
        : { shell_values: this.options.shellValues }),
      takeover: this.takeover,
      ...(sessions ? { sessions } : {}),
    })
    this.takeover = true
    this.serverId = res.server.id
    this.pollWait = Number(res.poll?.wait) || 50
    this.setConnected()
    this.log(`connected to ${res.server.id} as ${this.options.host}`)
    if (
      this.options.goneSessions &&
      Array.isArray(res.sessions) &&
      res.sessions.length
    ) {
      const gone = await this.options.goneSessions(res.sessions).catch(() => [])
      for (const session of gone)
        this.outbox.push({ type: "session.deleted", session })
    }
    await this.flush()
  }

  /*
   * Runs an instruction once: one that comes again while it runs is skipped,
   * and one that comes again after it ran (its acknowledgement was lost) gets
   * the same acknowledgement again.
   */
  private dispatch(instruction: Instruction) {
    if (this.running.has(instruction.id)) return
    const done = this.acked.get(instruction.id)
    if (done) {
      this.outbox.push(done)
      void this.flush()
      return
    }
    this.running.add(instruction.id)
    void this.handle(instruction)
  }

  private async handle(instruction: Instruction) {
    let ack: Record<string, unknown>
    try {
      const result = await this.options.onInstruction(instruction)
      ack = {
        type: "ack",
        id: instruction.id,
        ok: true,
        result: result ?? null,
      }
    } catch (err) {
      ack = {
        type: "ack",
        id: instruction.id,
        ok: false,
        error: (err as Error).message,
      }
    }
    this.acked.set(instruction.id, ack)
    if (this.acked.size > 500)
      this.acked.delete(this.acked.keys().next().value as string)
    this.running.delete(instruction.id)
    this.outbox.push(ack)
    await this.flush()
  }

  private async loop() {
    const min = this.options.backoffMs?.min ?? 1000
    const max = this.options.backoffMs?.max ?? 30_000
    let backoff = min
    while (!this.abort.signal.aborted) {
      try {
        await this.hello()
        while (!this.abort.signal.aborted) {
          const q =
            `wait=${this.pollWait}` +
            `&instance=${encodeURIComponent(this.options.instance)}`
          const res = await this.call(
            "GET",
            `${this.base}/next?${q}`,
            undefined,
            (this.pollWait + 15) * 1000,
          )
          backoff = min
          for (const instruction of res.instructions ?? [])
            this.dispatch(instruction)
          await this.flush()
        }
      } catch (err) {
        if (this.abort.signal.aborted) break
        if (
          err instanceof ServerError &&
          (err.code === "superseded" || err.code === "host_busy")
        ) {
          this.state = "superseded"
          this.takeover = false
          this.log("superseded by a newer instance of this host; waiting")
          await this.sleep(this.options.supersededWaitMs ?? 60_000)
          continue
        }
        if (this.state !== "wrong_server") this.state = "backoff"
        this.log(
          `channel: ${(err as Error).message}; next try in ${backoff} ms`,
        )
        await this.sleep(backoff)
        backoff = Math.min(backoff * 2, max)
      }
    }
    this.state = "stopped"
  }
}
