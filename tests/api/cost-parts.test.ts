/*
 * Costs by kind and by cause (1.1.0-rc7; the owner, 2026-11-27, from a
 * review of real sessions: cache writes were about half of two servers'
 * spend and nothing showed it). A step's dollars are divided among cache
 * writes, cache reads, new input and output in the proportion of its
 * tokens times the model's rates; the Subagents' steps are told apart; each
 * turn has a cause, what started it; and the first step of a turn is what
 * the turn costs to reload the context. Per agent, day, cause and
 * own-or-Subagent, with one more set over all days.
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
let a: string // team:a on ses_a
const HOST = "m:1"
const MIN = 60_000
const DAY = 86_400_000

const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)
const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)

// The scheduler ticks; the checks are answered, the prompts handed over.
async function tick(): Promise<any[]> {
  t.server.tick()
  let out = await instructions(t, HOST)
  for (const i of out.filter((i) => i.type === "check")) {
    await ack(t, HOST, i.id, { exit: 0, output: "" })
    t.server.tick()
  }
  out = [...out, ...(await instructions(t, HOST))]
  const prompts = out.filter((i) => i.type === "inject")
  for (const i of prompts) await ack(t, HOST, i.id, { ok: true })
  return prompts
}

// Dollars per million tokens, as OpenCode's model list has them.
const RATES = { input: 3, output: 15, read: 0.3, write: 3.75 }
/*
 * 1,000 new input, 2,000 output, 100,000 read from the cache and 20,000
 * written to it: at RATES $0.003 + $0.03 + $0.03 + $0.075 = $0.138.
 */
const TOKENS = { input: 1000, output: 2000, read: 100_000, write: 20_000 }

let steps = 0
const step = (usd: number, more: Record<string, unknown> = {}) => ({
  type: "cost",
  session: "ses_a",
  usd,
  context: 121_000,
  limit: 1_000_000,
  model: "fake/main",
  step: `st_${++steps}`,
  tokens: TOKENS,
  rates: RATES,
  ...more,
})
const started = (by?: string, ref?: string, session = "ses_a") => ({
  type: "turn.started",
  session,
  ...(by ? { by } : {}),
  ...(ref ? { ref } : {}),
})
const ended = (session = "ses_a") => ({
  type: "turn.ended",
  session,
  outcome: "succeeded",
})
const work = (ref: string) => ({
  type: "work.started",
  session: "ses_a",
  ref,
})

const one = async (q = "") => (await owner("GET", `/v1/costs/team:a${q}`)).body
const causes = async (q = "") =>
  Object.fromEntries(
    (await one(q)).causes.map((c: any) => [c.cause, [c.turns, c.usd]]),
  )

