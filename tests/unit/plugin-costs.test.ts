/*
 * The plugin's tier 0e parts: a model step (OpenCode's session.step.ended)
 * becomes a cost event with its context (input plus cache reads and writes)
 * and the model's window; autocode_me compact asks for a compaction after
 * the turn, and status says the spend and the cap.
 */
import { describe, expect, test } from "bun:test"
import { costEvent, nameOf, ratesOf, windowOf } from "../../plugin/src/costs.ts"
import { guideText, helpText, TOPICS } from "../../plugin/src/guide.ts"
import { ME_TOOL, runMe } from "../../plugin/src/tools.ts"

const STEP = {
  type: "session.step.ended",
  data: {
    sessionID: "ses_a",
    assistantMessageID: "msg_1",
    finish: "stop",
    cost: 0.0123,
    tokens: {
      input: 1200,
      output: 300,
      reasoning: 0,
      cache: { read: 50_000, write: 2000 },
    },
  },
}

describe("cost events", () => {
  test("a step: its cost and context, the model and its window", () => {
    expect(
      costEvent("ses_a", STEP.data, {
        model: "fake/main",
        limit: 200_000,
      }),
    ).toEqual({
      type: "cost",
      session: "ses_a",
      step: "msg_1",
      usd: 0.0123,
      context: 53_200,
      // by kind (1.1.0-rc7): the cache's reads and writes apart
      tokens: { input: 1200, output: 300, read: 50_000, write: 2000 },
      model: "fake/main",
      limit: 200_000,
    })
  })

  // 1.1.0-rc7: what a step's dollars are (cache writes, cache reads, new
  // input, output), from its tokens and the model's prices.
  test("a step says its tokens by kind, reasoning with the output, and the model's rates", () => {
    const data = {
      ...STEP.data,
      tokens: {
        input: 2,
        output: 1101,
        reasoning: 1178,
        cache: { read: 656_650, write: 1422 },
      },
    }
    const rates = { input: 5, output: 25, read: 0.5, write: 6.25 }
    expect(
      costEvent("ses_a", data, { model: "fake/main", rates }),
    ).toMatchObject({
      context: 658_074,
      tokens: { input: 2, output: 2279, read: 656_650, write: 1422 },
      rates,
    })
    // no rates known: the tokens alone
    const bare = costEvent("ses_a", data, { model: "fake/main" })!
    expect(bare.tokens).toEqual({
      input: 2,
      output: 2279,
      read: 656_650,
      write: 1422,
    })
    expect("rates" in bare).toBe(false)
    // tokens that are no numbers count as none
    expect(
      costEvent(
        "ses_a",
        { ...STEP.data, tokens: { input: "x", output: -3, cache: {} } },
        {},
      )!.tokens,
    ).toEqual({ input: 0, output: 0, read: 0, write: 0 })
  })

  test("a model's rates from OpenCode's list: the entry without a tier, dollars per million tokens", () => {
    const base = { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }
    const tier = {
      tier: { type: "context", size: 200_000 },
      input: 6,
      output: 22.5,
      cache: { read: 0.6, write: 7.5 },
    }
    const models = [
      { providerID: "fake", id: "tiers", cost: [tier, base] },
      { providerID: "fake", id: "only-tiers", cost: [tier] },
      { providerID: "fake", id: "plain", cost: base },
      { providerID: "fake", id: "free", cost: [] },
      {
        providerID: "fake",
        id: "zero",
        cost: [{ ...base, input: 0, output: 0, cache: { read: 0, write: 0 } }],
      },
      {
        providerID: "fake",
        id: "odd",
        cost: [{ input: "3", output: 15, cache: {} }],
      },
      { providerID: "fake", id: "none" },
    ]
    const want = { input: 3, output: 15, read: 0.3, write: 3.75 }
    const of = (id: string) => ratesOf(models, { providerID: "fake", id })
    expect(of("tiers")).toEqual(want)
    // only tiers: the first one
    expect(of("only-tiers")).toEqual({
      input: 6,
      output: 22.5,
      read: 0.6,
      write: 7.5,
    })
    // an older shape: one entry, not a list
    expect(of("plain")).toEqual(want)
    for (const id of ["free", "zero", "odd", "none", "missing"])
      expect(of(id)).toBeUndefined()
    expect(ratesOf(models, undefined)).toBeUndefined()
  })

  // The owner, 2026-11-17: "add col in agents tab for model effort": the
  // session's model variant, as OpenCode names it (high, max...).
  test('a step says its model\'s effort: the variant, none (""), or not known', () => {
    expect(
      costEvent("ses_a", STEP.data, { model: "fake/main", effort: "high" }),
    ).toMatchObject({ model: "fake/main", effort: "high" })
    // the session's model has no variant: said, so the server forgets one
    expect(
      costEvent("ses_a", STEP.data, { model: "fake/main", effort: "" }),
    ).toMatchObject({ effort: "" })
    // not known (the model is OpenCode's default one): nothing said
    expect(
      "effort" in costEvent("ses_a", STEP.data, { model: "fake/main" })!,
    ).toBe(false)
  })

  // 1.1.0-rc2, exact attribution (the owner, 2026-11-21): a Subagent's
  // step says its own session, so that it counts for the wake whose turn
  // started the Subagent
  test("a Subagent's step says its own session; the session's own step says none", () => {
    const data = { cost: 0.5, tokens: { input: 10 }, assistantMessageID: "m1" }
    expect(costEvent("ses_root", data, {}, "ses_child")).toMatchObject({
      type: "cost",
      session: "ses_root",
      sub: "ses_child",
      usd: 0.5,
    })
    expect(costEvent("ses_root", data, {}, "ses_root")).not.toHaveProperty(
      "sub",
    )
    expect(costEvent("ses_root", data, {})).not.toHaveProperty("sub")
  })

  test("a step without a cost or tokens is none", () => {
    expect(costEvent("ses_a", { ...STEP.data, cost: "x" }, {})).toBeUndefined()
    expect(
      costEvent("ses_a", { ...STEP.data, tokens: undefined }, {}),
    ).toMatchObject({ usd: 0.0123, context: 0 })
  })

  /*
   * The owner, 2026-11-17: "why i see claude-agent/fable for this agent (why
   * it doesnt say fable 5.2)?": OpenCode's model list has each model's name
   * ("Fable 5.2" for the ID fable); the step says it with the model.
   */
  test('a step says its model\'s name; none ("") when the list has none; not known without the list', () => {
    expect(
      costEvent("ses_a", STEP.data, { model: "prov/fable", name: "Fable 5.2" }),
    ).toMatchObject({ model: "prov/fable", model_name: "Fable 5.2" })
    expect(
      costEvent("ses_a", STEP.data, { model: "prov/fable", name: "" }),
    ).toMatchObject({ model: "prov/fable", model_name: "" })
    expect(
      "model_name" in costEvent("ses_a", STEP.data, { model: "prov/fable" })!,
    ).toBe(false)
    // never a name without its model
    expect(
      "model_name" in costEvent("ses_a", STEP.data, { name: "Fable 5.2" })!,
    ).toBe(false)
  })

  test("the name of a model from OpenCode's list", () => {
    const models = [
      { id: "fable", providerID: "prov", name: " Fable 5.2 " },
      { id: "plain", providerID: "prov" },
      { id: "odd", providerID: "prov", name: 7 },
    ]
    expect(nameOf(models, { providerID: "prov", id: "fable" })).toBe(
      "Fable 5.2",
    )
    expect(nameOf(models, { providerID: "prov", id: "plain" })).toBe("")
    expect(nameOf(models, { providerID: "prov", id: "odd" })).toBe("")
    // not in the list (or no list): not known
    expect(nameOf(models, { providerID: "x", id: "fable" })).toBeUndefined()
    expect(nameOf([], undefined)).toBeUndefined()
  })

  test("the window of a model from OpenCode's list", () => {
    const models = [
      { id: "main", providerID: "fake", limit: { context: 200_000 } },
      { id: "big", providerID: "fake", limit: { context: 1_000_000 } },
    ]
    expect(windowOf(models, { providerID: "fake", id: "big" })).toBe(1_000_000)
    expect(windowOf(models, { providerID: "x", id: "main" })).toBeUndefined()
  })
})

