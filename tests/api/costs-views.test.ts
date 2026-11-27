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
      // none of it its runs' (the owner, 2026-11-09)
      runs_today_usd: 0,
      runs_total_usd: 0,
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

  // The owner, 2026-11-08: "90%" of a 1,000,000 window showed as 500K. A
  // share alone is that share of the window; only "max N" caps it.
  test("a share alone is that share of the window, not capped; max N caps it", async () => {
    const big = { ...step(0.01, 300_000), limit: 1_000_000 }
    await report(t, HOST, [big])
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { compact_at: "90%" } },
    })
    let cost = (await owner("GET", "/v1/agents/team:a")).body.agent.cost
    expect(cost).toMatchObject({ compact_at: 900_000, context_share: 33.3 })
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { compact_at: "90% max 600000" } },
    })
    cost = (await owner("GET", "/v1/agents/team:a")).body.agent.cost
    expect(cost.compact_at).toBe(600_000)
    // the default keeps its own cap: 50% of 1,000,000, at most 500,000
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { compact_at: null } },
    })
    cost = (await owner("GET", "/v1/agents/team:a")).body.agent.cost
    expect(cost.compact_at).toBe(500_000)
  })

  // 1.1.0-rc7: a threshold for the sessions on a model, after the default.
  test("compact_at by model: the entry of the agent's model holds, and follows its model", async () => {
    const set = "50% max 500000, */gpt-6.2-*=30000"
    const patched = await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { compact_at: ` ${set.replace("=", " = ")} ` } },
    })
    expect(patched.status).toBe(200)
    expect(
      (await owner("GET", "/v1/settings?agent=team:a")).body.values.compact_at,
    ).toBe(set)
    // no model known yet: the default (no window either: its cap)
    let cost = (await owner("GET", "/v1/agents/team:a")).body.agent.cost
    expect(cost.compact_at).toBe(500_000)
    // on another model: the default, 50% of its window
    await report(t, HOST, [step(0.01, 40_000)])
    cost = (await owner("GET", "/v1/agents/team:a")).body.agent.cost
    expect(cost).toMatchObject({ compact_at: 100_000, context_share: 40 })
    // on a model of the entry: its threshold, from that step on
    await report(t, HOST, [
      { ...step(0.01, 40_000), model: "hub/openai/gpt-6.2-astra" },
    ])
    cost = (await owner("GET", "/v1/agents/team:a")).body.agent.cost
    expect(cost).toMatchObject({ compact_at: 30_000, context_share: 133.3 })
    expect((await as(a, "GET", "/v1/me")).body.cost.compact_at).toBe(30_000)
    // and back
    await report(t, HOST, [step(0.01, 40_000)])
    cost = (await owner("GET", "/v1/agents/team:a")).body.agent.cost
    expect(cost.compact_at).toBe(100_000)
    // a bad entry is refused, and says which
    const bad = await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { compact_at: "50%, a/b=5" } },
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe("bad_setting")
    expect(bad.body.error.message).toContain("a/b")
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
/*
 * 1.1.0 (the owner, 2026-11-20, from the review of real sessions: agents
 * called autocode_me status in 176 of 235 hourly turns to learn these): the
 * last line of a prompt says the server's time, the context against
 * compact_at and today's spend against the cap.
 */
describe("a prompt's status line", () => {
  // The status line of the prompt a fired wake brings, without the help
  // pointer that ends it.
  async function line(): Promise<string> {
    await owner("POST", "/v1/agents/team:a/wakes/w/fire")
    t.clock.advance(2000)
    t.server.tick()
    const [prompt] = (await instructions(t, HOST)).filter(
      (i) => i.type === "inject",
    )
    await ack(t, HOST, prompt.id, { ok: true })
    await report(t, HOST, [
      { type: "turn.started", session: "ses_a" },
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    const lines: string[] = prompt.payload.text.split("\n")
    // the last line; it ends with how to get help (1.1.0-rc5: no footer)
    const help = ' "autocode_me action=help" for more info.'
    expect(lines.at(-1)).toEndWith(help)
    expect(lines.at(-2)).toBe("")
    return lines.at(-1)!.slice(0, -help.length)
  }

  test("the time, the context with its share of compact_at, the spend and the cap", async () => {
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "fire-only" })
    // nothing known yet: the time and the spend
    expect(await line()).toBe(
      "Server time 2026-10-28 05:00 PDT. Cost today: $0.00 (no daily cap).",
    )
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { daily_usd: 1000, compact_at: 500_000 } },
    })
    await report(t, HOST, [step(41.2, 331_204)])
    expect(await line()).toBe(
      "Server time 2026-10-28 05:00 PDT. Context: 331,204 tokens, 66.2% " +
        "of compact_at (500,000). Cost today: $41.20 of your daily cap of " +
        "$1000.00.",
    )
    // the same numbers as the agent's status
    expect((await as(a, "GET", "/v1/me")).body.cost).toMatchObject({
      today_usd: 41.2,
      context: 331_204,
      compact_at: 500_000,
      context_share: 66.2,
    })
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { daily_usd: "off", compact_at: "off" } },
    })
    expect(await line()).toBe(
      "Server time 2026-10-28 05:00 PDT. Context: 331,204 tokens " +
        "(compact_at off). Cost today: $41.20 (no daily cap).",
    )
  })

  test("a message's prompt and a notice have it too", async () => {
    await owner("POST", "/v1/messages", { to: "team:a", text: "Hello." })
    t.server.tick()
    const [prompt] = (await instructions(t, HOST)).filter(
      (i) => i.type === "inject",
    )
    expect(prompt.payload.text.split("\n").at(-1)).toBe(
      "Server time 2026-10-28 05:00 PDT. Cost today: $0.00 (no daily cap). " +
        '"autocode_me action=help" for more info.',
    )
  })
})

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

