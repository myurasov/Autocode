/*
 * Tier 0e over the API, with the plugin played over its channel: costs per
 * step (cost events) add up per agent and day, in the server's zone;
 * daily_usd with a notice at cap_warn and a pause once the turn that passed
 * it ends (an inbox alert; the next day, a raised cap or a resume lifts it);
 * a session whose context passed compact_at is told first (tier 0g: a
 * "compaction next" prompt), then compacted when that turn ends, before the
 * next injection, or idle with nothing waiting (the owner, 2026-11-09);
 * autocode_me compact asks for one (no notice); a turn cut
 * by a lost OpenCode is resumed when the host is back; agents expire after
 * expire_after since their last turn; the background service is restarted
 * when its hosts stay offline.
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
const HOST = "m:1"
const MIN = 60_000
const DAY = 86_400_000

const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)

// One step's cost, as the plugin reports it from session.step.ended.
const step = (usd: number, context = 1000, session = "ses_a") => ({
  type: "cost",
  session,
  usd,
  context,
  limit: 200_000,
  model: "fake/main",
})

async function sent(): Promise<any[]> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out) await ack(t, HOST, i.id, { ok: true })
  return out
}
const prompts = async () =>
  Object.fromEntries(
    (await sent())
      .filter((i) => i.type === "inject")
      .map((i) => [i.payload.session, i.payload.text]),
  )
const agent = async () => (await owner("GET", "/v1/agents/team:a")).body.agent
const turnEnds = (session = "ses_a") =>
  report(t, HOST, [{ type: "turn.ended", session, outcome: "succeeded" }])

beforeEach(async () => {
  t = await testServer()
  await owner("PATCH", "/v1/settings", {
    server: { timezone: "America/Los_Angeles", min_interval: "1s" },
  })
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("costs", () => {
  test("steps add up per agent and day; /v1/me and the agent's view say them", async () => {
    await report(t, HOST, [step(0.25), step(0.5, 3000)])
    expect((await agent()).cost).toMatchObject({
      today_usd: 0.75,
      daily_usd: "off",
      context: 3000,
      context_limit: 200_000,
    })
    const me = (await as(a, "GET", "/v1/me")).body
    expect(me.cost).toMatchObject({ today_usd: 0.75, daily_usd: "off" })
    // the next day in the server's zone (12:00 UTC is 05:00 PDT)
    t.clock.advance(DAY)
    await report(t, HOST, [step(0.1)])
    expect((await agent()).cost.today_usd).toBe(0.1)
    const h = (await owner("GET", "/v1/history?kind=cost.*")).body.history
    expect(h.length).toBe(0) // steps are not history; turns carry cost
  })

  test("a session that is no agent's costs nothing here", async () => {
    await report(t, HOST, [step(1, 1000, "ses_loose")])
    expect((await agent()).cost.today_usd).toBe(0)
  })

  test("bad cost events are skipped", async () => {
    await report(t, HOST, [
      { ...step(0.1), usd: -1 },
      { ...step(0.1), usd: "x" },
      { ...step(0.1), usd: 1e9 },
    ])
    expect((await agent()).cost.today_usd).toBe(0)
  })
})

describe("the daily cap", () => {
  test("a notice at cap_warn, once a day; the pause after the turn that passes the cap; an alert", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { daily_usd: 1 } },
    })
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [step(0.95)])
    await report(t, HOST, [step(0.01)])
    await turnEnds()
    // one notice, at the step that reached 90%
    const warn = (await prompts()).ses_a
    expect(warn).toStartWith("[autocode] cost warning\n\n")
    expect(warn).toContain(
      "You have spent $0.95 today of your daily cap of $1.00 (cap_warn 90%)",
    )
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [step(0.1)])
    // the running turn goes on
    expect((await agent()).status).toBe("working")
    await turnEnds()
    expect(await agent()).toMatchObject({ status: "paused", paused: "cap" })
    const alert = (await owner("GET", "/v1/inbox")).body.items.find(
      (i: any) => i.kind === "alert",
    )
    expect(alert.title).toBe("team:a reached its daily cap ($1.06 of $1.00)")
    // no second warning that day
    const h = (await owner("GET", "/v1/history?kind=cap.*")).body.history
    expect(h.map((e: any) => e.kind).reverse()).toEqual([
      "cap.warned",
      "cap.reached",
    ])
  })

  test("raising the cap lifts the pause; the next day does too; an owner's pause stays", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { daily_usd: 1 } },
    })
    await report(t, HOST, [step(2)])
    await turnEnds()
    expect((await agent()).paused).toBe("cap")
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { daily_usd: 5 } },
    })
    t.server.tick()
    expect((await agent()).paused).toBe("")
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { daily_usd: 1 } },
    })
    await turnEnds()
    expect((await agent()).paused).toBe("cap")
    t.clock.advance(DAY)
    t.server.tick()
    expect((await agent()).paused).toBe("")
    // the owner's own pause is not lifted by a new day
    await owner("POST", "/v1/agents/team:a/pause")
    t.clock.advance(DAY)
    t.server.tick()
    expect((await agent()).paused).toBe("owner")
  })

  test("cap_warn is configurable", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { daily_usd: 10, cap_warn: "50%" } },
    })
    await report(t, HOST, [step(5)])
    await turnEnds()
    expect((await prompts()).ses_a).toContain("(cap_warn 50%)")
  })
})

describe("compaction", () => {
  // Tier 0g (the owner, 2026-11-08): the agent is told first, so its work is
  // in a stable state and nothing is lost; the compaction follows that turn.
  test("a session past compact_at is told first, then compacted when that turn ends, before the next injection", async () => {
    await owner("PATCH", "/v1/settings", { server: { compact_at: "50%" } })
    await report(t, HOST, [step(0.01, 120_000)])
    await turnEnds()
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 1m" })
    t.clock.advance(MIN)
    const notice = await sent()
    expect(notice.map((i) => i.type)).toEqual(["inject"])
    const text = notice[0].payload.text as string
    expect(text).toStartWith("[autocode] compaction next\n\n")
    expect(text).toContain("120,000 tokens")
    expect(text).toContain("threshold of 100,000 (compact_at)")
    expect(text).toContain(
      "When this turn ends, Autocode compacts this session",
    )
    expect(text).toContain("stable state")
    expect(text).toContain("write down in files")
    // the wake waits for after the compaction
    expect(text).not.toContain('wake "w"')
    expect(
      (await owner("GET", "/v1/history?kind=session.compact.noticed")).body
        .history[0].data,
    ).toMatchObject({ context: 120_000, limit: 100_000 })
    // nothing more until that turn ends
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    t.clock.advance(MIN)
    expect((await sent()).map((i) => i.type)).toEqual([])
    await report(t, HOST, [step(0.01, 125_000)])
    await turnEnds()
    const out = await sent()
    expect(out.map((i) => i.type)).toEqual(["compact"])
    expect(out[0].payload).toEqual({ session: "ses_a" })
    // the compaction is a turn; when it ends, the wake comes
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [step(0.01, 8000)])
    await turnEnds()
    t.clock.advance(2000)
    expect((await prompts()).ses_a).toStartWith('[autocode] wake "w"')
    const h = (await owner("GET", "/v1/history?kind=session.compacted")).body
      .history
    expect(h[0].data).toMatchObject({ context: 125_000, limit: 100_000 })
  })

  /*
   * The owner, 2026-11-09: "i want compaction notice/compaction message to be
   * injected mid turn, if we're past the threshold": the notice steers into
   * the running turn at its next step; the compaction comes when the turn
   * ends, as with any notice.
   */
  test("past compact_at during a turn: the notice goes into that turn (steer); the compaction when it ends", async () => {
    await owner("PATCH", "/v1/settings", { server: { compact_at: "50%" } })
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [step(0.01, 90_000)])
    // below the threshold: nothing
    expect((await sent()).map((i) => i.type)).toEqual([])
    await report(t, HOST, [step(0.01, 120_000)])
    const [notice] = await sent()
    expect(notice.type).toBe("inject")
    expect(notice.payload.delivery).toBe("steer")
    expect(notice.payload.text).toStartWith(
      "[autocode] compaction next, during your turn\n\n",
    )
    expect(notice.payload.text).toContain("120,000 tokens")
    // once: the next steps of the same turn send nothing more
    await report(t, HOST, [step(0.01, 130_000)])
    t.clock.advance(MIN)
    expect((await sent()).map((i) => i.type)).toEqual([])
    // the turn goes on (busy); when it ends, the compaction
    expect((await as(a, "GET", "/v1/me")).body.agent.busy).toBe(true)
    await turnEnds()
    const out = await sent()
    expect(out.map((i) => i.type)).toEqual(["compact"])
    const h = (await owner("GET", "/v1/history?kind=session.compact.noticed"))
      .body.history
    expect(h[0].data).toMatchObject({ steer: true })
  })

  test("past compact_at during a turn: no notice while paused or in the error state", async () => {
    await owner("PATCH", "/v1/settings", { server: { compact_at: "50%" } })
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await owner("POST", "/v1/agents/team:a/pause")
    await report(t, HOST, [step(0.01, 120_000)])
    expect((await sent()).map((i) => i.type)).toEqual([])
    await owner("POST", "/v1/agents/team:a/resume")
    expect((await sent()).map((i) => i.payload?.delivery)).toEqual(["steer"])
  })

  test("a notice no turn took (the session never started one) does not hold the compaction back", async () => {
    await owner("PATCH", "/v1/settings", { server: { compact_at: "50%" } })
    await report(t, HOST, [step(0.01, 120_000)])
    await turnEnds()
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 1m" })
    t.clock.advance(MIN)
    expect((await prompts()).ses_a).toStartWith("[autocode] compaction next")
    // no turn.started: after the no-turn wait, the compaction goes
    t.clock.advance(3 * MIN)
    expect((await sent()).map((i) => i.type)).toEqual(["compact"])
  })

  // A context only gets smaller when OpenCode compacted the session itself:
  // then a second compaction would only cost (the e2e run, 2026-11-08).
  test("a session that got smaller in the notice's turn (OpenCode compacted it) is not compacted again", async () => {
    await owner("PATCH", "/v1/settings", { server: { compact_at: "50%" } })
    await report(t, HOST, [step(0.01, 120_000)])
    await turnEnds()
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 1m" })
    t.clock.advance(MIN)
    expect((await prompts()).ses_a).toStartWith("[autocode] compaction next")
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [step(0.01, 5000)])
    await turnEnds()
    t.clock.advance(2000)
    expect((await prompts()).ses_a).toStartWith('[autocode] wake "w"')
  })

  test("below the threshold again (a raised compact_at), the notice is forgotten; past it later, a new one comes", async () => {
    await owner("PATCH", "/v1/settings", { server: { compact_at: "50%" } })
    await report(t, HOST, [step(0.01, 120_000)])
    await turnEnds()
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 1m" })
    t.clock.advance(MIN)
    expect((await prompts()).ses_a).toStartWith("[autocode] compaction next")
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await owner("PATCH", "/v1/settings", { server: { compact_at: "80%" } })
    await turnEnds()
    t.clock.advance(2000)
    expect((await prompts()).ses_a).toStartWith('[autocode] wake "w"')
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [step(0.01, 170_000)])
    await turnEnds()
    t.clock.advance(MIN)
    expect((await prompts()).ses_a).toStartWith("[autocode] compaction next")
  })

  test("a number of tokens, off, and the cap of 500,000", async () => {
    await owner("PATCH", "/v1/settings", { server: { compact_at: "off" } })
    await report(t, HOST, [step(0.01, 190_000)])
    await turnEnds()
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 1m" })
    t.clock.advance(MIN)
    expect((await sent()).map((i) => i.type)).toEqual(["inject"])
  })

  // The owner, 2026-11-09: a session driven only from the TUI (no wake or
  // message for it) still compacts on time.
  test("an idle agent past compact_at with nothing waiting is told, compacted after that turn, then left alone", async () => {
    await owner("PATCH", "/v1/settings", { server: { compact_at: "50%" } })
    // the owner's own turn in the TUI passes the threshold
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [step(0.01, 120_000)])
    await turnEnds()
    t.clock.advance(2000)
    const notice = await sent()
    expect(notice.map((i) => i.type)).toEqual(["inject"])
    expect(notice[0].payload.text).toStartWith("[autocode] compaction next\n\n")
    expect(notice[0].payload.text).toContain("120,000 tokens")
    // the notice's turn, then the compaction
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await turnEnds()
    expect((await sent()).map((i) => i.type)).toEqual(["compact"])
    // the compaction's turn (its step reads the old conversation)
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [step(0.01, 150_000)])
    await turnEnds()
    // nothing more: no second notice, no loop
    for (const wait of [2000, MIN, 10 * MIN]) {
      t.clock.advance(wait)
      expect((await sent()).map((i) => i.type)).toEqual([])
    }
    const count = async (kind: string) =>
      (await owner("GET", `/v1/history?kind=${kind}`)).body.history.length
    expect(await count("session.compact.noticed")).toBe(1)
    expect(await count("session.compacted")).toBe(1)
  })

  test("an idle agent past compact_at: not while paused, in error or with compact_at off; below it, nothing", async () => {
    await owner("PATCH", "/v1/settings", { server: { compact_at: "50%" } })
    // below the threshold
    await report(t, HOST, [step(0.01, 90_000)])
    await turnEnds()
    t.clock.advance(MIN)
    expect((await sent()).map((i) => i.type)).toEqual([])
    // paused: nothing until it is resumed
    await owner("POST", "/v1/agents/team:a/pause")
    await report(t, HOST, [step(0.01, 120_000)])
    await turnEnds()
    t.clock.advance(MIN)
    expect((await sent()).map((i) => i.type)).toEqual([])
    // compact_at off for it: nothing
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { compact_at: "off" } },
    })
    await owner("POST", "/v1/agents/team:a/resume")
    t.clock.advance(MIN)
    expect((await sent()).map((i) => i.type)).toEqual([])
    // back on: the notice
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { compact_at: null } },
    })
    t.clock.advance(2000)
    expect((await prompts()).ses_a).toStartWith("[autocode] compaction next")
  })

  test("an idle agent in error past compact_at gets only its retries", async () => {
    await owner("PATCH", "/v1/settings", {
      server: { compact_at: "50%", retry_interval: "10m" },
    })
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [step(0.01, 120_000)])
    await report(t, HOST, [
      {
        type: "turn.ended",
        session: "ses_a",
        outcome: "failed",
        error: "provider.internal",
      },
    ])
    t.clock.advance(2000)
    expect((await sent()).map((i) => i.type)).toEqual([])
  })

  test("an idle agent's notice that did not arrive is sent again after min_interval, not at once", async () => {
    await owner("PATCH", "/v1/settings", {
      server: { compact_at: "50%" },
      agents: { "team:a": { min_interval: "1m" } },
    })
    await report(t, HOST, [step(0.01, 120_000)])
    await turnEnds()
    t.server.tick()
    const out = await instructions(t, HOST)
    expect(out.map((i) => i.type)).toEqual(["inject"])
    // the plugin could not type it
    for (const i of out) await ack(t, HOST, i.id, null, false)
    t.clock.advance(2000)
    expect((await sent()).map((i) => i.type)).toEqual([])
    t.clock.advance(MIN)
    expect((await prompts()).ses_a).toStartWith("[autocode] compaction next")
  })

  test("autocode_me compact: after the current turn, with no notice", async () => {
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    const res = await as(a, "POST", "/v1/me/compact")
    expect(res.status).toBe(200)
    expect((await sent()).map((i) => i.type)).toEqual([])
    await turnEnds()
    expect((await sent()).map((i) => i.type)).toEqual(["compact"])
  })
})

