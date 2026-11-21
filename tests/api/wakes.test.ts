/*
 * Wakes (spec, Wakes): an agent's own wakes and the owner's, triggers that fall
 * due on the fake clock, firing, checks run by the plugin, idle wakes, and the
 * injection that delivers them: one at a time per min_interval, only while the
 * session is idle and the agent not paused, merged by name or text, with the
 * [autocode] header.
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
let a: string // team:a on ses_a
let b: string // team:b on ses_b
const HOST = "m:1"
const MIN = 60_000

const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)
const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)

// The plugin's view: the instructions waiting now, by type.
async function waiting(type?: string): Promise<any[]> {
  const all = await instructions(t, HOST)
  return type ? all.filter((i) => i.type === type) : all
}

// Ticks the scheduler and returns the prompts it handed to the plugin.
async function tick(): Promise<any[]> {
  t.server.tick()
  const out = await waiting()
  for (const i of out.filter((i) => i.type !== "check"))
    await ack(t, HOST, i.id, { ok: true })
  return out.filter((i) => i.type === "inject")
}

// The injected turn runs and ends, as the plugin reports it.
async function turn(session = "ses_a") {
  await report(t, HOST, [{ type: "turn.started", session }])
  await report(t, HOST, [{ type: "turn.ended", session, outcome: "succeeded" }])
}

beforeEach(async () => {
  t = await testServer()
  await owner("PATCH", "/v1/settings", { server: { timezone: "UTC" } })
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  b = await registered(t, HOST, "ses_b", "team:b")
  // the registration notices
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("setting wakes", () => {
  test("an agent sets, lists, replaces and cancels its own wakes", async () => {
    const set = await as(a, "PUT", "/v1/me/wakes/daily-check", {
      text: "Check the queue.",
      trigger: "every 30m",
    })
    expect(set.status).toBe(201)
    expect(set.body.wake).toMatchObject({
      agent: "team:a",
      name: "daily-check",
      text: "Check the queue.",
      trigger: "every 30m",
      check: null,
      next: "2026-10-28T12:30:00.000Z",
      set_by: "team:a",
    })
    const again = await as(a, "PUT", "/v1/me/wakes/daily-check", {
      text: "Check the queue again.",
      trigger: 'cron "0 9 * * 1-5"',
    })
    expect(again.status).toBe(200)
    expect(again.body.wake.trigger).toBe('cron "0 9 * * 1-5" UTC')
    expect(again.body.wake.next).toBe("2026-10-29T09:00:00.000Z")
    const list = await as(a, "GET", "/v1/me/wakes")
    expect(list.body.wakes.map((w: any) => w.name)).toEqual(["daily-check"])
    expect((await as(a, "DELETE", "/v1/me/wakes/daily-check")).status).toBe(200)
    expect((await as(a, "GET", "/v1/me/wakes")).body.wakes).toEqual([])
    expect((await as(a, "DELETE", "/v1/me/wakes/daily-check")).status).toBe(404)
  })

  // The review of 0b2: a refused trigger leaves nothing behind.
  test("a trigger too long is refused and leaves no wake; list and /v1/me stay 200", async () => {
    for (const trigger of [
      "every 20000000w",
      "in 20000000w",
      "idle 20000000w",
    ]) {
      const res = await as(a, "PUT", "/v1/me/wakes/huge", {
        text: "x",
        trigger,
      })
      expect(res.status, trigger).toBe(400)
      expect(res.body.error.code, trigger).toBe("bad_trigger")
    }
    const list = await as(a, "GET", "/v1/me/wakes")
    expect(list.status).toBe(200)
    expect(list.body.wakes).toEqual([])
    expect((await as(a, "GET", "/v1/me")).status).toBe(200)
    expect((await owner("GET", "/v1/wakes")).status).toBe(200)
  })

  test("refuses a bad trigger, name or text, and says why", async () => {
    const cases: [unknown, string][] = [
      [{ text: "x", trigger: "sometimes" }, "bad_trigger"],
      [{ text: "", trigger: "every 1m" }, "bad_request"],
      [{ text: "x".repeat(32_001), trigger: "every 1m" }, "bad_request"],
      [{ text: "x", trigger: "every 1m", check: 5 }, "bad_request"],
    ]
    for (const [body, code] of cases) {
      const res = await as(a, "PUT", "/v1/me/wakes/w", body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe(code)
    }
    const name = await as(a, "PUT", "/v1/me/wakes/bad%20name", {
      text: "x",
      trigger: "every 1m",
    })
    expect(name.status).toBe(400)
  })

  test("an unregistered session has no wakes to set", async () => {
    const { sessionToken } = await import("../helpers/server.ts")
    const loose = await sessionToken(t, HOST, "ses_loose")
    const res = await as(loose, "PUT", "/v1/me/wakes/w", {
      text: "x",
      trigger: "every 1m",
    })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("not_registered")
  })

  test("the owner sets and cancels any agent's wakes and lists them all", async () => {
    const res = await owner("PUT", "/v1/agents/team:b/wakes/nudge", {
      text: "Nudge.",
      trigger: "idle 10m",
    })
    expect(res.status).toBe(201)
    expect(res.body.wake).toMatchObject({ set_by: "owner", next: null })
    await as(a, "PUT", "/v1/me/wakes/mine", { text: "x", trigger: "fire-only" })
    const all = await owner("GET", "/v1/wakes")
    expect(all.body.wakes.map((w: any) => `${w.agent}/${w.name}`)).toEqual([
      "team:a/mine",
      "team:b/nudge",
    ])
    expect(
      (await owner("GET", "/v1/agents/team:b/wakes")).body.wakes.length,
    ).toBe(1)
    expect(
      (await owner("DELETE", "/v1/agents/team:b/wakes/nudge")).status,
    ).toBe(200)
    // an agent cannot use the owner's routes
    expect(
      (
        await as(a, "PUT", "/v1/agents/team:b/wakes/x", {
          text: "x",
          trigger: "fire-only",
        })
      ).status,
    ).toBe(403)
  })

  test("unregistering removes the agent's wakes", async () => {
    await as(a, "PUT", "/v1/me/wakes/w", { text: "x", trigger: "every 1h" })
    await as(a, "DELETE", "/v1/me")
    expect((await owner("GET", "/v1/wakes")).body.wakes).toEqual([])
  })
})

describe("delivery", () => {
  test("a due wake is injected with the [autocode] header and its text", async () => {
    await as(a, "PUT", "/v1/me/wakes/daily-check", {
      text: "Check the queue.",
      trigger: "every 30m",
    })
    t.clock.advance(29 * MIN)
    expect(await tick()).toEqual([])
    t.clock.advance(MIN)
    const [inject, ...more] = await tick()
    expect(more).toEqual([])
    expect(inject.payload.session).toBe("ses_a")
    expect(inject.payload.prompt_id).toMatch(/^msg_/)
    expect(inject.payload.text).toStartWith('[autocode] wake "daily-check"\n')
    expect(inject.payload.text).toContain("Check the queue.")
    const wake = (await as(a, "GET", "/v1/me/wakes")).body.wakes[0]
    expect(wake.next).toBe("2026-10-28T13:00:00.000Z")
    expect(wake.last_fired_at).toBe("2026-10-28T12:30:00.000Z")
  })

  test("nothing is injected while the session is busy; it comes once the turn ends", async () => {
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 10m" })
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    t.clock.advance(10 * MIN)
    expect(await tick()).toEqual([])
    expect((await owner("GET", "/v1/agents/team:a")).body.agent.status).toBe(
      "working",
    )
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    expect((await tick()).length).toBe(1)
  })

  test("at most one injection per min_interval; what waits goes into one prompt", async () => {
    await owner("PATCH", "/v1/settings", { server: { min_interval: "5m" } })
    await as(a, "PUT", "/v1/me/wakes/one", {
      text: "One.",
      trigger: "every 1m",
    })
    t.clock.advance(MIN)
    expect((await tick()).length).toBe(1)
    await turn()
    await as(a, "PUT", "/v1/me/wakes/two", {
      text: "Two.",
      trigger: "every 2m",
    })
    for (let i = 0; i < 4; i++) {
      t.clock.advance(MIN)
      expect(await tick()).toEqual([])
    }
    t.clock.advance(MIN) // 5 minutes after the first injection
    const [prompt] = await tick()
    expect(prompt.payload.text).toStartWith('[autocode] wake "one", wake "two"')
    expect(prompt.payload.text).toContain("One.")
    expect(prompt.payload.text).toContain("Two.")
  })

  // The owner, 2026-11-07: waiting wakes merge by name only.
  test("waiting runs of one wake merge into the newest; wakes with the same text do not", async () => {
    await as(a, "PUT", "/v1/me/wakes/tick", {
      text: "Tick.",
      trigger: "every 1m",
    })
    await as(a, "PUT", "/v1/me/wakes/tock", {
      text: "Tick.",
      trigger: "every 1m",
    })
    await owner("POST", "/v1/agents/team:a/pause")
    for (let i = 0; i < 3; i++) {
      t.clock.advance(MIN)
      t.server.tick()
    }
    await owner("POST", "/v1/agents/team:a/resume")
    const [prompt] = await tick()
    expect(prompt.payload.text).toStartWith(
      '[autocode] wake "tick", wake "tock"',
    )
    expect(prompt.payload.text.match(/Tick\./g)?.length).toBe(2)
    const merged = await owner("GET", "/v1/history?kind=wake.merged")
    expect(merged.body.history.length).toBeGreaterThan(0)
  })

  test("a paused agent gets nothing; after resume it gets what waited", async () => {
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 1m" })
    const paused = await owner("POST", "/v1/agents/team:a/pause")
    expect(paused.body.agent).toMatchObject({
      status: "paused",
      paused: "owner",
    })
    t.clock.advance(2 * MIN)
    expect(await tick()).toEqual([])
    const resumed = await owner("POST", "/v1/agents/team:a/resume")
    expect(resumed.body.agent.status).toBe("idle")
    expect((await tick()).length).toBe(1)
  })

  test("an at wake runs once and is then gone", async () => {
    await as(a, "PUT", "/v1/me/wakes/once", {
      text: "Once.",
      trigger: "at 2026-10-28T12:05:00Z",
    })
    t.clock.advance(5 * MIN)
    expect((await tick()).length).toBe(1)
    expect((await as(a, "GET", "/v1/me/wakes")).body.wakes).toEqual([])
  })

  // The owner, 2026-11-07: a wake has no end date; cancel it instead.
  test("a wake takes no end date", async () => {
    const res = await as(a, "PUT", "/v1/me/wakes/w", {
      text: "Go.",
      trigger: "every 10m",
      end: "2026-10-28T12:05:00Z",
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain("unknown field end")
  })

  test("nothing goes to a host that is offline", async () => {
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 1m" })
    t.clock.advance(10 * MIN)
    t.server.maintenance() // the host has not polled for 10 minutes
    t.server.tick()
    expect(await waiting("inject")).toEqual([])
    await hello(t, HOST)
    expect((await tick()).length).toBe(1)
  })
})

describe("firing", () => {
  test("another agent fires a wake: the prompt names it and marks its text", async () => {
    await as(a, "PUT", "/v1/me/wakes/build", {
      text: "Build it.",
      trigger: "fire-only",
      check: "exit 1",
    })
    const fired = await as(b, "POST", "/v1/agents/team:a/wakes/build/fire", {
      text: "The data is ready.",
    })
    expect(fired.status).toBe(200)
    // a fired wake skips its check
    const [prompt] = await tick()
    expect(prompt.payload.text).toStartWith(
      '[autocode] wake "build" fired by team:b\n',
    )
    expect(prompt.payload.text).toContain("Build it.")
    expect(prompt.payload.text).toContain(
      "Added by agent team:b:\n> The data is ready.",
    )
  })

  /*
   * 1.1.0 (the owner, 2026-11-20, from the review of real sessions: one
   * agent held 26 fire-only wakes, 25 of them fired days before and never
   * cancelled): `fire-only once` is fired once, then removed.
   */
  test("a fire-only once wake goes when it is fired; its run is still delivered, and says it was the only one", async () => {
    const set = await as(a, "PUT", "/v1/me/wakes/job-done", {
      text: "The job ended: read out.log.",
      trigger: "fire-only once",
    })
    expect([set.status, set.body.wake.trigger]).toEqual([201, "fire-only once"])
    // a plain fire-only wake beside it stays, however often it is fired
    await as(a, "PUT", "/v1/me/wakes/again", {
      text: "Again.",
      trigger: "fire-only",
    })
    const names = async () =>
      (await as(a, "GET", "/v1/me/wakes")).body.wakes.map((w: any) => w.name)
    expect(await names()).toEqual(["again", "job-done"])
    const fire = (name: string, body?: unknown) =>
      as(a, "POST", `/v1/agents/team:a/wakes/${name}/fire`, body)
    const fired = await fire("job-done", { text: "exit 0" })
    expect(fired.status).toBe(200)
    await fire("again")
    expect(await names()).toEqual(["again"])
    const [prompt] = await tick()
    expect(prompt.payload.text).toContain(
      'Wake "job-done" (fire-only, once: this was its only run):\n' +
        "The job ended: read out.log.\n" +
        "Added by agent team:a:\n> exit 0",
    )
    expect(prompt.payload.text).toContain('Wake "again" (fire-only):')
    // a second fire finds no wake; History says the first one removed it
    const second = await fire("job-done")
    expect([second.status, second.body.error.code]).toEqual([404, "no_wake"])
    const history = (
      await owner("GET", "/v1/history?kind=wake.fired&agent=team:a")
    ).body.history
    expect(
      history.map((h: any) => [h.data.name, h.data.once ?? false]).sort(),
    ).toEqual([
      ["again", false],
      ["job-done", true],
    ])
  })

  // OpenCode's own notice for a background shell may wake the agent first:
  // it does the work and cancels the wake, whose run still waits
  test("cancelling a one-time wake that is gone drops its run that still waits", async () => {
    // team:a's turn runs: the fired run waits
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await as(a, "PUT", "/v1/me/wakes/job-done", {
      text: "The job ended.",
      trigger: "fire-only once",
    })
    await as(a, "POST", "/v1/agents/team:a/wakes/job-done/fire")
    const gone = await as(a, "DELETE", "/v1/me/wakes/job-done")
    expect([gone.status, gone.body]).toEqual([200, { cancelled: "job-done" }])
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    t.clock.advance(2 * MIN)
    expect(await tick()).toEqual([])
    // nothing waits now: no such wake
    const again = await as(a, "DELETE", "/v1/me/wakes/job-done")
    expect([again.status, again.body.error.code]).toEqual([404, "no_wake"])
  })

  test("the owner fires; an unknown wake or agent is refused", async () => {
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "fire-only" })
    expect((await owner("POST", "/v1/agents/team:a/wakes/w/fire")).status).toBe(
      200,
    )
    const [prompt] = await tick()
    expect(prompt.payload.text).toStartWith(
      '[autocode] wake "w" fired by the owner\n',
    )
    expect(
      (await owner("POST", "/v1/agents/team:a/wakes/nope/fire")).status,
    ).toBe(404)
    expect(
      (await owner("POST", "/v1/agents/team:zz/wakes/w/fire")).status,
    ).toBe(404)
  })
})