// The owner, 2026-11-17: "add col in agents tab for model effort": the
// variant of the agent's model, from its last step.
describe("an agent's model effort", () => {
  const effort = async () =>
    (await owner("GET", "/v1/agents/team:a")).body.agent.effort

  test("the last step's effort is the agent's, on its view and /v1/me; \"\" forgets it", async () => {
    expect(await effort()).toBe(null)
    await report(t, HOST, [{ ...step(0.1), effort: "high" }])
    expect(await effort()).toBe("high")
    expect((await owner("GET", "/v1/agents")).body.agents[0].effort).toBe(
      "high",
    )
    expect((await as(a, "GET", "/v1/me")).body.agent.effort).toBe("high")
    await report(t, HOST, [{ ...step(0.1), effort: " max " }])
    expect(await effort()).toBe("max")
    // the model runs with no variant now
    await report(t, HOST, [{ ...step(0.1), effort: "" }])
    expect(await effort()).toBe(null)
  })

  test("a step that does not say it, a Subagent's, or a bad one keeps the agent's effort", async () => {
    await report(t, HOST, [{ ...step(0.1), effort: "high" }])
    // an older plugin, or the default model: nothing said
    await report(t, HOST, [step(0.1)])
    expect(await effort()).toBe("high")
    // a Subagent's step carries no context: its effort is not the agent's
    await report(t, HOST, [{ ...step(0.1), context: undefined, effort: "low" }])
    expect(await effort()).toBe("high")
    await report(t, HOST, [{ ...step(0.1), effort: "x".repeat(101) }])
    await report(t, HOST, [{ ...step(0.1), effort: 5 }])
    expect(await effort()).toBe("high")
  })
})

// The owner, 2026-11-17: the model's name as OpenCode has it ("Fable 5.2"
// for claude-agent/fable), beside its ID.
describe("an agent's model name", () => {
  const view = async () => {
    const a = (await owner("GET", "/v1/agents/team:a")).body.agent
    return [a.model, a.model_name]
  }

  test("the last step's model name is the agent's, on its views; \"\" forgets it", async () => {
    expect(await view()).toEqual([null, null])
    await report(t, HOST, [{ ...step(0.1), model_name: " Fake Main " }])
    expect(await view()).toEqual(["fake/main", "Fake Main"])
    expect((await owner("GET", "/v1/agents")).body.agents[0].model_name).toBe(
      "Fake Main",
    )
    expect((await as(a, "GET", "/v1/me")).body.agent.model_name).toBe(
      "Fake Main",
    )
    // OpenCode's list has no name for it any more
    await report(t, HOST, [{ ...step(0.1), model_name: "" }])
    expect(await view()).toEqual(["fake/main", null])
  })

  test("a step that does not say it keeps the name of the same model, and drops it with another model", async () => {
    await report(t, HOST, [{ ...step(0.1), model_name: "Fake Main" }])
    // the list could not be read, or an older plugin: nothing said
    await report(t, HOST, [step(0.1)])
    expect(await view()).toEqual(["fake/main", "Fake Main"])
    // a Subagent's step (no context of the agent's) and a bad name change
    // nothing
    await report(t, HOST, [
      {
        ...step(0.1),
        context: undefined,
        model: "fake/sub",
        model_name: "Sub",
      },
    ])
    await report(t, HOST, [{ ...step(0.1), model_name: "x".repeat(101) }])
    await report(t, HOST, [{ ...step(0.1), model_name: 5 }])
    expect(await view()).toEqual(["fake/main", "Fake Main"])
    // another model, and no name with it: the old name is not its name
    await report(t, HOST, [{ ...step(0.1), model: "fake/other" }])
    expect(await view()).toEqual(["fake/other", null])
  })
})