describe("resume", () => {
  test("a turn cut by a lost OpenCode is resumed when the host is back", async () => {
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    // OpenCode went away: the plugin's next hello says no turn runs
    await hello(t, HOST, { active: [] })
    const prompt = (await prompts()).ses_a
    expect(prompt).toStartWith("[autocode] resume\n\n")
    expect(prompt).toContain(
      "Your last turn was cut off (its OpenCode server restarted). " +
        "Continue where you left off.",
    )
    const h = (await owner("GET", "/v1/history?kind=turn.cut")).body.history
    expect(h[0].agent).toBe("team:a")
  })

  test("a session that was idle is not resumed", async () => {
    await hello(t, HOST, { active: [] })
    expect(await prompts()).toEqual({})
  })
})

describe("expiry", () => {
  test("an agent expire_after its last turn is unregistered", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { expire_after: "2d" } },
    })
    await turnEnds()
    t.clock.advance(DAY)
    t.server.maintenance()
    expect((await owner("GET", "/v1/agents/team:a")).status).toBe(200)
    t.clock.advance(DAY + MIN)
    await hello(t, HOST)
    t.server.maintenance()
    expect((await owner("GET", "/v1/agents/team:a")).status).toBe(404)
    const h = (await owner("GET", "/v1/history?kind=agent.expired")).body
      .history
    expect(h[0]).toMatchObject({ agent: "team:a" })
  })
})

