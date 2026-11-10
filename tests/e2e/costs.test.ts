/*
 * Tier 0e end to end, with real OpenCode sessions and the fake model's
 * usage: each step's cost reaches the agent's day; a daily cap pauses the
 * agent after the turn that passed it; a session whose context passed
 * compact_at is told first (tier 0g: "[autocode] compaction next" reaches the
 * model as a prompt of its own), then compacted (OpenCode's own compaction)
 * when that turn ends, before the next wake; the owner's view of its spend
 * and context (GET /v1/costs).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  admin,
  agentStatus,
  callTool,
  readySession,
} from "../helpers/autocode.ts"
import { nodes } from "../helpers/env.ts"
import { FakeModel } from "../helpers/fake.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { until } from "../helpers/wait.ts"

const run = crypto.randomUUID().slice(0, 6)
const node = nodes.at(-1)!
let oc: OpenCode
let session: string
const id = `e2e:${run}:cost`
const enc = encodeURIComponent

const agent = async () => (await admin("GET", `/v1/agents/${enc(id)}`)).agent

beforeAll(async () => {
  await admin("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
  oc = new OpenCode(node)
  session = (await readySession(oc)).id
  await callTool(oc, session, "autocode_me", { action: "register", id })
})

afterAll(async () => {
  await admin("DELETE", `/v1/agents/${enc(id)}`).catch(() => {})
  await admin("PATCH", "/v1/settings", {
    server: { min_interval: null },
    agents: { [id]: null },
  })
})

describe("costs and compaction", () => {
  test("steps' costs add up; the cap pauses after the turn that passes it", async () => {
    // no compaction notice into this turn (past compact_at, it would come at
    // once since 2026-11-09, and its step is the context then)
    await admin("PATCH", "/v1/settings", {
      agents: { [id]: { compact_at: "off" } },
    })
    const fake = new FakeModel(node)
    // the fake model's price: input $1, output $2 per million tokens
    await fake.script(
      [
        {
          session,
          reply: "a costly answer",
          usage: { prompt_tokens: 400_000, completion_tokens: 100_000 },
        },
      ],
      true,
    )
    await oc.run(session, "spend", 90_000)
    const cost = await until(
      async () => {
        const c = (await agent()).cost
        return c.today_usd > 0 ? c : undefined
      },
      { timeoutMs: 30_000, what: "the cost to arrive" },
    )
    expect(cost.today_usd).toBeGreaterThan(0.5)
    expect(cost.context).toBeGreaterThan(300_000)
    expect(cost.context_limit).toBe(200_000)
    await admin("PATCH", "/v1/settings", {
      agents: { [id]: { daily_usd: 0.5, compact_at: "off" } },
    })
    await fake.script([{ session, reply: "one more" }], true)
    await oc.run(session, "one more turn", 90_000)
    await until(async () => (await agent()).paused === "cap", {
      timeoutMs: 30_000,
      what: "the cap's pause",
    })
    const alert = (await admin("GET", "/v1/inbox")).items.find(
      (i: any) => i.kind === "alert" && i.agent === id,
    )
    expect(alert.title).toContain("reached its daily cap")
    await admin("PATCH", "/v1/settings", {
      agents: { [id]: { daily_usd: null } },
    })
    await until(async () => (await agent()).paused === "", {
      timeoutMs: 30_000,
      what: "the pause lifted",
    })
    await admin("POST", `/v1/inbox/${alert.id}/close`)
  }, 240_000)

  test("past compact_at, the session is told first, then compacted after that turn, before the next wake", async () => {
    await admin("PATCH", "/v1/settings", {
      agents: { [id]: { compact_at: "10%" } },
    })
    const fake = new FakeModel(node)
    await fake.script(
      [
        {
          session,
          reply: "a long context",
          usage: { prompt_tokens: 50_000, completion_tokens: 100 },
        },
        // the notice's turn: the agent writes down its state; the context
        // only grows (a smaller one would mean OpenCode compacted on its own)
        {
          session,
          match: "[autocode] compaction next",
          reply: "Notes written; ready for the compaction.",
          usage: { prompt_tokens: 51_000, completion_tokens: 100 },
        },
      ],
      true,
    )
    await oc.run(session, "grow", 90_000)
    await admin("PUT", `/v1/agents/${enc(id)}/wakes/tick`, {
      text: "Tick after compaction.",
      trigger: "fire-only",
    })
    await admin("POST", `/v1/agents/${enc(id)}/wakes/tick/fire`)
    const compacted = await until(
      async () =>
        (
          await admin(
            "GET",
            `/v1/history?kind=session.compacted&agent=${enc(id)}`,
          )
        ).history[0],
      { timeoutMs: 60_000, what: "the compaction" },
    )
    expect(compacted.data.limit).toBe(20_000)
    // the notice reached the model first, in a turn of its own
    const asked = await fake.requests()
    const notice = asked.findIndex(
      (r: any) =>
        r.session === session &&
        r.kind === "primary" &&
        JSON.stringify(r.messages).includes("[autocode] compaction next"),
    )
    expect(notice).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(asked[notice]!.messages)).not.toContain(
      "Tick after compaction.",
    )
    const kind = "session.compact.noticed"
    const noticed = (
      await admin("GET", `/v1/history?kind=${kind}&agent=${enc(id)}`)
    ).history[0]
    expect(Date.parse(noticed.at)).toBeLessThanOrEqual(Date.parse(compacted.at))
    // OpenCode's compaction request reached the model, then the wake did
    await until(
      async () =>
        (await fake.requests()).some(
          (r: any) =>
            r.session === session &&
            r.kind !== "title" &&
            JSON.stringify(r.messages).includes("Tick after compaction."),
        ),
      { timeoutMs: 90_000, intervalMs: 1000, what: "the wake after it" },
    )
    await agentStatus(id, "idle", 60_000)
    // the owner's view: its spend and context (tier 0g)
    const view = (await admin("GET", `/v1/costs/${enc(id)}`)).cost
    expect(view.total_usd).toBeGreaterThan(0)
    expect(view.compact_at).toBe(20_000)
  }, 240_000)
})