/*
 * The owner, 2026-11-17, looking at build 71: "why some models say
 * bedrock-claude-opus-5-5 (aws/anthropic), some just bedrock-claude-opus-5-5?"
 * An agent had the name only after its own next step. A model's name is the
 * model's: an agent that has not said it shows the one another agent's step
 * gave that model.
 */
describe("the same model's name for every agent", () => {
  test("an agent that has not said its model's name shows the model's known name", async () => {
    await registered(t, HOST, "ses_b", "team:b")
    const b = async () => {
      const x = (await owner("GET", "/v1/agents/team:b")).body.agent
      return [x.model, x.model_name]
    }
    // its step says the model, not the name (an older plugin, or the list
    // could not be read)
    await report(t, HOST, [step(0.1, 1000, "ses_b")])
    expect(await b()).toEqual(["fake/main", null])
    await report(t, HOST, [{ ...step(0.1), model_name: "Fake Main" }])
    expect(await b()).toEqual(["fake/main", "Fake Main"])
    const all = (await owner("GET", "/v1/agents")).body.agents
    expect(all.map((x: any) => x.model_name)).toEqual([
      "Fake Main",
      "Fake Main",
    ])
    // on another model, it has no name from that one
    await report(t, HOST, [
      { ...step(0.1, 1000, "ses_b"), model: "fake/other" },
    ])
    expect(await b()).toEqual(["fake/other", null])
  })
})

/*
 * The owner, 2026-11-17: "i want models/efforts tho be shown in the same way
 * on agents and jobs tabs". A job's model has no session of its own to say
 * its name, so the server keeps each model's name by its ID, from any
 * agent's step, past that agent's unregistering, and a job's view says it.
 */
describe("a job's model name", () => {
  const JOB = {
    host: HOST,
    description: "Summarizes the day's mail",
    model: "fake/main",
    prompt: "Summarize today's mail in five lines.",
    trigger: "fire-only",
    to: "owner",
  }
  const named = async (job: string) =>
    (await owner("GET", "/v1/jobs")).body.jobs.find((j: any) => j.name === job)
      .model_name

  test("the name any agent's step gave the model, kept when that agent is gone", async () => {
    expect((await owner("PUT", "/v1/jobs/mail", JOB)).status).toBe(201)
    expect(await named("mail")).toBeNull()
    await report(t, HOST, [{ ...step(0.1), model_name: "Fake Main" }])
    expect(await named("mail")).toBe("Fake Main")
    // and where a job is set: its view says the name at once
    const again = await owner("PUT", "/v1/jobs/mail", JOB)
    expect(again.body.job.model_name).toBe("Fake Main")
    // a job on another model has no name from it
    await owner("PUT", "/v1/jobs/other", { ...JOB, model: "fake/other" })
    expect(await named("other")).toBeNull()
    await owner("DELETE", "/v1/agents/team:a")
    expect(await named("mail")).toBe("Fake Main")
  })

  test('a new name replaces it, and "" forgets it', async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await report(t, HOST, [{ ...step(0.1), model_name: "Fake Main" }])
    await report(t, HOST, [{ ...step(0.1), model_name: "Fake Main 2" }])
    expect(await named("mail")).toBe("Fake Main 2")
    // OpenCode's list has no name for it any more
    await report(t, HOST, [{ ...step(0.1), model_name: "" }])
    expect(await named("mail")).toBeNull()
    // a Subagent's step names its own model (no context of the agent's)
    await report(t, HOST, [
      {
        ...step(0.1),
        context: undefined,
        model: "fake/sub",
        model_name: "Sub",
      },
    ])
    await owner("PUT", "/v1/jobs/sub", { ...JOB, model: "fake/sub" })
    expect(await named("sub")).toBe("Sub")
  })
})

