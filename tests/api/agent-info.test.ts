/*
 * What an agent is told (tier 0b2): its status shows the server, its time and
 * zone, the delivery settings, its wakes and unread messages; each wake says
 * when it falls due next (an estimate for idle wakes); an idle wake counts
 * from the later of the session's idle start and the time it was set; an
 * injected wake states its trigger and next run in the server's zone; every
 * injection ends with a footer that says where it comes from; cancelling a
 * wake drops its runs that wait to be delivered.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ack,
  call,
  hello,
  instructions,
  registered,
  report,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

let t: TestServer
let a: string
let b: string
const HOST = "m:1"
const MIN = 60_000

const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)
const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)

async function tick(): Promise<any[]> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out.filter((i) => i.type !== "check"))
    await ack(t, HOST, i.id, { ok: true })
  return out.filter((i) => i.type === "inject")
}
const turnEnds = (session = "ses_a") =>
  report(t, HOST, [{ type: "turn.ended", session, outcome: "succeeded" }])

beforeEach(async () => {
  t = await testServer()
  await owner("PATCH", "/v1/settings", {
    server: { timezone: "America/Los_Angeles" },
  })
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  b = await registered(t, HOST, "ses_b", "team:b")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("status", () => {
  test("shows the server, its time and zone, the delivery settings, the wakes and unread messages", async () => {
    await as(a, "PUT", "/v1/me/wakes/later", {
      text: "Later.",
      trigger: "every 2h",
    })
    await as(a, "PUT", "/v1/me/wakes/sooner", {
      text: "Sooner.",
      trigger: "in 30m",
    })
    await owner("POST", "/v1/agents/team:a/pause")
    await as(b, "POST", "/v1/messages", { to: "team:a", text: "hi" })
    const me = (await as(a, "GET", "/v1/me")).body
    expect(me).toMatchObject({
      registered: true,
      agent: { id: "team:a", status: "paused", paused: "owner" },
      server: {
        id: "api-test",
        time: "2026-10-28T12:00:00.000Z",
        timezone: "America/Los_Angeles",
      },
      settings: { min_interval: "1m", inline_limit: 1024, max_tool_wait: "5m" },
      wakes: {
        count: 2,
        next: { name: "sooner", due: "2026-10-28T12:30:00.000Z" },
      },
      unread: 1,
    })
  })

  test("an unregistered session still learns the server and its time", async () => {
    const { sessionToken } = await import("../helpers/server.ts")
    const loose = await sessionToken(t, HOST, "ses_loose")
    const me = (await as(loose, "GET", "/v1/me")).body
    expect(me).toMatchObject({
      registered: false,
      server: { id: "api-test", timezone: "America/Los_Angeles" },
    })
  })
})

describe("when a wake falls due", () => {
  test("timed wakes: due is their next run; fire-only: none", async () => {
    const set = await as(a, "PUT", "/v1/me/wakes/w", {
      text: "Go.",
      trigger: "every 30m",
    })
    expect(set.body.wake.due).toBe("2026-10-28T12:30:00.000Z")
    const fire = await as(a, "PUT", "/v1/me/wakes/f", {
      text: "Go.",
      trigger: "fire-only",
    })
    expect(fire.body.wake.due).toBeNull()
  })

  test("an idle wake counts from when it was set, not from an earlier idle start", async () => {
    await turnEnds() // idle since 12:00
    t.clock.advance(120 * MIN) // 14:00: idle for two hours
    const set = await as(a, "PUT", "/v1/me/wakes/nudge", {
      text: "Anything to do?",
      trigger: "idle 30m",
    })
    // due 30 minutes from now, not at once
    expect(set.body.wake.due).toBe("2026-10-28T14:30:00.000Z")
    expect(await tick()).toEqual([])
    t.clock.advance(29 * MIN)
    expect(await tick()).toEqual([])
    t.clock.advance(MIN)
    expect((await tick()).length).toBe(1)
  })

  test("an idle wake's due: after the idle start when set before it; none while busy; repeat from its last run", async () => {
    await as(a, "PUT", "/v1/me/wakes/nudge", {
      text: "Anything to do?",
      trigger: "idle 10m repeat",
    })
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    const busy = (await as(a, "GET", "/v1/me/wakes")).body.wakes[0]
    expect(busy.due).toBeNull()
    t.clock.advance(5 * MIN)
    await turnEnds() // idle since 12:05
    const idle = (await as(a, "GET", "/v1/me/wakes")).body.wakes[0]
    expect(idle.due).toBe("2026-10-28T12:15:00.000Z")
    await owner("POST", "/v1/agents/team:a/pause")
    t.clock.advance(10 * MIN)
    t.server.tick() // falls due at 12:15 (paused: it waits)
    const again = (await as(a, "GET", "/v1/me/wakes")).body.wakes[0]
    expect(again.due).toBe("2026-10-28T12:25:00.000Z")
  })
})

describe("cancelling", () => {
  test("a cancelled wake's run that waits to be delivered is dropped", async () => {
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 10m" })
    await owner("POST", "/v1/agents/team:a/pause")
    t.clock.advance(10 * MIN)
    t.server.tick() // due, waiting while paused
    await as(a, "DELETE", "/v1/me/wakes/w")
    await owner("POST", "/v1/agents/team:a/resume")
    expect(await tick()).toEqual([])
  })
})

describe("what an injected prompt says", () => {
  test("a wake's section names its trigger and next run in the server's zone; a footer ends the prompt", async () => {
    await as(a, "PUT", "/v1/me/wakes/tick", {
      text: "Tick.",
      trigger: "every 30m",
      end: "2026-10-28T20:00:00Z",
    })
    t.clock.advance(30 * MIN)
    const [prompt] = await tick()
    const text: string = prompt.payload.text
    expect(text).toStartWith('[autocode] wake "tick"\n')
    // 12:30 UTC is 05:30 PDT; the next run 13:00 UTC, 06:00 PDT
    expect(text).toContain(
      'Wake "tick" (every 30m; next 2026-10-28 06:00 PDT; ' +
        "ends 2026-10-28 13:00 PDT):\nTick.",
    )
    const lines = text.split("\n")
    expect(lines.at(-1)).toBe(
      "— From Autocode, not the owner. Your wakes: autocode_wake list. " +
        "How Autocode works: autocode_me action=help.",
    )
  })

  test("one-shot, idle, fire-only and cron wakes say what they are", async () => {
    await owner("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
    const cases: [string, string, string][] = [
      ["once", "in 5m", "(once, this was its only run)"],
      ["fired", "fire-only", "(fire-only)"],
    ]
    for (const [name, trigger] of cases)
      await as(a, "PUT", `/v1/me/wakes/${name}`, { text: name, trigger })
    t.clock.advance(5 * MIN)
    await owner("POST", "/v1/agents/team:a/wakes/fired/fire")
    const [prompt] = await tick()
    for (const [name, , says] of cases)
      expect(prompt.payload.text).toContain(`Wake "${name}" ${says}:`)
    await turnEnds()
    await as(a, "PUT", "/v1/me/wakes/standup", {
      text: "Standup.",
      trigger: 'cron "0 9 * * 1-5"',
    })
    await owner("POST", "/v1/agents/team:a/wakes/standup/fire")
    t.clock.advance(MIN)
    const [cron] = await tick()
    expect(cron.payload.text).toContain(
      'Wake "standup" (cron "0 9 * * 1-5" America/Los_Angeles; ' +
        "next 2026-10-28 09:00 PDT):", // 12:06 UTC is 05:06 PDT
    )
    await turnEnds()
    await as(a, "PUT", "/v1/me/wakes/nudge", {
      text: "Nudge.",
      trigger: "idle 10m repeat",
    })
    t.clock.advance(10 * MIN)
    const [idle] = await tick()
    expect(idle.payload.text).toContain(
      'Wake "nudge" (idle 10m repeat; again after 10m more idle):',
    )
  })
})