beforeEach(async () => {
  steps = 0
  t = await testServer()
  await owner("PATCH", "/v1/settings", {
    server: { timezone: "UTC", min_interval: "1s" },
  })
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("costs by kind", () => {
  test("a step's dollars are divided among the four kinds by tokens times rate, and add up to the step's", async () => {
    // priced at twice the list (a provider's own cost, a tier): the
    // proportions hold, the sum is what OpenCode recorded
    await report(t, HOST, [started("user"), step(0.276)])
    const split = (await one()).split
    expect(split).toEqual({
      usd: 0.276,
      cache_write_usd: 0.15,
      cache_read_usd: 0.06,
      input_usd: 0.006,
      output_usd: 0.06,
      cache_write_tokens: 20_000,
      cache_read_tokens: 100_000,
      input_tokens: 1000,
      output_tokens: 2000,
      subagents_usd: 0,
      // the turn's first step: what it cost to load the context
      reload_usd: 0.216,
      turns: 1,
    })
    expect(
      split.cache_write_usd +
        split.cache_read_usd +
        split.input_usd +
        split.output_usd,
    ).toBeCloseTo(0.276, 9)
  })

  test("a step without rates, or with nothing to weigh, counts but is not split; its tokens count", async () => {
    await report(t, HOST, [
      started("user"),
      step(0.1, { rates: undefined }),
      step(0.2, { rates: { input: 0, output: 0, read: 0, write: 0 } }),
      // an older plugin: neither tokens nor rates
      step(0.3, { rates: undefined, tokens: undefined }),
      // what cannot be numbers is passed over, the step still counts
      step(0.4, {
        rates: undefined,
        tokens: { input: -1, output: "x", read: 1e12 },
      }),
    ])
    const split = (await one()).split
    expect(split).toMatchObject({
      usd: 1,
      cache_write_usd: 0,
      cache_read_usd: 0,
      input_usd: 0,
      output_usd: 0,
      cache_write_tokens: 40_000,
      cache_read_tokens: 200_000,
      input_tokens: 2000,
      output_tokens: 4000,
      // no reload either: the first step was not split
      reload_usd: 0,
    })
    // the spend itself is whole
    expect((await one()).cost.today_usd).toBe(1)
  })

  test("the Subagents' steps are told apart, with their own model's tokens and rates", async () => {
    await report(t, HOST, [
      started("user"),
      step(0.138),
      work("ses_kid"),
      step(0.069, {
        sub: "ses_kid",
        context: undefined,
        tokens: { input: 500, output: 1000, read: 50_000, write: 10_000 },
      }),
      // a step sent twice counts once
      step(0.069, { sub: "ses_kid", context: undefined, step: "st_2" }),
    ])
    expect((await one()).split).toMatchObject({
      usd: 0.207,
      subagents_usd: 0.069,
      cache_write_usd: 0.1125,
      // only the agent's own first step is a reload
      reload_usd: 0.108,
      turns: 1,
    })
  })
})

describe("costs by what started the turn", () => {
  test("a wake, a message, the owner, and a turn nobody explained", async () => {
    // the owner types into the session
    await report(t, HOST, [started("user"), step(0.5), ended()])
    // a wake
    await as(a, "PUT", "/v1/me/wakes/hourly", {
      text: "The hourly pass.",
      trigger: "every 1h",
    })
    t.clock.advance(60 * MIN)
    expect((await tick()).length).toBe(1)
    await report(t, HOST, [started("user"), step(0.138), step(0.25), ended()])
    // a message from the owner
    await owner("POST", "/v1/messages", { to: "team:a", text: "Hello." })
    t.clock.advance(2000)
    expect((await tick()).length).toBe(1)
    await report(t, HOST, [started("user"), step(0.75), ended()])
    // a turn whose start an older plugin does not explain
    await report(t, HOST, [started(), step(0.125), ended()])
    expect(await causes()).toEqual({
      message: [1, 0.75],
      owner: [1, 0.5],
      wake: [1, 0.388],
      other: [1, 0.125],
    })
    // largest first, each with its steps, its kinds and its reload
    const list = (await one()).causes
    expect(list.map((c: any) => c.cause)).toEqual([
      "message",
      "owner",
      "wake",
      "other",
    ])
    expect(list[2]).toMatchObject({
      cause: "wake",
      turns: 1,
      steps: 2,
      usd: 0.388,
      subagents_usd: 0,
      // of its first step ($0.138): all but the output's $0.03
      reload_usd: 0.108,
    })
    // and the wake's own numbers say the reload
    const wake = (await as(a, "GET", "/v1/me/wakes")).body.wakes[0]
    expect(wake.week).toEqual({
      due: 1,
      skipped: 0,
      turns: 1,
      usd: 0.388,
      reload_usd: 0.108,
    })
  })

  test("a turn that OpenCode's notice starts, and a Subagent's steps, have the cause of the turn that started the work", async () => {
    await as(a, "PUT", "/v1/me/wakes/hourly", {
      text: "The hourly pass.",
      trigger: "every 1h",
    })
    t.clock.advance(60 * MIN)
    await tick()
    // the wake's turn starts a Subagent and ends; then the owner writes
    await report(t, HOST, [
      started("user"),
      step(0.1),
      work("ses_kid"),
      ended(),
      started("user"),
      step(0.2),
      // the Subagent still works: its step is the wake's, not the owner's
      step(0.4, { sub: "ses_kid", context: undefined }),
      ended(),
      // its result starts a turn: the wake's again
      started("notice", "ses_kid"),
      step(0.8),
      ended(),
    ])
    expect(await causes()).toEqual({ wake: [2, 1.3], owner: [1, 0.2] })
    const wake = (await one()).causes[0]
    expect(wake.subagents_usd).toBe(0.4)
  })

  test("the compaction notice's turn, the turn after it, and the compaction's own cost", async () => {
    await owner("PATCH", "/v1/settings", { server: { compact_at: 100_000 } })
    await report(t, HOST, [started("user"), step(0.5), ended()])
    t.clock.advance(2000)
    const notice = await tick()
    expect(notice[0].payload.text).toStartWith("[autocode] compaction next")
    await report(t, HOST, [started("user"), step(0.25), ended()])
    // the compaction itself: OpenCode's records give its cost afterwards
    await report(t, HOST, [
      {
        type: "cost.past",
        session: "ses_a",
        steps: [["msg_compaction", t.clock.now(), 0.0625]],
      },
    ])
    expect(await causes()).toEqual({
      owner: [1, 0.5],
      compaction: [1, 0.3125],
    })
  })

  test("the steps from before the session registered are their own cause, and not split", async () => {
    await report(t, HOST, [
      {
        type: "cost.past",
        session: "ses_a",
        account: true,
        steps: [
          ["msg_1", t.clock.now() - 2 * DAY, 1.5],
          ["msg_2", t.clock.now() - 2 * DAY, 0.5],
        ],
      },
    ])
    const view = await one()
    expect(await causes()).toEqual({ earlier: [0, 2] })
    expect(view.split).toMatchObject({ usd: 2, cache_write_usd: 0, turns: 0 })
    // on their own day
    expect(view.days.map((d: any) => [d.usd, d.split.usd])).toEqual([[2, 2]])
  })
})

describe("where the split shows", () => {
  test("every agent's row, the totals, one agent's days, a period, and the agent's own status", async () => {
    const b = await registered(t, HOST, "ses_b", "team:b")
    await report(t, HOST, [
      started("user"),
      step(0.276),
      started("user", undefined, "ses_b"),
      step(0.138, { session: "ses_b" }),
    ])
    t.clock.advance(DAY)
    await report(t, HOST, [step(0.138)])
    // all time
    let list = (await owner("GET", "/v1/costs")).body
    const row = (id: string) => list.agents.find((x: any) => x.agent === id)
    expect(row("team:a").split).toMatchObject({
      usd: 0.414,
      cache_write_usd: 0.225,
      turns: 1,
    })
    expect(row("team:b").split).toMatchObject({ usd: 0.138, turns: 1 })
    expect(list.totals.split).toMatchObject({
      usd: 0.552,
      cache_write_usd: 0.3,
      cache_read_usd: 0.12,
      input_usd: 0.012,
      output_usd: 0.12,
      cache_write_tokens: 60_000,
      turns: 2,
    })
    // the last day only
    list = (await owner("GET", "/v1/costs?days=1")).body
    expect(row("team:a").split).toMatchObject({ usd: 0.138, turns: 0 })
    expect(list.totals.split.usd).toBe(0.138)
    // one agent: its split, causes and days for the period, each day's own
    const all = await one()
    expect(all.split.usd).toBe(0.414)
    expect(all.days.map((d: any) => [d.usd, d.split.cache_write_usd])).toEqual([
      [0.138, 0.075],
      [0.276, 0.15],
    ])
    const last = await one("?days=1")
    expect(last.split.usd).toBe(0.138)
    expect(last.causes.map((c: any) => [c.cause, c.usd])).toEqual([
      ["owner", 0.138],
    ])
    expect((await owner("GET", "/v1/costs/team:a?days=0")).status).toBe(400)
    // the consumer token reads it too
    expect(
      (await call(t.url, t.consumer, "GET", "/v1/costs/team:a")).body.split.usd,
    ).toBe(0.414)
    // the agent sees today's of its own
    const me = (await as(a, "GET", "/v1/me")).body.cost
    expect(me.today_split).toMatchObject({ usd: 0.138, cache_write_usd: 0.075 })
    expect(me.today_causes.map((c: any) => [c.cause, c.usd])).toEqual([
      ["owner", 0.138],
    ])
    expect((await as(b, "GET", "/v1/me")).body.cost.today_split.usd).toBe(0)
  })

  test("the days go with history_days, the whole stays; a rename moves it, an unregistering keeps it", async () => {
    await report(t, HOST, [started("user"), step(0.276)])
    await owner("PATCH", "/v1/settings", {
      server: { history_days: 1, expire_after: "90d" },
    })
    t.clock.advance(60 * DAY)
    t.server.maintenance()
    await report(t, HOST, [started("user"), step(0.138)])
    let view = await one()
    expect(view.split).toMatchObject({ usd: 0.414, turns: 2 })
    expect(view.days.map((d: any) => d.split.usd)).toEqual([0.138])
    expect((await one("?days=31")).split.usd).toBe(0.138)
    // renamed: its numbers come along, and join what the new ID had
    const res = await owner("POST", "/v1/agents/team:a/rename", {
      id: "team:lead",
    })
    expect(res.status).toBe(200)
    view = (await owner("GET", "/v1/costs/team:lead")).body
    expect(view.split).toMatchObject({ usd: 0.414, turns: 2 })
    expect(view.causes.map((c: any) => [c.cause, c.turns, c.usd])).toEqual([
      ["owner", 2, 0.414],
    ])
    // unregistered: kept, like its spend
    await owner("DELETE", "/v1/agents/team:lead")
    view = (await owner("GET", "/v1/costs/team:lead")).body
    expect(view.registered).toBe(false)
    expect(view.split.usd).toBe(0.414)
  })

  test("a run's steps count for the agent that started it, under their own cause", async () => {
    await owner("PUT", "/v1/jobs/mail", {
      host: HOST,
      model: "fake/main",
      prompt: "Summarize the mail.",
      trigger: "fire-only",
    })
    expect((await as(a, "POST", "/v1/jobs/mail/run", {})).status).toBe(201)
    // the spawn, then the run's prompt
    for (let n = 0; n < 2; n++) {
      t.server.tick()
      for (const i of await instructions(t, HOST))
        await ack(
          t,
          HOST,
          i.id,
          i.type === "spawn" ? { session: "ses_run" } : { ok: true },
        )
    }
    await sessionToken(t, HOST, "ses_run")
    await report(t, HOST, [
      started("user", undefined, "ses_run"),
      step(0.138, { session: "ses_run" }),
      step(0.138, { session: "ses_run" }),
    ])
    expect(await causes()).toEqual({ run: [1, 0.276] })
    expect((await one()).split).toMatchObject({
      usd: 0.276,
      reload_usd: 0.108,
      turns: 1,
    })
  })
})
