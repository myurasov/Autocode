/*
 * The plugin's channel against a real in-process server.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Channel,
  type ChannelOptions,
} from "../../packages/plugin/src/channel.ts"
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
    opencodeVersion: "2.2.0",
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
