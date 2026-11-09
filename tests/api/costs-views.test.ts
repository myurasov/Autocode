/*
 * Tier 0g over the API (the owner, 2026-11-08): each agent's spend and
 * context as the owner and the agent see them. Today, the total (kept past
 * history_days and an unregistering), the daily cap and what is left, the
 * spend per day, the context with its compaction threshold (compact_at
 * resolved for the agent's model) and the share used; GET /v1/costs for
 * every agent, /v1/costs/{agent} with its days, admin and consumer only.
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
const DAY = 86_400_000

const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)

const step = (usd: number, context = 1000, session = "ses_a") => ({
  type: "cost",
  session,
  usd,
  context,
  limit: 200_000,
  model: "fake/main",
})

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

describe("an agent's spend and context", () => {
  test("today, total, the cap and what is left, the context and its share of the threshold", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { daily_usd: 2, compact_at: "50% max 500000" } },
    })
    await report(t, HOST, [step(0.25), step(0.5, 30_000)])
    const view = {
      today_usd: 0.75,
      total_usd: 0.75,
      daily_usd: 2,
      left_usd: 1.25,
      context: 30_000,
      context_limit: 200_000,
      compact_at: 100_000,
      context_share: 30,
    }
    expect((await owner("GET", "/v1/agents/team:a")).body.agent.cost).toEqual(
      view,
    )
    expect((await as(a, "GET", "/v1/me")).body.cost).toEqual(view)
    // the next day: today starts over, the total does not
    t.clock.advance(DAY)
    await report(t, HOST, [step(0.1, 40_000)])
    expect(
      (await owner("GET", "/v1/agents/team:a")).body.agent.cost,
    ).toMatchObject({
      today_usd: 0.1,
      total_usd: 0.85,
      left_usd: 1.9,
      context_share: 40,
    })
  })

  test("no cap, compact_at off or a number of tokens, and no context yet", async () => {
    let cost = (await owner("GET", "/v1/agents/team:a")).body.agent.cost
    // no window known yet: the default's cap (the final review)
    expect(cost).toMatchObject({
      daily_usd: "off",
      left_usd: null,
      context: null,
      compact_at: 500_000,
      context_share: null,
    })
    await owner("PATCH", "/v1/settings", { server: { compact_at: 80_000 } })
    await report(t, HOST, [step(0.01, 20_000)])
    cost = (await owner("GET", "/v1/agents/team:a")).body.agent.cost
    expect(cost).toMatchObject({ compact_at: 80_000, context_share: 25 })
    await owner("PATCH", "/v1/settings", { server: { compact_at: "off" } })
    cost = (await owner("GET", "/v1/agents/team:a")).body.agent.cost
    expect(cost).toMatchObject({ compact_at: null, context_share: null })
  })

  test("what is left is never below zero", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { daily_usd: 1 } },
    })
    await report(t, HOST, [step(1.5)])
    expect(
      (await owner("GET", "/v1/agents/team:a")).body.agent.cost.left_usd,
    ).toBe(0)
  })

  test("the total outlives history_days and an unregistering", async () => {
    await report(t, HOST, [step(0.4)])
    await owner("PATCH", "/v1/settings", {
      server: { history_days: 1, expire_after: "90d" },
    })
    // days are kept history_days, at least 31
    t.clock.advance(60 * DAY)
    t.server.maintenance()
    await report(t, HOST, [step(0.1)])
    let costs = (await owner("GET", "/v1/costs/team:a")).body
    expect(costs.registered).toBe(true)
    expect(costs.cost.total_usd).toBe(0.5)
    // the old day went with the trim; today stays
    expect(costs.days.map((d: any) => d.usd)).toEqual([0.1])
    await owner("DELETE", "/v1/agents/team:a")
    a = await registered(t, HOST, "ses_a", "team:a")
    costs = (await owner("GET", "/v1/costs/team:a")).body
    expect(costs.cost.total_usd).toBe(0.5)
  })
})

// The owner, 2026-11-08: each agent's model, from its last step.
describe("an agent's model", () => {
  test("the last step's model is the agent's, on its view, /v1/me and /v1/costs", async () => {
    expect((await owner("GET", "/v1/agents/team:a")).body.agent.model).toBe(
      null,
    )
    await report(t, HOST, [step(0.1)])
    expect((await owner("GET", "/v1/agents/team:a")).body.agent.model).toBe(
      "fake/main",
    )
    await report(t, HOST, [{ ...step(0.1), model: "prov/other-model" }])
    expect((await owner("GET", "/v1/agents")).body.agents[0].model).toBe(
      "prov/other-model",
    )
    expect((await as(a, "GET", "/v1/me")).body.agent.model).toBe(
      "prov/other-model",
    )
    expect((await owner("GET", "/v1/costs")).body.agents[0].model).toBe(
      "prov/other-model",
    )
  })

  test("a step without a model, or a Subagent's, keeps the agent's model", async () => {
    await report(t, HOST, [step(0.1)])
    const { model: _, ...bare } = step(0.1)
    await report(t, HOST, [bare])
    expect((await owner("GET", "/v1/agents/team:a")).body.agent.model).toBe(
      "fake/main",
    )
    // a Subagent's step carries no context: its model is not the agent's
    await report(t, HOST, [
      { ...step(0.1), context: undefined, model: "prov/sub" },
    ])
    expect((await owner("GET", "/v1/agents/team:a")).body.agent.model).toBe(
      "fake/main",
    )
  })
})

describe("GET /v1/costs", () => {
  test("every agent's numbers, by ID; one agent's with its days, newest first", async () => {
    await registered(t, HOST, "ses_b", "team:b")
    await report(t, HOST, [step(0.3), step(0.2, 1000, "ses_b")])
    t.clock.advance(DAY)
    await report(t, HOST, [step(0.05)])
    const all = (await owner("GET", "/v1/costs")).body
    expect(all.agents.map((x: any) => x.agent)).toEqual(["team:a", "team:b"])
    expect(all.agents[0]).toMatchObject({
      agent: "team:a",
      status: "idle",
      today_usd: 0.05,
      total_usd: 0.35,
    })
    expect(all.day).toMatch(/^\d{4}-\d\d-\d\d$/)
    const one = (await owner("GET", "/v1/costs/team:a")).body
    expect(one.agent).toBe("team:a")
    expect(one.cost).toMatchObject({ today_usd: 0.05, total_usd: 0.35 })
    expect(one.days).toEqual([
      { day: all.day, usd: 0.05, steps: 1 },
      { day: expect.any(String), usd: 0.3, steps: 1 },
    ])
    expect(one.days[1].day < one.days[0].day).toBe(true)
  })

  test("an unknown agent is 404; agents themselves are refused; the consumer reads", async () => {
    expect((await owner("GET", "/v1/costs/team:none")).status).toBe(404)
    expect((await as(a, "GET", "/v1/costs")).status).toBe(403)
    expect((await as(a, "GET", "/v1/costs/team:a")).status).toBe(403)
    expect((await call(t.url, t.consumer, "GET", "/v1/costs")).status).toBe(200)
  })

  // The owner, 2026-11-08: unregistered agents' costs too.
  test("an unregistered agent with spend is listed too, marked, and in one agent's view", async () => {
    await report(t, HOST, [step(0.2)])
    await owner("DELETE", "/v1/agents/team:a")
    const all = (await owner("GET", "/v1/costs")).body
    expect(all.agents).toEqual([
      expect.objectContaining({
        agent: "team:a",
        status: "unregistered",
        registered: false,
        today_usd: 0.2,
        total_usd: 0.2,
      }),
    ])
    const one = (await owner("GET", "/v1/costs/team:a")).body
    expect(one).toMatchObject({
      agent: "team:a",
      registered: false,
      cost: { total_usd: 0.2 },
    })
  })

  test("registered agents without spend are listed; the list is by ID", async () => {
    await registered(t, HOST, "ses_b", "team:b")
    await report(t, HOST, [step(0.1)])
    const all = (await owner("GET", "/v1/costs")).body
    expect(all.agents.map((x: any) => [x.agent, x.registered])).toEqual([
      ["team:a", true],
      ["team:b", true],
    ])
  })

  // The owner, 2026-11-08: a filter by agent pattern, and totals.
  test("?match= filters by an agent pattern; totals add up what is listed", async () => {
    await registered(t, HOST, "ses_b", "team:b")
    await registered(t, HOST, "ses_c", "other:c")
    await report(t, HOST, [
      step(0.5),
      step(0.25, 1000, "ses_b"),
      step(1, 1000, "ses_c"),
    ])
    t.clock.advance(DAY)
    await report(t, HOST, [step(0.1)])
    await owner("DELETE", "/v1/agents/team:b")
    const team = (await owner("GET", "/v1/costs?match=team:*")).body
    expect(team.agents.map((x: any) => x.agent)).toEqual(["team:a", "team:b"])
    expect(team.totals).toEqual({ agents: 2, today_usd: 0.1, total_usd: 0.85 })
    const all = (await owner("GET", "/v1/costs")).body
    expect(all.totals).toEqual({ agents: 3, today_usd: 0.1, total_usd: 1.85 })
    const list = (await owner("GET", "/v1/costs?match=team:a,other:*")).body
    expect(list.agents.map((x: any) => x.agent)).toEqual(["other:c", "team:a"])
    const bad = await owner("GET", "/v1/costs?match=bad pattern!")
    expect(bad.status).toBe(400)
  })
})