describe("checks", () => {
  async function checkThen(result: unknown) {
    t.clock.advance(MIN)
    t.server.tick()
    const [check] = await waiting("check")
    expect(check.payload).toMatchObject({
      session: "ses_a",
      directory: "/work",
      command: "./has-work.sh",
      timeout_ms: 60_000,
      output_limit: 2000,
    })
    await ack(t, HOST, check.id, result)
    return tick()
  }

  beforeEach(async () => {
    await as(a, "PUT", "/v1/me/wakes/w", {
      text: "Work.",
      trigger: "every 1m",
      check: "./has-work.sh",
    })
  })

  test("exit 0 wakes the agent, with the check's output", async () => {
    const [prompt] = await checkThen({ exit: 0, output: "3 new files" })
    expect(prompt.payload.text).toContain("Work.")
    expect(prompt.payload.text).toContain("3 new files")
  })

  test("exit 1 skips this run without a prompt and without using min_interval", async () => {
    expect(await checkThen({ exit: 1, output: "" })).toEqual([])
    const skipped = await owner("GET", "/v1/history?kind=wake.skipped")
    expect(skipped.body.history.length).toBe(1)
    // the next run is checked again at once; min_interval was not used
    const [prompt] = await checkThen({ exit: 0, output: "now" })
    expect(prompt.payload.text).toContain("now")
  })

  test("three failed checks in a row open an inbox alert", async () => {
    for (const result of [
      { exit: 2, output: "boom" },
      { exit: null, output: "", timed_out: true },
      { exit: 127, output: "not found" },
    ])
      expect(await checkThen(result)).toEqual([])
    const inbox = await owner("GET", "/v1/inbox")
    expect(inbox.body.items).toEqual([
      expect.objectContaining({
        kind: "alert",
        agent: "team:a",
        title: 'Wake "w" of team:a: its check failed 3 times in a row',
      }),
    ])
  })
})