// The owner, 2026-11-08: unregistered agents on Agents too (a box), and
// Costs' Total over the last X days.
describe("unregistered agents and days", () => {
  test("GET /v1/agents?unregistered=1 adds the IDs that spent and are gone, marked, with their last machine", async () => {
    await registered(t, HOST, "ses_b", "team:b")
    await report(t, HOST, [step(0.2, 1000, "ses_b")])
    await owner("DELETE", "/v1/agents/team:b")
    const plain = (await owner("GET", "/v1/agents")).body.agents
    expect(plain.map((x: any) => x.id)).toEqual(["team:a"])
    const all = (await owner("GET", "/v1/agents?unregistered=1")).body.agents
    expect(all.map((x: any) => [x.id, x.status])).toEqual([
      ["team:a", "idle"],
      ["team:b", "unregistered"],
    ])
    expect(all[1]).toMatchObject({
      registered: false,
      cost: { total_usd: 0.2 },
    })
    expect(all[1].machine).toBe("m")
    // a pattern applies to both
    const one = (await owner("GET", "/v1/agents?unregistered=1&match=team:b"))
      .body.agents
    expect(one.map((x: any) => x.id)).toEqual(["team:b"])
    // agents themselves see only registered ones
    const mine = (await as(a, "GET", "/v1/agents?unregistered=1")).body.agents
    expect(mine.map((x: any) => x.id)).toEqual(["team:a"])
  })

  test("/v1/costs?days=X: Total and the totals over the last X days; gone agents without spend then drop out", async () => {
    await registered(t, HOST, "ses_b", "team:b")
    await report(t, HOST, [step(1), step(0.5, 1000, "ses_b")])
    await owner("DELETE", "/v1/agents/team:b")
    t.clock.advance(3 * DAY)
    await report(t, HOST, [step(0.25)])
    const week = (await owner("GET", "/v1/costs?days=7")).body
    expect(week.days).toBe(7)
    expect(week.agents.map((x: any) => [x.agent, x.total_usd])).toEqual([
      ["team:a", 1.25],
      ["team:b", 0.5],
    ])
    const two = (await owner("GET", "/v1/costs?days=2")).body
    // team:a keeps its row (registered); team:b spent nothing in 2 days
    expect(two.agents.map((x: any) => [x.agent, x.total_usd])).toEqual([
      ["team:a", 0.25],
    ])
    expect(two.totals).toEqual({ agents: 1, today_usd: 0.25, total_usd: 0.25 })
    // all time without days; bad days refused
    expect((await owner("GET", "/v1/costs")).body.days).toBeNull()
    expect((await owner("GET", "/v1/costs?days=0")).status).toBe(400)
    expect((await owner("GET", "/v1/costs?days=x")).status).toBe(400)
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
    // the server's time, for the Costs tab's clock (the owner, 2026-11-08)
    expect(all.time).toBe(new Date(t.clock.now()).toISOString())
    const one = (await owner("GET", "/v1/costs/team:a")).body
    expect(one.agent).toBe("team:a")
    expect(one.cost).toMatchObject({ today_usd: 0.05, total_usd: 0.35 })
    expect(one.days).toEqual([
      { day: all.day, usd: 0.05, steps: 1 },
      { day: expect.any(String), usd: 0.3, steps: 1 },
    ])
    expect(one.days[1].day < one.days[0].day).toBe(true)
  })

  // The owner, 2026-11-09: the Costs tab's Last 7 Days, a bar per day.
  test("each agent's last 7 days (up to: from its first day), oldest first, today last, days without spend 0", async () => {
    await registered(t, HOST, "ses_b", "team:b")
    await registered(t, HOST, "ses_c", "team:c")
    // 2026-10-28 in the server's zone
    await report(t, HOST, [step(1), step(0.5, 1000, "ses_b")])
    await owner("DELETE", "/v1/agents/team:b")
    t.clock.advance(2 * DAY)
    await report(t, HOST, [step(0.25), step(0.125)])
    const week = (id: string, body: any) =>
      body.agents.find((x: any) => x.agent === id).week
    let all = (await owner("GET", "/v1/costs")).body
    expect(week("team:a", all)).toEqual([
      { day: "2026-10-28", usd: 1 },
      { day: "2026-10-29", usd: 0 },
      { day: "2026-10-30", usd: 0.375 },
    ])
    // a gone agent's too; one that never spent has none
    expect(week("team:b", all)).toEqual([
      { day: "2026-10-28", usd: 0.5 },
      { day: "2026-10-29", usd: 0 },
      { day: "2026-10-30", usd: 0 },
    ])
    expect(week("team:c", all)).toEqual([])
    // a week on, across the change from summer time: seven days, today last
    t.clock.advance(7 * DAY)
    all = (await owner("GET", "/v1/costs?days=2")).body
    expect(week("team:a", all).map((d: any) => d.day)).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
    ])
    expect(week("team:a", all).every((d: any) => d.usd === 0)).toBe(true)
    expect(all.day).toBe("2026-11-06")
    // late on the day summer time ends (01-Nov, 25 hours): each day once
    t.clock.t = Date.parse("2026-11-02T07:30:00Z")
    all = (await owner("GET", "/v1/costs")).body
    expect(all.day).toBe("2026-11-01")
    expect(week("team:a", all).map((d: any) => d.day)).toEqual([
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ])
    // ?days= counts calendar days too: 30-Oct to 01-Nov
    all = (await owner("GET", "/v1/costs?days=3")).body
    expect(all.agents.find((x: any) => x.agent === "team:a").total_usd).toBe(
      0.375,
    )
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
