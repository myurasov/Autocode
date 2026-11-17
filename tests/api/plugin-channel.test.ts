/*
 * The plugin's channel against a real in-process server.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Channel, type ChannelOptions } from "../../plugin/src/channel.ts"
import { costEvent } from "../../plugin/src/costs.ts"
import {
  call,
  PRESET_CONSUMER,
  type TestServer,
  testServer,
} from "../helpers/server.ts"
import { until } from "../helpers/wait.ts"

const running: TestServer[] = []
const channels: Channel[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of channels.splice(0)) await c.stop()
  for (const t of running.splice(0)) await t.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function start(options: Parameters<typeof testServer>[0] = {}) {
  const t = await testServer(options)
  running.push(t)
  return t
}

function channel(url: string, overrides: Partial<ChannelOptions> = {}) {
  const c = new Channel({
    config: { url, consumer_token: PRESET_CONSUMER },
    host: "m:work:00000001",
    instance: "one",
    machine: "m",
    directory: "/work",
    opencodeVersion: "2.3.0",
    onInstruction: async () => ({ done: true }),
    backoffMs: { min: 50, max: 200 },
    supersededWaitMs: 200,
    ...overrides,
  })
  channels.push(c)
  c.start()
  return c
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port
      srv.close(() => resolve(port))
    })
  })
}

describe("plugin channel against the server", () => {
  test("it says hello and keeps polling; the server lists the host online", async () => {
    const t = await start({ pollWait: 1, offlineAfter: 3 })
    const c = channel(t.url)
    expect(await c.whenConnected(5000)).toBe(true)
    expect(c.serverId).toBe("api-test")
    // Past the offline time on the server's clock, only polls made since keep
    // the host online.
    t.clock.advance(10_000)
    await Bun.sleep(2500)
    t.server.maintenance()
    const hosts = (await call(t.url, t.admin, "GET", "/v1/hosts")).body.hosts
    expect(hosts).toEqual([
      expect.objectContaining({
        id: "m:work:00000001",
        machine: "m",
        online: true,
      }),
    ])
    // and a channel that stopped polling is seen offline the same way
    await c.stop()
    t.clock.advance(10_000)
    t.server.maintenance()
    expect(
      (await call(t.url, t.admin, "GET", "/v1/hosts")).body.hosts[0].online,
    ).toBe(false)
  })

  test("a plugin that expects another server ID never says hello there, so it leaves no trace", async () => {
    const t = await start({ pollWait: 1 })
    const c = channel(t.url, {
      config: {
        url: t.url,
        consumer_token: PRESET_CONSUMER,
        server_id: "someone-else",
      },
    })
    await until(() => c.state === "wrong_server", {
      timeoutMs: 5000,
      what: "the channel to refuse the server",
    })
    await Bun.sleep(300)
    const hosts = (await call(t.url, t.admin, "GET", "/v1/hosts")).body.hosts
    const online = (
      await call(t.url, t.admin, "GET", "/v1/history?kind=host.online")
    ).body.history
    expect({ hosts: hosts.length, online: online.length }).toEqual({
      hosts: 0,
      online: 0,
    })
  })

  test("the backoff starts over only after a poll succeeds, not after any hello", async () => {
    let hellos = 0
    const flaky = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname
        if (path.endsWith("/hello")) {
          hellos++
          return Response.json({
            server: { id: "flaky" },
            poll: { wait: 1 },
            sessions: [],
          })
        }
        return Response.json(
          { error: { code: "broken", message: "polls fail" } },
          { status: 500 },
        )
      },
    })
    try {
      channel(`http://127.0.0.1:${flaky.port}`, {
        backoffMs: { min: 50, max: 400 },
      })
      await Bun.sleep(1500)
      // 50 + 100 + 200 + 400 + 400 ms: about 5 hellos; a backoff reset at each
      // hello would make about 25
      expect(hellos).toBeGreaterThanOrEqual(3)
      expect(hellos).toBeLessThanOrEqual(8)
    } finally {
      flaky.stop(true)
    }
  })

  test("a long instruction does not stop the polls, and one that comes again while it runs is run once", async () => {
    const t = await start({ pollWait: 1 })
    const runs: string[] = []
    let release: () => void = () => {}
    const c = channel(t.url, {
      onInstruction: async (i) => {
        runs.push(i.type)
        if (i.type === "slow")
          await new Promise<void>((resolve) => (release = resolve))
        return { done: i.type }
      },
    })
    await c.whenConnected(5000)
    const slow = t.server.enqueue("m:work:00000001", "slow", {})
    await until(() => runs.includes("slow"), {
      what: "the slow instruction to start",
    })
    // the server sends an unacknowledged instruction again after 30 s
    t.clock.advance(31_000)
    const quick = t.server.enqueue("m:work:00000001", "quick", {})
    await until(() => t.server.instruction(quick)?.acked, {
      timeoutMs: 5000,
      what: "the quick one, while slow runs",
    })
    await Bun.sleep(1500)
    release()
    await until(() => t.server.instruction(slow)?.acked, {
      what: "the slow one",
    })
    expect(runs).toEqual(["slow", "quick"])
  })

  test("instructions are handled and acknowledged with their result", async () => {
    const t = await start({ pollWait: 1 })
    const seen: string[] = []
    const c = channel(t.url, {
      onInstruction: async (i) => {
        seen.push(i.type)
        if (i.type === "bad") throw new Error("cannot")
        return { echoed: i.payload }
      },
    })
    await c.whenConnected(5000)
    const good = t.server.enqueue("m:work:00000001", "echo", { x: 1 })
    const bad = t.server.enqueue("m:work:00000001", "bad", {})
    await until(
      () =>
        t.server.instruction(good)?.acked && t.server.instruction(bad)?.acked,
      { what: "both acks" },
    )
    expect(t.server.instruction(good)?.result).toEqual({ echoed: { x: 1 } })
    expect(seen).toEqual(["echo", "bad"])
  })

  // The owner, 2026-11-17: OpenCode 2.3.0 is the minimum.
  test("an OpenCode older than the minimum: the server refuses it, the channel keeps the reason and asks again later", async () => {
    const t = await start()
    const lines: string[] = []
    const c = channel(t.url, {
      opencodeVersion: "2.2.0",
      unsupportedWaitMs: 150,
      log: (line) => lines.push(line),
    })
    await until(() => c.state === "unsupported", {
      timeoutMs: 5000,
      what: "the channel to be refused",
    })
    expect(c.refused).toBe(
      "this OpenCode is v2.2.0; Autocode needs v2.3.0 or later. " +
        "Update OpenCode on this machine, then start it again.",
    )
    expect(c.reachable).toBe(false)
    expect(await c.whenConnected(100)).toBe(false)
    // it asks again (an updated OpenCode starts a new plugin anyway)
    await until(
      () => lines.filter((l) => l.startsWith("refused: ")).length >= 2,
      { timeoutMs: 5000, what: "a second hello" },
    )
    expect(c.state).toBe("unsupported")
  })

  test("a server with another ID than the config expects is refused", async () => {
    const t = await start()
    const c = channel(t.url, {
      config: {
        url: t.url,
        consumer_token: PRESET_CONSUMER,
        server_id: "someone-else",
      },
    })
    expect(await c.whenConnected(500)).toBe(false)
    expect(c.state).toBe("wrong_server")
  })

  test("it waits for a server that is down and connects when it comes up", async () => {
    const port = await freePort()
    const dataDir = mkdtempSync(join(tmpdir(), "autocode-chan-"))
    dirs.push(dataDir)
    const c = channel(`http://127.0.0.1:${port}`)
    await Bun.sleep(300)
    expect(c.state).toBe("backoff")
    const { startServer } = await import("@autocode/server")
    const server = await startServer({
      dataDir,
      id: "late",
      listen: [`127.0.0.1:${port}`],
      pollWait: 1,
      maintenanceEvery: 0,
      presetTokens: {
        consumer: PRESET_CONSUMER,
        admin: "aca_test_admin_token_0000000000000000000000",
      },
      log: () => {},
    })
    try {
      expect(await c.whenConnected(5000)).toBe(true)
      expect(c.serverId).toBe("late")
    } finally {
      await c.stop()
      await server.stop()
    }
  })

  /*
   * The adversarial review before 1.0.0 (2026-11-17): after a long outage the
   * waiting events were sent as one request, past the server's 2 MiB limit,
   * so nothing was ever sent again (no turn events, no costs, no
   * acknowledgements) until OpenCode restarted.
   */
  test("after a long outage the backlog goes out in batches; instructions are acknowledged again", async () => {
    const port = await freePort()
    const dataDir = mkdtempSync(join(tmpdir(), "autocode-chan-"))
    dirs.push(dataDir)
    const c = channel(`http://127.0.0.1:${port}`)
    await Bun.sleep(300)
    expect(c.state).toBe("backoff")
    // the server is down; this host's agents go on working: a cost event for
    // each model step, and the sessions that run a turn each minute (of
    // which only the newest is worth keeping)
    for (let i = 0; i < 14_000; i++)
      c.report(
        costEvent(
          "ses_0123456789abcdefghijklmnop",
          {
            cost: 0.0123,
            tokens: { input: 1000, cache: { read: 90_000, write: 500 } },
            assistantMessageID: `msg_${String(i).padStart(26, "0")}`,
          },
          {
            model: "anthropic/claude-fable-5-2",
            limit: 1_000_000,
            effort: "high",
          },
        ),
      )
    for (let i = 0; i < 100; i++)
      c.report({ type: "turns.active", sessions: [`ses_${i}`] })
    const waiting = (c as any).outbox as any[]
    expect(waiting.filter((e) => e.type === "turns.active")).toEqual([
      { type: "turns.active", sessions: ["ses_99"] },
    ])
    expect(JSON.stringify(waiting).length).toBeGreaterThan(2 * 1024 * 1024)
    const { startServer } = await import("@autocode/server")
    const server = await startServer({
      dataDir,
      id: "late",
      listen: [`127.0.0.1:${port}`],
      pollWait: 1,
      maintenanceEvery: 0,
      presetTokens: {
        consumer: PRESET_CONSUMER,
        admin: "aca_test_admin_token_0000000000000000000000",
      },
      log: () => {},
    })
    try {
      expect(await c.whenConnected(5000)).toBe(true)
      const id = server.enqueue("m:work:00000001", "ping", {})
      await until(() => server.instruction(id)?.acked, {
        timeoutMs: 15_000,
        what: "the instruction's acknowledgement",
      })
      await until(() => ((c as any).outbox as unknown[]).length === 0, {
        timeoutMs: 15_000,
        what: "the backlog to go out",
      })
    } finally {
      await c.stop()
      await server.stop()
    }
  }, 40_000)

  // The review before 1.0.0: after a refusal the reason stayed when the
  // server then went away, so tools gave the version for an outage.
  test("a refusal's reason goes when the server is then unreachable or accepts it", async () => {
    let mode: "old" | "down" | "ok" = "old"
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const url = new URL(req.url)
        if (url.pathname.endsWith("/hello")) {
          if (mode === "old")
            return Response.json(
              {
                error: {
                  code: "opencode_too_old",
                  message: "this OpenCode is v2.2.0; too old.",
                },
              },
              { status: 426 },
            )
          if (mode === "down") return new Response("oops", { status: 502 })
          return Response.json({ server: { id: "s" }, poll: { wait: 1 } })
        }
        if (url.pathname.endsWith("/next")) {
          await Bun.sleep(200)
          return Response.json({ instructions: [] })
        }
        return Response.json({ ok: true })
      },
    })
    try {
      const c = channel(`http://127.0.0.1:${srv.port}`, {
        unsupportedWaitMs: 100,
      })
      await until(() => c.state === "unsupported", {
        timeoutMs: 3000,
        what: "the refusal",
      })
      expect(c.refused).toBe("this OpenCode is v2.2.0; too old.")
      mode = "down"
      await until(() => c.state === "backoff", {
        timeoutMs: 3000,
        what: "the outage",
      })
      expect(c.refused).toBeUndefined()
      mode = "ok"
      expect(await c.whenConnected(3000)).toBe(true)
      expect(c.refused).toBeUndefined()
    } finally {
      srv.stop(true)
    }
  })

  /*
   * The review before 1.0.0: a running plugin read the client config once,
   * so after `autocode token rotate --consumer` it tried the dead token for
   * good, and every OpenCode had to be restarted. It now reads the config's
   * consumer token again when the server refuses its own.
   */
  test("a replaced consumer token is picked up from the client config, without a restart", async () => {
    const t = await start({ pollWait: 1 })
    let onDisk = PRESET_CONSUMER
    // told once, when it takes the new token: every session token is dead
    // with the old one, so the plugin forgets them
    let replaced = 0
    const c = channel(t.url, {
      reloadToken: () => onDisk,
      onTokenReplaced: () => replaced++,
    })
    expect(await c.whenConnected(5000)).toBe(true)
    const rot = await call(t.url, t.admin, "POST", "/v1/tokens/consumer/rotate")
    expect(rot.status).toBe(200)
    await until(() => c.state !== "connected", {
      timeoutMs: 5000,
      what: "the channel to be refused with the old token",
    })
    // `autocode plugin install` (or the rotation itself, on this machine)
    // wrote the new token to the client config
    onDisk = rot.body.token
    expect(replaced).toBe(0)
    expect(await c.whenConnected(5000)).toBe(true)
    expect(c.consumerToken).toBe(rot.body.token)
    expect(replaced).toBe(1)
    const hosts = (await call(t.url, t.admin, "GET", "/v1/hosts")).body.hosts
    expect(hosts[0]).toMatchObject({ id: "m:work:00000001", online: true })
  })

  test("a server restart is survived: the channel reconnects to the same host record", async () => {
    const port = await freePort()
    const dataDir = mkdtempSync(join(tmpdir(), "autocode-chan-"))
    dirs.push(dataDir)
    const { startServer } = await import("@autocode/server")
    const opts = {
      dataDir,
      id: "srv",
      listen: [`127.0.0.1:${port}`],
      pollWait: 1,
      maintenanceEvery: 0,
      presetTokens: {
        consumer: PRESET_CONSUMER,
        admin: "aca_test_admin_token_0000000000000000000000",
      },
      log: () => {},
    }
    let server = await startServer(opts)
    const c = channel(`http://127.0.0.1:${port}`)
    await c.whenConnected(5000)
    await server.stop()
    await until(() => c.state === "backoff", { what: "the channel to notice" })
    server = await startServer(opts)
    try {
      await until(() => c.state === "connected", {
        timeoutMs: 5000,
        what: "reconnection",
      })
      const hosts = (
        await call(
          `http://127.0.0.1:${port}`,
          opts.presetTokens.admin,
          "GET",
          "/v1/hosts",
        )
      ).body.hosts
      expect(hosts.length).toBe(1)
      expect(hosts[0].online).toBe(true)
    } finally {
      await c.stop()
      await server.stop()
    }
  })

  test("sessions the server knows but OpenCode no longer has are reported gone at hello", async () => {
    const t = await start({ pollWait: 1 })
    await call(t.url, t.consumer, "POST", "/v1/hosts/m:work:00000001/hello", {
      instance: "zero",
      directory: "/work",
    })
    for (const s of ["ses_alive", "ses_gone"])
      await call(
        t.url,
        t.consumer,
        "POST",
        `/v1/hosts/m:work:00000001/sessions/${s}/token`,
        {},
      )
    const c = channel(t.url, {
      goneSessions: async (list) => list.filter((s) => s === "ses_gone"),
    })
    await c.whenConnected(5000)
    await until(
      async () => {
        const kinds = (
          await call(t.url, t.admin, "GET", "/v1/history?kind=session.deleted")
        ).body.history
        return kinds.length === 1 && kinds[0].session === "ses_gone"
      },
      { what: "the gone session to be recorded" },
    )
  })

  test("a newer instance of the same host makes the older one wait, without taking turns", async () => {
    const t = await start({ pollWait: 1 })
    const old = channel(t.url, { instance: "old" })
    await old.whenConnected(5000)
    const fresh = channel(t.url, { instance: "new" })
    await fresh.whenConnected(5000)
    await until(() => old.state === "superseded", {
      timeoutMs: 5000,
      what: "the old instance to step back",
    })
    await Bun.sleep(1500)
    expect(old.state).toBe("superseded")
    expect(fresh.state).toBe("connected")
  })

  test("a superseded instance takes the host back once the newer one is gone", async () => {
    const t = await start({ pollWait: 1 })
    const old = channel(t.url, { instance: "old" })
    await old.whenConnected(5000)
    const fresh = channel(t.url, { instance: "new" })
    await fresh.whenConnected(5000)
    await until(() => old.state === "superseded", {
      timeoutMs: 5000,
      what: "the old instance to step back",
    })
    await fresh.stop()
    await until(() => old.state === "connected", {
      timeoutMs: 5000,
      what: "the old instance to take over",
    })
  })
})