// The adversarial review of 0e (2026-11-07).
describe("review of 0e", () => {
  test("no second compaction from the compaction's own step: a wake comes between", async () => {
    await owner("PATCH", "/v1/settings", { server: { compact_at: "50%" } })
    await report(t, HOST, [step(0.01, 120_000)])
    await turnEnds()
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 1m" })
    t.clock.advance(MIN)
    // the notice's turn, then the compaction
    expect((await prompts()).ses_a).toStartWith("[autocode] compaction next")
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await turnEnds()
    expect((await sent()).map((i) => i.type)).toEqual(["compact"])
    // the compaction's step reads the whole old conversation
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [step(0.01, 150_000)])
    await turnEnds()
    t.clock.advance(2000)
    expect((await sent()).map((i) => i.type)).toEqual(["inject"])
  })

  test("compact_at is at least 10,000 tokens", async () => {
    const res = await owner("PATCH", "/v1/settings", {
      server: { compact_at: 5000 },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain("at least 10000 tokens")
  })

  test("a turn.ended that comes right after the hello (the outbox) is no cut turn", async () => {
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await hello(t, HOST, { active: [] })
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    expect(await prompts()).toEqual({})
    const h = (await owner("GET", "/v1/history?kind=turn.cut")).body.history
    expect(h.length).toBe(1)
  })

  test("the owner's pause and stop-all replace a cap's pause; the next day leaves them", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { daily_usd: 1 } },
    })
    await report(t, HOST, [step(2)])
    await turnEnds()
    expect((await agent()).paused).toBe("cap")
    await owner("POST", "/v1/agents/team:a/pause")
    expect((await agent()).paused).toBe("owner")
    t.clock.advance(DAY)
    t.server.tick()
    expect((await agent()).paused).toBe("owner")
  })

  test("the owner's resume of a capped agent holds for the day: no new pause, no new alert", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { daily_usd: 1 } },
    })
    await report(t, HOST, [step(2)])
    await turnEnds()
    await owner("POST", "/v1/agents/team:a/resume")
    await report(t, HOST, [step(0.5)])
    await turnEnds()
    expect((await agent()).paused).toBe("")
    const alerts = (await owner("GET", "/v1/inbox")).body.items.filter(
      (i: any) => i.kind === "alert",
    )
    expect(alerts.length).toBe(1)
    // the next day the cap counts again
    t.clock.advance(DAY)
    await report(t, HOST, [step(2)])
    await turnEnds()
    expect((await agent()).paused).toBe("cap")
  })

  test("a step reported twice (a lost reply) counts once", async () => {
    await report(t, HOST, [{ ...step(0.25), step: "msg_1" }])
    await report(t, HOST, [{ ...step(0.25), step: "msg_1" }])
    expect((await agent()).cost.today_usd).toBe(0.25)
  })

  test("removed settings stored before (tools, total_usd, ...) do not block a change", async () => {
    t.server.db
      .query("INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)")
      .run("server", "total_usd", "100")
    t.server.db
      .query("INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)")
      .run(
        "agent",
        "team:a",
        JSON.stringify({ keep_failed: true, cap_warn: "80%" }),
      )
    const res = await owner("PATCH", "/v1/settings", {
      server: { min_interval: "2s" },
    })
    expect(res.status).toBe(200)
    const v = (await owner("GET", "/v1/settings")).body
    expect(JSON.stringify(v)).not.toContain("total_usd")
    expect(JSON.stringify(v)).not.toContain("keep_failed")
  })

  test("a deleted session's agent stays (offline, its ID may move) but its locks go", async () => {
    await as(a, "POST", "/v1/locks/gpu/acquire", { ttl: "1h" })
    await report(t, HOST, [{ type: "session.deleted", session: "ses_a" }])
    expect((await agent()).status).toBe("offline")
    const locks = (await owner("GET", "/v1/locks")).body.locks
    expect(locks.find((l: any) => l.name === "gpu")).toBeUndefined()
  })

  test("expiry skips an agent with an open approval or the owner's pause", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { expire_after: "1d" } },
    })
    await turnEnds()
    await as(a, "POST", "/v1/me/approvals", { text: "Go?" })
    t.clock.advance(2 * DAY)
    await hello(t, HOST)
    t.server.maintenance()
    expect((await owner("GET", "/v1/agents/team:a")).status).toBe(200)
  })
})