describe("autocode_me compact and status", () => {
  test("compact is an action; it asks for one after the turn", async () => {
    expect((ME_TOOL.input.properties.action as any).enum).toContain("compact")
    expect(ME_TOOL.description).toContain("compact")
    const calls: string[] = []
    const call = async (method: string, path: string) => {
      calls.push(`${method} ${path}`)
      return { compact: "after this turn" }
    }
    expect(await runMe({ action: "compact" }, call as any)).toBe(
      "Your session is compacted after this turn ends (a summary replaces " +
        "the conversation; keep your state in files).",
    )
    expect(calls).toEqual(["POST /v1/me/compact"])
  })

  test("status says today's spend, the cap and the context", async () => {
    const call = async () => ({
      registered: true,
      session: "ses_a",
      agent: { id: "team:a", status: "idle", machine: "m1" },
      server: {
        id: "s",
        time: "2026-10-28T12:00:00.000Z",
        timezone: "America/Los_Angeles",
      },
      settings: { min_interval: "1m" },
      wakes: { count: 0, next: null },
      waiting: 0,
      cost: {
        today_usd: 0.4567,
        total_usd: 12.3456,
        daily_usd: 2,
        left_usd: 1.5433,
        context: 53_200,
        context_limit: 200_000,
        compact_at: 100_000,
        context_share: 53.2,
      },
    })
    // tier 0g: the total, what is left, and the share of the threshold
    expect(await runMe({ action: "status" }, call as any)).toContain(
      "Cost today: $0.46 of your daily cap of $2.00 ($1.54 left); in total " +
        "$12.35. Context: 53,200 tokens of the model's 200,000; compacted " +
        "past 100,000 (compact_at): 53.2% of that.",
    )
  })

  // 1.1.0-rc7: what today's dollars were, and what started the turns.
  test("status says today's spend by kind, the Subagents' part, and by what started the turn", async () => {
    const me = (cost: Record<string, unknown>) => async () => ({
      registered: true,
      session: "ses_a",
      agent: { id: "team:a", status: "idle", machine: "m1" },
      server: {
        id: "s",
        time: "2026-10-28T12:00:00.000Z",
        timezone: "America/Los_Angeles",
      },
      settings: { min_interval: "1m" },
      wakes: { count: 0, next: null },
      waiting: 0,
      cost: { today_usd: 20, total_usd: 40, daily_usd: "off", ...cost },
    })
    const split = {
      usd: 20,
      cache_write_usd: 9,
      cache_read_usd: 5.8,
      input_usd: 0.2,
      output_usd: 4.8,
      subagents_usd: 3.2,
      reload_usd: 6,
      turns: 18,
    }
    const causes = [
      { cause: "owner", turns: 9, usd: 12, reload_usd: 1.5 },
      { cause: "message", turns: 7, usd: 5, reload_usd: 2 },
      { cause: "wake", turns: 2, usd: 3, reload_usd: 2.5 },
      { cause: "earlier", turns: 0, usd: 0.001, reload_usd: 0 },
    ]
    const text = await runMe(
      { action: "status" },
      me({ today_split: split, today_causes: causes }) as any,
    )
    expect(text).toContain(
      "Today by kind: cache writes $9.00 (45%), cache reads $5.80 (29%), " +
        "new input $0.20 (1%), output $4.80 (24%); not split $0.20 (1%). " +
        "Your Subagents: $3.20 (16%). Reloading the context at the start " +
        "of turns: $6.00 (30%).",
    )
    expect(text).toContain(
      "Today by what started the turn: owner $12.00 in 9 turns, message " +
        "$5.00 in 7, wake $3.00 in 2.",
    )
    // nothing to say: no lines; an older server says neither
    const none = await runMe(
      { action: "status" },
      me({
        today_split: { ...split, usd: 0 },
        today_causes: [],
      }) as any,
    )
    expect(none).not.toContain("Today by")
    expect(await runMe({ action: "status" }, me({}) as any)).not.toContain(
      "Today by",
    )
    // all of it one kind's, nothing else: said plainly
    const plain = await runMe(
      { action: "status" },
      me({
        today_split: {
          usd: 1,
          cache_write_usd: 0,
          cache_read_usd: 0,
          input_usd: 0,
          output_usd: 0,
          subagents_usd: 0,
          reload_usd: 0,
          turns: 1,
        },
        today_causes: [{ cause: "owner", turns: 1, usd: 1, reload_usd: 0 }],
      }) as any,
    )
    expect(plain).toContain(
      "Today by kind: not split $1.00 (100%; the model has no prices in " +
        "OpenCode's list).",
    )
    expect(plain).toContain(
      "Today by what started the turn: owner $1.00 in 1 turn.",
    )
    // what has no turn of the session (its jobs' runs, a compaction's own
    // cost) says no "in 0 turns"
    const mixed = await runMe(
      { action: "status" },
      me({
        today_split: split,
        today_causes: [
          { cause: "run", turns: 0, usd: 9, reload_usd: 0 },
          { cause: "owner", turns: 3, usd: 6, reload_usd: 1 },
          { cause: "earlier", turns: 0, usd: 3, reload_usd: 0 },
          { cause: "wake", turns: 1, usd: 2, reload_usd: 1 },
        ],
      }) as any,
    )
    expect(mixed).toContain(
      "Today by what started the turn: run $9.00, owner $6.00 in 3 turns, " +
        "earlier $3.00, wake $2.00 in 1.",
    )
  })

  test("status without a cap, a known window or a threshold", async () => {
    const call = async () => ({
      registered: true,
      session: "ses_a",
      agent: { id: "team:a", status: "idle", machine: "m1" },
      server: {
        id: "s",
        time: "2026-10-28T12:00:00.000Z",
        timezone: "America/Los_Angeles",
      },
      settings: { min_interval: "1m" },
      wakes: { count: 0, next: null },
      waiting: 0,
      cost: {
        today_usd: 0.1,
        total_usd: 0.1,
        daily_usd: "off",
        left_usd: null,
        context: 9000,
        context_limit: null,
        compact_at: null,
        context_share: null,
      },
    })
    expect(await runMe({ action: "status" }, call as any)).toContain(
      "Cost today: $0.10 (no daily cap); in total $0.10. Context: 9,000 " +
        "tokens; no compaction threshold (compact_at off).",
    )
  })
})

