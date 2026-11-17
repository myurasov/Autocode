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
  // The sessions running a turn now (reported with each hello; undefined when
  // the plugin cannot tell).
  active?: () => Promise<string[] | undefined>
  // The hello's answer (the server's ID, the registered sessions).
  onHello?: (reply: any) => void
  log?: (line: string) => void
  backoffMs?: { min: number; max: number }
  supersededWaitMs?: number
  // How long until a refused OpenCode (older than the minimum) asks again.
  unsupportedWaitMs?: number
  // The consumer token the client config holds now: read again when the
  // server refuses this one (it was replaced: autocode token rotate).
  reloadToken?: () => string | undefined
}

// Events sent in one request, and how many may wait while the server is
// away (the oldest go first, with a line in the log).
const BATCH = 500
const MAX_WAITING = 50_000

export type ChannelState =
  | "starting"
  | "connected"
  | "backoff"
  | "wrong_server"
  | "superseded"
  // the server refused this OpenCode: older than Autocode's minimum
  | "unsupported"
  | "stopped"

export class Channel {
  state: ChannelState = "starting"
  // Why the server refused this OpenCode (state unsupported): what the tools
  // answer with.
  refused?: string
  serverId?: string
  pollWait = 50
  private readonly abort = new AbortController()
  private outbox: unknown[] = []
  // One send at a time, so events reach the server in the order they happened.
  private flushing?: Promise<void>
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
  // The consumer token in use: the config's, or the one read again after it
  // was replaced.
  private token: string
  private dropped = 0

  constructor(private readonly options: ChannelOptions) {
    this.log = options.log ?? (() => {})
    this.token = options.config.consumer_token
  }

  get consumerToken(): string {
    return this.token
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
      this.token,
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
    /*
     * While the server is away events wait (the review before 1.0.0: without
     * a limit). Of the sessions that run a turn only the newest report is
     * worth keeping, and past MAX_WAITING the oldest events go.
     */
    if ((event as any)?.type === "turns.active")
      this.outbox = this.outbox.filter(
        (e) => (e as any)?.type !== "turns.active",
      )
    this.outbox.push(event)
    if (this.outbox.length > MAX_WAITING) {
      this.outbox.splice(0, this.outbox.length - MAX_WAITING)
      if (!this.dropped++)
        this.log(
          `more than ${MAX_WAITING} events wait for the server: ` +
            "the oldest are dropped",
        )
    }
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

  /*
   * Sent while connected, and while superseded too: what only this process
   * sees (its sessions' deletions) still counts. One send at a time; a failed
   * one goes back to the front, ahead of anything that came meanwhile.
   */
  private flush(): Promise<void> {
    this.flushing ??= this.send().finally(() => {
      this.flushing = undefined
    })
    return this.flushing
  }

  /*
   * In batches, so that a backlog (a long outage) never is one request past
   * the server's size limit, which nothing would get through again (the
   * review before 1.0.0). A batch that is still too large is halved; a
   * single event that is too large is dropped.
   */
  private async send() {
    let size = BATCH
    while (this.reachable && this.outbox.length) {
      const events = this.outbox.splice(0, size)
      try {
        await this.call("POST", `${this.base}/events`, {
          instance: this.options.instance,
          events,
        })
        size = BATCH
        this.dropped = 0
      } catch (err) {
        if (err instanceof ServerError && err.status === 413) {
          if (events.length > 1) {
            this.outbox.unshift(...events)
            size = Math.ceil(events.length / 2)
          } else this.log("an event too large for the server was dropped")
          continue
        }
        this.outbox.unshift(...events)
        this.log(`events not sent yet: ${(err as Error).message}`)
        return
      }
    }
  }

  private async sleep(ms: number) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.abort.signal.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.abort.signal.addEventListener("abort", done)
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
    const active = this.options.active
      ? await this.options.active().catch(() => undefined)
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
      ...(active ? { active } : {}),
    })
    this.takeover = true
    this.refused = undefined
    this.serverId = res.server.id
    this.pollWait = Number(res.poll?.wait) || 50
    this.setConnected()
    this.log(`connected to ${res.server.id} as ${this.options.host}`)
    try {
      this.options.onHello?.(res)
    } catch (err) {
      this.log(`hello: ${(err as Error).message}`)
    }
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
        /*
         * This OpenCode is older than Autocode's minimum (the owner,
         * 2026-11-17): the reason is kept for the tools, and the hello is
         * tried again later (the server lists the host with it).
         */
        if (err instanceof ServerError && err.code === "opencode_too_old") {
          this.state = "unsupported"
          this.refused = err.message
          this.log(`refused: ${err.message}`)
          await this.sleep(this.options.unsupportedWaitMs ?? 600_000)
          continue
        }
        // any other failure: a refusal's reason is no longer the reason
        this.refused = undefined
        /*
         * The server refuses the consumer token: it was replaced (autocode
         * token rotate --consumer). The client config's token is read again,
         * so that a running OpenCode goes on without a restart once the
         * config has the new one.
         */
        if (err instanceof ServerError && err.status === 401) {
          const fresh = this.options.reloadToken?.()
          if (fresh && fresh !== this.token) {
            this.token = fresh
            this.log("the client config has a new consumer token: using it")
            backoff = min
            continue
          }
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
