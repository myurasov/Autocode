/*
 * Tier 0e end to end, with real OpenCode sessions and the fake model's
 * usage: each step's cost reaches the agent's day; a daily cap pauses the
 * agent after the turn that passed it; a session whose context passed
 * compact_at is compacted (OpenCode's own compaction) before the next wake.
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

  test("past compact_at, the session is compacted before the next wake", async () => {
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
  }, 240_000)
})