// The owner, 2026-11-09 (rc2): a run an agent starts counts for it; status
// says how much of its spend was its runs'.
test("status says how much of the spend was its runs'", async () => {
  const call = async () => ({
    registered: true,
    session: "ses_a",
    agent: { id: "a:b", description: "", status: "idle", machine: "m" },
    server: {
      id: "s",
      time: "2026-10-28T12:00:00.000Z",
      timezone: "UTC",
    },
    settings: { min_interval: "1m" },
    wakes: { count: 0, next: null },
    waiting: 0,
    cost: {
      today_usd: 0.5,
      total_usd: 1.5,
      runs_today_usd: 0.4,
      runs_total_usd: 1.2,
      daily_usd: "off",
      left_usd: null,
      context: null,
      context_limit: null,
      compact_at: null,
      context_share: null,
    },
  })
  expect(await runMe({ action: "status" }, call as any)).toContain(
    "Cost today: $0.50 (no daily cap; $0.40 of it your runs'); in total " +
      "$1.50 ($1.20 your runs').",
  )
})

describe("the guide's costs part", () => {
  test("the daily cap, its warning and pause, compaction, resume, expiry", () => {
    expect(TOPICS).toContain("costs")
    const facts = {
      serverId: "api-test",
      url: "http://server:4848",
      shellValues: true,
      tools: [],
    }
    const part = helpText(facts, "costs").replace(/\s+/g, " ")
    for (const answer of [
      "`daily_usd`",
      "`cap_warn`",
      "`[autocode] cost warning`",
      "paused after the turn",
      "the server's zone",
      "`compact_at`",
      "autocode_me action=compact",
      "keep your working state in files",
      "`expire_after`",
      // tier 0g: the notice before a compaction, and the numbers in status
      "`[autocode] compaction next`",
      "bring your work to a stable state",
      // the owner, 2026-11-09: it comes even with nothing waiting for you
      "even when nothing else waits for you",
      "in total",
      "what is left",
      "its share",
    ])
      expect(part, answer).toContain(answer)
    // the prompt list names the notice too
    expect(guideText(facts).replace(/\s+/g, " ")).toContain(
      "`[autocode] compaction next`: your session is compacted when this turn",
    )
    expect(guideText(facts)).toContain("## Costs and Context")
    expect(guideText(facts).replace(/\s+/g, " ")).toContain(
      "`[autocode] resume`",
    )
    // the registering part says the IDs without a project's name
    expect(guideText(facts)).not.toContain("kaggle")
  })
})

// The adversarial review of 0e: a cap's pause says how it ends.
describe("review of 0e: status of a cap's pause", () => {
  test("paused by the daily cap: until tomorrow or a higher cap", async () => {
    const call = async () => ({
      registered: true,
      session: "ses_a",
      agent: { id: "team:a", status: "paused", paused: "cap", machine: "m1" },
      server: {
        id: "s",
        time: "2026-10-28T12:00:00.000Z",
        timezone: "America/Los_Angeles",
      },
      settings: { min_interval: "1m" },
      wakes: { count: 0, next: null },
      waiting: 0,
    })
    expect(await runMe({ action: "status" }, call as any)).toContain(
      "Status paused by your daily cost cap: nothing is delivered until " +
        "tomorrow (the server's zone) or until the owner raises the cap.",
    )
  })
})