/*
 * 1.1.0 (the owner, 2026-11-20, from the review of real sessions: hourly
 * wakes whose turns ran a script and found nothing; the script could not be
 * the check, which stops after 60 s): a wake may ask for more time for its
 * own check, up to the owner's check_timeout_max.
 */
describe("a wake's own check timeout", () => {
  const set = (name: string, body: Record<string, unknown>) =>
    as(a, "PUT", `/v1/me/wakes/${name}`, {
      text: "Work.",
      trigger: "every 1m",
      check: "./hourly.sh",
      ...body,
    })
  const failed = async () =>
    (await owner("GET", "/v1/history?kind=wake.check_failed")).body.history
      .length

  test("check_timeout on a wake: its check gets that long; without it the owner's check_timeout", async () => {
    const long = await set("long", { check_timeout: "5m" })
    expect([long.status, long.body.wake.check_timeout]).toEqual([201, "5m"])
    const plain = await set("plain", {})
    expect(plain.body.wake.check_timeout).toBeNull()
    t.clock.advance(MIN)
    t.server.tick()
    const checks = await waiting("check")
    expect(
      checks.map((c) => c.payload.timeout_ms).sort((x, y) => x - y),
    ).toEqual([60_000, 300_000])
    // setting it again without one takes it away
    expect((await set("long", {})).body.wake.check_timeout).toBeNull()
  })

  test("refused: more than check_timeout_max (10m unless the owner set another), less than 1s, no duration, or no check", async () => {
    const over = await set("w", { check_timeout: "11m" })
    expect([over.status, over.body.error.code]).toEqual([400, "bad_request"])
    expect(over.body.error.message).toBe(
      "a check may run 10m at most here (the owner's check_timeout_max); " +
        "got 11m",
    )
    for (const bad of ["soon", "0s", "500ms", 5, ""])
      expect((await set("w", { check_timeout: bad })).status, String(bad)).toBe(
        400,
      )
    const none = await as(a, "PUT", "/v1/me/wakes/w", {
      text: "Work.",
      trigger: "every 1m",
      check_timeout: "5m",
    })
    expect(none.status).toBe(400)
    expect(none.body.error.message).toContain("a check_timeout needs a check")
    expect((await as(a, "GET", "/v1/me/wakes")).body.wakes).toEqual([])
    // the owner gives this agent more
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { check_timeout_max: "30m" } },
    })
    expect((await set("w", { check_timeout: "25m" })).status).toBe(201)
    // and takes it back: the wake stays, its check gets the maximum
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { check_timeout_max: "2m" } },
    })
    t.clock.advance(MIN)
    t.server.tick()
    const [check] = await waiting("check")
    expect(check.payload.timeout_ms).toBe(120_000)
    const view = (await owner("GET", "/v1/settings")).body
    expect(view.defaults.check_timeout_max).toBe("10m")
    expect(view.schema.check_timeout_max).toMatchObject({
      kind: "duration",
      scope: "agent",
    })
  })

  test("a long check is not given up after the owner's check_timeout; past its own limit it fails", async () => {
    await set("long", { check_timeout: "5m" })
    t.clock.advance(MIN)
    t.server.tick()
    const [check] = await waiting("check")
    // four minutes without an answer: still running
    t.clock.advance(4 * MIN)
    t.server.tick()
    expect(await failed()).toBe(0)
    // it answers within its five minutes: the agent is woken
    await ack(t, HOST, check.id, { exit: 0, output: "2 runs ended" })
    const [prompt] = await tick()
    expect(prompt.payload.text).toContain("Its check said:\n> 2 runs ended")
    await turn()
    // the next one never answers: given up two minutes past its own limit
    t.clock.advance(MIN)
    t.server.tick()
    expect((await waiting("check")).length).toBe(1)
    t.clock.advance(6 * MIN)
    t.server.tick()
    expect(await failed()).toBe(0)
    t.clock.advance(2 * MIN)
    t.server.tick()
    expect(await failed()).toBe(1)
  })

  test("while a long check runs, a fired wake waits only the owner's check_timeout; the check's result comes after that turn", async () => {
    await set("long", { check_timeout: "5m" })
    await as(a, "PUT", "/v1/me/wakes/job-done", {
      text: "The job ended.",
      trigger: "fire-only once",
    })
    t.clock.advance(MIN)
    t.server.tick()
    const [check] = await waiting("check")
    await as(a, "POST", "/v1/agents/team:a/wakes/job-done/fire")
    // half a minute: it waits for the check, to come in one prompt
    t.clock.advance(MIN / 2)
    expect(await tick()).toEqual([])
    // a minute: it comes alone
    t.clock.advance(MIN / 2)
    const [first] = await tick()
    expect(first.payload.text).toStartWith(
      '[autocode] wake "job-done" fired by team:a\n',
    )
    expect(first.payload.text).not.toContain('Wake "long"')
    // the check ends during that turn; its wake comes after it
    await ack(t, HOST, check.id, { exit: 0, output: "1 run ended" })
    await turn()
    t.clock.advance(MIN)
    const [second] = await tick()
    expect(second.payload.text).toContain("Its check said:\n> 1 run ended")
  })
})

