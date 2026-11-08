/*
 * The plugin's tier 0e parts: a model step (OpenCode's session.step.ended)
 * becomes a cost event with its context (input plus cache reads and writes)
 * and the model's window; autocode_me compact asks for a compaction after
 * the turn, and status says the spend and the cap.
 */
import { describe, expect, test } from "bun:test"
import { costEvent, windowOf } from "../../packages/plugin/src/costs.ts"
import { guideText, helpText, TOPICS } from "../../packages/plugin/src/guide.ts"
import { ME_TOOL, runMe } from "../../packages/plugin/src/tools.ts"

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
      model: "fake/main",
      limit: 200_000,
    })
  })

  test("a step without a cost or tokens is none", () => {
    expect(costEvent("ses_a", { ...STEP.data, cost: "x" }, {})).toBeUndefined()
    expect(
      costEvent("ses_a", { ...STEP.data, tokens: undefined }, {}),
    ).toMatchObject({ usd: 0.0123, context: 0 })
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
      unread: 0,
      cost: {
        today_usd: 0.4567,
        daily_usd: 2,
        context: 53_200,
        context_limit: 200_000,
      },
    })
    expect(await runMe({ action: "status" }, call as any)).toContain(
      "Cost today: $0.46 of your daily cap of $2.00. Context: 53,200 of " +
        "200,000 tokens.",
    )
  })
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
    ])
      expect(part, answer).toContain(answer)
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
      unread: 0,
    })
    expect(await runMe({ action: "status" }, call as any)).toContain(
      "Status paused by your daily cost cap: nothing is delivered until " +
        "tomorrow (the server's zone) or until the owner raises the cap.",
    )
  })
})
