/*
 * A session's cost from before it registered (spec, Costs and Caps; the
 * owner, 2026-11-21: "is it possible to account for session cost before it
 * was first registered?", "yes, implement the second; earlier today towards
 * today"), with the plugin played over its channel: the first time a session
 * becomes an agent's, the server asks its plugin to account for it; the
 * plugin reports the session's earlier steps (cost.past: each with its ID,
 * time and dollars), and the server files each on its day, once. A
 * compaction's cost comes the same way when its turn ends.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ack,
  call,
  hello,
  instructions,
  registered,
  report,
  sessionToken,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

let t: TestServer
let now: number
const HOST = "m:1"
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)

// The plugin's report of earlier steps: [ID, time, dollars] each; `account`
// marks an accounting's report (a compaction's cost comes without it).
const past = (session: string, steps: unknown[], account = true) =>
  report(t, HOST, [{ type: "cost.past", session, steps, account }])

// What waits for the plugin, by type; everything but `account` acknowledged.
async function asked(): Promise<any[]> {
  const out: any[] = []
  for (const i of await instructions(t, HOST))
    if (i.type === "account") out.push(i)
    else await ack(t, HOST, i.id, { ok: true })
  return out
}

const cost = async (id: string) =>
  (await owner("GET", `/v1/costs/${id}`)).body.cost
const days = async (id: string) =>
  (await owner("GET", `/v1/costs/${id}`)).body.days.map((d: any) => [
    d.day,
    d.usd,
    d.steps,
  ])
const kinds = async (kind: string) =>
  (await owner("GET", `/v1/history?kind=${kind}`)).body.history as any[]
const agent = async (id: string) =>
  (await owner("GET", `/v1/agents/${id}`)).body.agent

beforeEach(async () => {
  t = await testServer()
  // 2026-10-28 12:00 UTC
  now = t.clock.now()
  await owner("PATCH", "/v1/settings", {
    server: { timezone: "UTC", min_interval: "1s" },
  })
  await hello(t, HOST)
})
afterEach(() => t.stop())

describe("who is asked", () => {
  test("the first registration of a session asks its plugin to account for it, once", async () => {
    const a = await registered(t, HOST, "ses_a", "team:a")
    const first = await asked()
    expect(first.map((i) => i.payload)).toEqual([{ session: "ses_a" }])
    // the report is whole
    await ack(t, HOST, first[0].id, { steps: 0, usd: 0 })
    // registered again later: nothing is counted twice, so nothing is asked
    expect((await as(a, "DELETE", "/v1/me")).status).toBe(200)
    await registered(t, HOST, "ses_a", "team:a2")
    expect(await asked()).toEqual([])
    // another session is asked for itself
    await registered(t, HOST, "ses_b", "team:b")
    expect((await asked()).map((i) => i.payload)).toEqual([
      { session: "ses_b" },
    ])
  })

  test("an ID that moves to another session: that session is asked", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    for (const i of await asked()) await ack(t, HOST, i.id, {})
    await sessionToken(t, HOST, "ses_c")
    const moved = await owner("POST", "/v1/agents", {
      id: "team:a",
      session: "ses_c",
      force: true,
    })
    expect(moved.status).toBe(200)
    expect((await asked()).map((i) => i.payload)).toEqual([
      { session: "ses_c" },
    ])
  })

  test("a job's run is not asked: its session is new", async () => {
    await owner("PUT", "/v1/jobs/mail", {
      host: HOST,
      description: "Summarizes the day's mail",
      model: "fake/main",
      prompt: "Summarize today's mail.",
      trigger: "fire-only",
      to: "owner",
    })
    expect((await owner("POST", "/v1/jobs/mail/run")).status).toBe(201)
    const types: string[] = []
    for (let round = 0; round < 3; round++) {
      t.server.tick()
      for (const i of await instructions(t, HOST)) {
        types.push(i.type)
        await ack(
          t,
          HOST,
          i.id,
          i.type === "spawn" ? { session: "ses_run" } : { ok: true },
        )
      }
    }
    expect(types).toContain("spawn")
    expect(types).not.toContain("account")
  })

  test("a plugin that cannot read its OpenCode: History says why, nothing is counted, and the next registration asks again", async () => {
    const a = await registered(t, HOST, "ses_a", "team:a")
    const [first] = await asked()
    await report(t, HOST, [
      {
        type: "ack",
        id: first.id,
        ok: false,
        error: "OpenCode's local API is not reachable",
      },
    ])
    const h = await kinds("cost.before")
    expect(h.length).toBe(1)
    expect(h[0]).toMatchObject({
      agent: "team:a",
      data: { error: "OpenCode's local API is not reachable" },
    })
    expect((await cost("team:a")).total_usd).toBe(0)
    await as(a, "DELETE", "/v1/me")
    await registered(t, HOST, "ses_a", "team:a")
    expect((await asked()).map((i) => i.payload)).toEqual([
      { session: "ses_a" },
    ])
  })
})

describe("an agent that was registered already", () => {
  test("the owner asks for it: only what its session spent before it registered, once", async () => {
    // registered while its plugin could not read its OpenCode
    await registered(t, HOST, "ses_a", "team:a")
    const [first] = await asked()
    await report(t, HOST, [
      { type: "ack", id: first.id, ok: false, error: "no local API" },
    ])
    const at = Date.parse((await agent("team:a")).registered_at)
    t.clock.advance(3 * DAY)
    const res = await owner("POST", "/v1/agents/team:a/account")
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ asked: true, agent: { id: "team:a" } })
    const [again] = await asked()
    // its steps since then were counted as they ran
    expect(again.payload).toEqual({ session: "ses_a", before: at })
    // while it is read, and once it is whole, there is nothing more to ask
    const busy = await owner("POST", "/v1/agents/team:a/account")
    expect([busy.status, busy.body.error.code]).toEqual([409, "accounted"])
    await report(t, HOST, [
      {
        type: "cost.past",
        session: "ses_a",
        account: true,
        steps: [["msg_1", at - DAY, 2]],
      },
    ])
    await ack(t, HOST, again.id, { steps: 1, usd: 2 })
    const done = await owner("POST", "/v1/agents/team:a/account")
    expect([done.status, done.body.error.code]).toEqual([409, "accounted"])
    expect((await cost("team:a")).total_usd).toBe(2)
    expect((await kinds("cost.before"))[0].data).toMatchObject({
      steps: 1,
      usd: 2,
    })
  })

  test("a session that was registered before under another ID: only what it spent before its first registration", async () => {
    // registered while its plugin could not read its OpenCode
    const old = await registered(t, HOST, "ses_a", "team:old")
    const [first] = await asked()
    await report(t, HOST, [
      { type: "ack", id: first.id, ok: false, error: "no local API" },
    ])
    const at = Date.parse((await agent("team:old")).registered_at)
    t.clock.advance(2 * DAY)
    expect((await as(old, "DELETE", "/v1/me")).status).toBe(200)
    t.clock.advance(HOUR)
    // under another ID: its steps as team:old were counted as they ran
    await registered(t, HOST, "ses_a", "team:new")
    const again = await asked()
    expect(again.map((i) => i.payload)).toEqual([
      { session: "ses_a", before: at },
    ])
    // and the owner's request for it says the same
    await report(t, HOST, [
      { type: "ack", id: again[0].id, ok: false, error: "no local API" },
    ])
    const res = await owner("POST", "/v1/agents/team:new/account")
    expect(res.status).toBe(200)
    expect((await asked()).map((i) => i.payload)).toEqual([
      { session: "ses_a", before: at },
    ])
  })

  test("no such agent; a job's run; only the owner", async () => {
    const none = await owner("POST", "/v1/agents/team:none/account")
    expect([none.status, none.body.error.code]).toEqual([404, "not_registered"])
    const a = await registered(t, HOST, "ses_a", "team:a")
    const mine = await as(a, "POST", "/v1/agents/team:a/account")
    expect(mine.status).toBe(403)
  })
})

describe("the steps", () => {
  test("each is filed on its own day, once; History says how much", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    const [account] = await asked()
    const steps = [
      ["msg_1", now - 2 * DAY, 1.5],
      ["msg_2", now - 2 * DAY + HOUR, 0.5],
      ["msg_3", now - DAY, 0.25],
      ["msg_4", now - HOUR, 0.1],
    ]
    expect((await past("ses_a", steps)).status).toBe(200)
    expect(await cost("team:a")).toMatchObject({
      today_usd: 0.1,
      total_usd: 2.35,
    })
    expect(await days("team:a")).toEqual([
      ["2026-10-28", 0.1, 1],
      ["2026-10-27", 0.25, 1],
      ["2026-10-26", 2, 2],
    ])
    // the same report again (its reply was lost): nothing more
    await past("ses_a", steps)
    expect((await cost("team:a")).total_usd).toBe(2.35)
    await ack(t, HOST, account.id, { steps: 4, usd: 2.35 })
    const h = await kinds("cost.before")
    expect(h.length).toBe(1)
    expect(h[0]).toMatchObject({
      agent: "team:a",
      data: { steps: 4, usd: 2.35, days: 3, older_usd: 0 },
    })
    // they are no turn's: no wake gets them
    expect((await owner("GET", "/v1/wakes")).body.wakes).toEqual([])
  })

  test("a step that was also reported live counts once; the agent's context and model come from live steps only", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    await asked()
    await report(t, HOST, [
      {
        type: "cost",
        session: "ses_a",
        step: "msg_9",
        usd: 0.2,
        context: 1000,
        limit: 200_000,
        model: "fake/main",
      },
    ])
    await past("ses_a", [
      ["msg_8", now - HOUR, 0.3],
      ["msg_9", now, 0.2],
    ])
    expect(await cost("team:a")).toMatchObject({
      today_usd: 0.5,
      total_usd: 0.5,
      context: 1000,
      context_limit: 200_000,
    })
    expect((await agent("team:a")).model).toBe("fake/main")
    // and the other way round: a live step of an ID already filed
    await report(t, HOST, [
      { type: "cost", session: "ses_a", step: "msg_8", usd: 0.3 },
    ])
    expect((await cost("team:a")).total_usd).toBe(0.5)
  })

  test("the day is the server's: a step late in the evening there", async () => {
    await owner("PATCH", "/v1/settings", {
      server: { timezone: "America/Los_Angeles" },
    })
    await registered(t, HOST, "ses_a", "team:a")
    await asked()
    // 2026-10-28 06:30 UTC is 2026-10-27 23:30 in Los Angeles
    await past("ses_a", [["msg_1", Date.parse("2026-10-28T06:30:00Z"), 1]])
    expect(await days("team:a")).toEqual([["2026-10-27", 1, 1]])
    expect((await cost("team:a")).today_usd).toBe(0)
  })

  test("a step older than the days the server keeps goes to the total only", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    const [account] = await asked()
    await past("ses_a", [
      ["msg_old", now - 40 * DAY, 3],
      ["msg_new", now - 10 * DAY, 1],
    ])
    expect((await cost("team:a")).total_usd).toBe(4)
    expect(await days("team:a")).toEqual([["2026-10-18", 1, 1]])
    await ack(t, HOST, account.id, { steps: 2, usd: 4 })
    expect((await kinds("cost.before"))[0].data).toMatchObject({
      steps: 2,
      usd: 4,
      days: 1,
      older_usd: 3,
    })
    // a trim leaves it as it is
    t.server.maintenance()
    expect((await cost("team:a")).total_usd).toBe(4)
    expect(await days("team:a")).toEqual([["2026-10-18", 1, 1]])
  })

  test("a step with a time after now counts for today", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    await asked()
    await past("ses_a", [["msg_1", now + 3 * DAY, 1]])
    expect(await days("team:a")).toEqual([["2026-10-28", 1, 1]])
  })

  test("a session that is no agent's, and what is no step, count nothing", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    await asked()
    await past("ses_loose", [["msg_1", now, 1]])
    await past("ses_a", [
      ["msg_2", now, -1],
      ["msg_3", now, "1"],
      ["msg_4", now, 1e9],
      ["msg_5", "yesterday", 1],
      ["", now, 1],
      [7, now, 1],
      "msg_6",
      null,
    ])
    expect((await past("ses_a", "none" as any)).status).toBe(200)
    expect((await cost("team:a")).total_usd).toBe(0)
    expect(await days("team:a")).toEqual([])
  })
})

describe("earlier today counts for today", () => {
  beforeEach(async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { daily_usd: 1 } },
    })
  })

  test("the cap's warning, then the pause when the running turn ends", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    await asked()
    // it registered in a turn of its own
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await past("ses_a", [["msg_1", now - HOUR, 0.95]])
    expect((await kinds("cap.warned")).length).toBe(1)
    await past("ses_a", [["msg_2", now - 30 * MIN, 0.2]])
    // the running turn goes on
    expect((await agent("team:a")).status).toBe("working")
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    expect(await agent("team:a")).toMatchObject({
      status: "paused",
      paused: "cap",
    })
    const alert = (await owner("GET", "/v1/inbox")).body.items.find(
      (i: any) => i.kind === "alert",
    )
    expect(alert.title).toBe("team:a reached its daily cap ($1.15 of $1.00)")
  })

  test("an idle agent past its cap is paused at once", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    await asked()
    await past("ses_a", [["msg_1", now - HOUR, 1.5]])
    expect(await agent("team:a")).toMatchObject({
      status: "paused",
      paused: "cap",
    })
    expect((await kinds("cap.reached")).length).toBe(1)
  })

  test("what it spent yesterday does not count toward today's cap", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    await asked()
    await past("ses_a", [["msg_1", now - DAY, 5]])
    expect((await agent("team:a")).status).toBe("idle")
    expect(await kinds("cap.*")).toEqual([])
    expect(await cost("team:a")).toMatchObject({
      today_usd: 0,
      total_usd: 5,
      left_usd: 1,
    })
  })
})

describe("a compaction's cost", () => {
  test("reported when its turn ends: filed once, for today", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    for (const i of await asked()) await ack(t, HOST, i.id, {})
    await past("ses_a", [["msg_c1", now, 0.37]], false)
    await past("ses_a", [["msg_c1", now, 0.37]], false)
    expect(await cost("team:a")).toMatchObject({
      today_usd: 0.37,
      total_usd: 0.37,
    })
    // not the report of an accounting: History has none
    expect(await kinds("cost.before")).toEqual([])
  })
})