describe("idle wakes", () => {
  const due = async () =>
    (await owner("GET", "/v1/history?kind=wake.due&agent=team:a")).body.history
      .length

  test("fall due once per idle stretch, after the session is idle that long", async () => {
    await as(a, "PUT", "/v1/me/wakes/nudge", {
      text: "Anything to do?",
      trigger: "idle 10m",
    })
    // paused, so that no injected turn starts a new stretch
    await owner("POST", "/v1/agents/team:a/pause")
    await turn() // idle since 12:00
    t.clock.advance(9 * MIN)
    t.server.tick()
    expect(await due()).toBe(0)
    t.clock.advance(MIN)
    t.server.tick()
    expect(await due()).toBe(1)
    t.clock.advance(30 * MIN)
    t.server.tick()
    expect(await due()).toBe(1)
    await owner("POST", "/v1/agents/team:a/resume")
    const [prompt] = await tick()
    expect(prompt.payload.text).toStartWith('[autocode] wake "nudge"')
    // the injected turn ends: a new stretch
    await turn()
    t.clock.advance(10 * MIN)
    expect((await tick()).length).toBe(1)
  })

  test("with repeat, fall due again each time the duration passes while idle", async () => {
    await as(a, "PUT", "/v1/me/wakes/nudge", {
      text: "Anything to do?",
      trigger: "idle 10m repeat",
    })
    await owner("POST", "/v1/agents/team:a/pause")
    await turn()
    for (const n of [1, 2, 3]) {
      t.clock.advance(10 * MIN)
      t.server.tick()
      expect(await due()).toBe(n)
    }
    await owner("POST", "/v1/agents/team:a/resume")
    const prompts = await tick()
    expect(prompts.length).toBe(1)
    expect(prompts[0].payload.text.match(/Anything to do\?/g)?.length).toBe(1)
  })
})
