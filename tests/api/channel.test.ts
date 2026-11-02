/*
 * The server's side of the plugin channel: hello, long polls that return queued
 * instructions until acknowledged, events, a newer instance of a host
 * superseding the older one, and a host going offline and online again.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { VERSION } from "@autocode/shared"
import {
  call,
  hello,
  sessionToken,
  type TestServer,
  testServer,
} from "../helpers/server.ts"
import { until } from "../helpers/wait.ts"

const running: TestServer[] = []
afterEach(async () => {
  for (const t of running.splice(0)) await t.stop()
})

async function start(options: Parameters<typeof testServer>[0] = {}) {
  const t = await testServer(options)
  running.push(t)
  return t
}

const next = (
  t: TestServer,
  host: string,
  wait = 1,
  instance = `inst-${host}`,
) =>
  call(
    t.url,
    t.consumer,
    "GET",
    `/v1/hosts/${encodeURIComponent(host)}/next` +
      `?wait=${wait}&instance=${instance}`,
  )

const events = (
  t: TestServer,
  host: string,
  list: unknown[],
  instance = `inst-${host}`,
) =>
  call(
    t.url,
    t.consumer,
    "POST",
    `/v1/hosts/${encodeURIComponent(host)}/events`,
    { instance, events: list },
  )

describe("plugin channel", () => {
  test("hello records the host as online and tells the plugin the server, its poll wait and its sessions", async () => {
    const t = await start({ pollWait: 2 })
    const res = await hello(t, "m1:work:abc123")
    expect(res.status).toBe(200)
    expect(res.body.server).toEqual({ id: "api-test", version: VERSION })
    expect(res.body.poll.wait).toBe(2)
    expect(res.body.sessions).toEqual([])
    await sessionToken(t, "m1:work:abc123", "ses_a")
    const again = await hello(t, "m1:work:abc123")
    expect(again.body.sessions).toEqual(["ses_a"])
    const hosts = await call(t.url, t.admin, "GET", "/v1/hosts")
    expect(hosts.body.hosts).toEqual([
      expect.objectContaining({
        id: "m1:work:abc123",
        machine: "m1",
        directory: "/work",
        online: true,
        opencode_version: "2.2.0",
      }),
    ])
  })

  test("hello records the host's OpenCode process (kind and ID) and whether it can set shell values; a missing or bad one is left empty", async () => {
    const t = await start()
    await hello(t, "m:svc", {
      process: { pid: 4242, kind: "service" },
      shell_values: true,
    })
    await hello(t, "m:solo", {
      process: { pid: 7, kind: "standalone" },
      shell_values: false,
    })
    await hello(t, "m:old")
    await hello(t, "m:bad", {
      process: { pid: -1, kind: "no such kind!" },
      shell_values: "yes",
    })
    const hosts = (await call(t.url, t.admin, "GET", "/v1/hosts")).body.hosts
    const of = (id: string) => hosts.find((h: any) => h.id === id)
    expect(of("m:svc")).toMatchObject({
      process_kind: "service",
      process_pid: 4242,
      shell_values: true,
    })
    expect(of("m:solo")).toMatchObject({
      process_kind: "standalone",
      shell_values: false,
    })
    // a plugin from before (or a bad value): not known
    expect(of("m:old")).toMatchObject({
      process_kind: "",
      process_pid: null,
      shell_values: null,
    })
    expect(of("m:bad")).toMatchObject({
      process_kind: "",
      process_pid: null,
      shell_values: null,
    })
  })

  test("hello and session.created events report the sessions the plugin sees, so the owner can bind an ID at once", async () => {
    const t = await start()
    const res = await hello(t, "m:1", {
      sessions: [{ id: "ses_seen", directory: "/work/a" }],
    })
    expect(res.status).toBe(200)
    expect(res.body.sessions).toEqual(["ses_seen"])
    const bound = await call(t.url, t.admin, "POST", "/v1/agents", {
      id: "a:seen",
      session: "ses_seen",
    })
    expect(bound.status).toBe(201)
    expect(bound.body.agent).toMatchObject({
      session: "ses_seen",
      host: "m:1",
      directory: "/work/a",
    })
    await events(t, "m:1", [
      { type: "session.created", session: "ses_new", directory: "/work/b" },
    ])
    expect(
      (
        await call(t.url, t.admin, "POST", "/v1/agents", {
          id: "a:new",
          session: "ses_new",
        })
      ).status,
    ).toBe(201)
    // a session the server knows is gone stays gone, even if a later hello
    // lists it
    await events(t, "m:1", [{ type: "session.deleted", session: "ses_seen" }])
    await hello(t, "m:1", { sessions: [{ id: "ses_seen" }] })
    expect(
      (
        await call(
          t.url,
          t.consumer,
          "POST",
          "/v1/hosts/m:1/sessions/ses_seen/token",
          {},
        )
      ).status,
    ).toBe(410)
    // a list that is not one is refused; a bad entry is skipped, so it cannot
    // stop the plugin's hellos for good
    expect((await hello(t, "m:1", { sessions: "ses_x" })).status).toBe(400)
    const mixed = await hello(t, "m:1", {
      sessions: [{ id: "bad id" }, { id: "ses_ok", directory: "" }, "ses_fine"],
    })
    expect(mixed.status).toBe(200)
    expect(mixed.body.sessions).toContain("ses_fine")
    expect(mixed.body.sessions).not.toContain("ses_ok")
  })

  test("hello checks the host ID and its fields", async () => {
    const t = await start()
    expect(
      (
        await call(t.url, t.consumer, "POST", "/v1/hosts/bad%20host/hello", {
          instance: "i",
        })
      ).status,
    ).toBe(400)
    expect(
      (await call(t.url, t.consumer, "POST", "/v1/hosts/m:1/hello", {})).status,
    ).toBe(400)
  })

  test("next waits the whole poll when nothing is queued, and answers an empty list", async () => {
    const t = await start()
    await hello(t, "m:1")
    const started = Date.now()
    const res = await next(t, "m:1", 1)
    expect(res.status).toBe(200)
    expect(res.body.instructions).toEqual([])
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  test("next returns at once when an instruction is queued during the wait", async () => {
    const t = await start()
    await hello(t, "m:1")
    const started = Date.now()
    const waiting = next(t, "m:1", 5)
    await Bun.sleep(200)
    t.server.enqueue("m:1", "ping", { n: 1 })
    const res = await waiting
    expect(Date.now() - started).toBeLessThan(3000)
    expect(res.body.instructions).toEqual([
      expect.objectContaining({ type: "ping", payload: { n: 1 } }),
    ])
    expect(res.body.instructions[0].id).toMatch(/^in_/)
  })

  test("an instruction comes again until it is acknowledged, then never again", async () => {
    const t = await start()
    await hello(t, "m:1")
    const id = t.server.enqueue("m:1", "ping", {})
    expect(
      (await next(t, "m:1")).body.instructions.map((i: any) => i.id),
    ).toEqual([id])
    t.clock.advance(31_000)
    expect(
      (await next(t, "m:1")).body.instructions.map((i: any) => i.id),
    ).toEqual([id])
    expect(
      (
        await events(t, "m:1", [
          { type: "ack", id, ok: true, result: { pong: true } },
        ])
      ).status,
    ).toBe(200)
    t.clock.advance(31_000)
    expect((await next(t, "m:1", 1)).body.instructions).toEqual([])
    expect(t.server.instruction(id)).toMatchObject({
      acked: true,
      result: { pong: true },
    })
  })

  test("a newer instance of the same host supersedes the older one, whose polls are refused", async () => {
    const t = await start()
    await hello(t, "m:1", { instance: "old" })
    await hello(t, "m:1", { instance: "new" })
    const res = await next(t, "m:1", 1, "old")
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("superseded")
    expect((await next(t, "m:1", 1, "new")).status).toBe(200)
  })

  test("a hello without takeover is refused while the current instance is polling", async () => {
    const t = await start({ takeoverGraceMs: 3000 })
    await hello(t, "m:1", { instance: "current" })
    const polling = next(t, "m:1", 2, "current")
    await Bun.sleep(100)
    const res = await hello(t, "m:1", { instance: "older", takeover: false })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("host_busy")
    await polling
    const ended = Date.now()
    // the gap between two polls still counts as in use
    expect(
      (await hello(t, "m:1", { instance: "older", takeover: false })).status,
    ).toBe(409)
    await until(
      async () =>
        (await hello(t, "m:1", { instance: "older", takeover: false }))
          .status === 200,
      {
        timeoutMs: 15_000,
        intervalMs: 250,
        what: "the host to be free",
      },
    )
    expect(Date.now() - ended).toBeGreaterThanOrEqual(2900)
  })

  test("polls from a host that never said hello are refused", async () => {
    const t = await start()
    expect((await next(t, "m:404")).status).toBe(404)
  })

  test("a host that stops polling is marked offline after the offline time, and online again at its next poll", async () => {
    const t = await start({ offlineAfter: 3 })
    await hello(t, "m:1")
    t.clock.advance(2_000)
    t.server.maintenance()
    expect(
      (await call(t.url, t.admin, "GET", "/v1/hosts")).body.hosts[0].online,
    ).toBe(true)
    t.clock.advance(2_000)
    t.server.maintenance()
    expect(
      (await call(t.url, t.admin, "GET", "/v1/hosts")).body.hosts[0].online,
    ).toBe(false)
    await next(t, "m:1", 1)
    expect(
      (await call(t.url, t.admin, "GET", "/v1/hosts")).body.hosts[0].online,
    ).toBe(true)
    const kinds = (
      await call(t.url, t.admin, "GET", "/v1/history?limit=50")
    ).body.history.map((h: any) => h.kind)
    expect(kinds.filter((k: string) => k === "host.offline").length).toBe(1)
    expect(kinds.filter((k: string) => k === "host.online").length).toBe(2)
  })

  test("a host in the middle of a long poll stays online", async () => {
    const t = await start({ offlineAfter: 3 })
    await hello(t, "m:1")
    const waiting = next(t, "m:1", 2)
    await Bun.sleep(100)
    t.clock.advance(10_000)
    t.server.maintenance()
    expect(
      (await call(t.url, t.admin, "GET", "/v1/hosts")).body.hosts[0].online,
    ).toBe(true)
    await waiting
  })

  test("a deleted session is reported in events and recorded", async () => {
    const t = await start()
    await hello(t, "m:1")
    await sessionToken(t, "m:1", "ses_gone")
    expect(
      (
        await events(t, "m:1", [
          { type: "session.deleted", session: "ses_gone" },
        ])
      ).status,
    ).toBe(200)
    expect((await hello(t, "m:1")).body.sessions).toEqual([])
    const kinds = (
      await call(t.url, t.admin, "GET", "/v1/history")
    ).body.history.map((h: any) => h.kind)
    expect(kinds).toContain("session.deleted")
  })

  test("unknown event types are ignored, and a bad events body is refused", async () => {
    const t = await start()
    await hello(t, "m:1")
    expect((await events(t, "m:1", [{ type: "future.thing" }])).status).toBe(
      200,
    )
    expect(
      (
        await call(t.url, t.consumer, "POST", "/v1/hosts/m:1/events", {
          events: "no",
        })
      ).status,
    ).toBe(400)
  })
})
