/*
 * A session's cost from before it registered, end to end with a real
 * OpenCode (spec, Costs and Caps; the owner, 2026-11-21): a session spends
 * in turns of its own, then registers; the plugin reads its earlier steps
 * from OpenCode's records and the server files them, each once, so that the
 * agent's total is what OpenCode says the session's steps cost. And a
 * compaction's cost, which OpenCode ends with no step event, is counted when
 * its turn ends.
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
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
const id = `e2e:${run}:before`
const enc = encodeURIComponent
let oc: OpenCode
let session: string

beforeAll(async () => {
  await admin("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
  oc = new OpenCode(node)
  session = (await readySession(oc)).id
})

afterAll(async () => {
  await admin("DELETE", `/v1/agents/${enc(id)}`).catch(() => {})
  await admin("PATCH", "/v1/settings", {
    server: { min_interval: null },
    agents: { [id]: null },
  })
})

// What OpenCode's own records say the session's steps of a type cost.
async function recorded(type: string): Promise<{ n: number; usd: number }> {
  const items = await oc.api(
    "GET",
    `/api/session/${session}/message?type=${type}&limit=200&order=desc`,
  )
  const costs = (items as any[])
    .map((m) => m.cost)
    .filter((c): c is number => typeof c === "number")
  return { n: costs.length, usd: costs.reduce((a, b) => a + b, 0) }
}

const cost = async () => (await admin("GET", `/v1/costs/${enc(id)}`)).cost

test("what a session spent before it registered is counted when it registers, every step once", async () => {
  const fake = new FakeModel(node)
  // two turns before it is anybody's agent; the fake model's price: input $1
  // and output $2 per million tokens, so $0.06 and $0.03 (well inside the
  // model's window: a bigger context makes OpenCode compact on its own)
  await fake.script(
    [
      {
        session,
        reply: "first",
        usage: { prompt_tokens: 40_000, completion_tokens: 10_000 },
      },
    ],
    true,
  )
  await oc.run(session, "spend before registering", 90_000)
  await fake.script(
    [
      {
        session,
        reply: "second",
        usage: { prompt_tokens: 10_000, completion_tokens: 10_000 },
      },
    ],
    true,
  )
  await oc.run(session, "spend again", 90_000)
  const earlier = await recorded("assistant")
  expect(earlier.n).toBe(2)
  expect(earlier.usd).toBeCloseTo(0.09, 6)

  expect(
    await callTool(oc, session, "autocode_me", { action: "register", id }),
  ).toContain("Registered")
  const before = await until(
    async () =>
      (await admin("GET", `/v1/history?kind=cost.before&agent=${enc(id)}`))
        .history[0],
    { timeoutMs: 60_000, intervalMs: 500, what: "the earlier steps" },
  )
  expect(before.data.error).toBeUndefined()
  // the two turns, and what of the registering turn was not reported live
  expect(before.data.steps).toBeGreaterThanOrEqual(2)
  expect(before.data.usd).toBeGreaterThanOrEqual(0.09)
  expect(before.data.older_usd).toBe(0)
  expect(before.data.days).toBe(1)
  await agentStatus(id, "idle", 60_000)

  // the agent's spend is what OpenCode says the session's steps cost: the
  // earlier ones, and the registering turn's, each once
  const all = await recorded("assistant")
  expect(all.n).toBe(4)
  await until(async () => Math.abs((await cost()).total_usd - all.usd) < 1e-6, {
    timeoutMs: 30_000,
    intervalMs: 500,
    what: "every step counted once",
  })
  const view = await admin("GET", `/v1/costs/${enc(id)}`)
  expect(view.cost.today_usd).toBeCloseTo(all.usd, 6)
  expect(view.days.map((d: any) => d.steps)).toEqual([4])

  // a turn after it: live as before, and nothing of the past again
  await fake.script(
    [
      {
        session,
        reply: "third",
        usage: { prompt_tokens: 20_000, completion_tokens: 0 },
      },
    ],
    true,
  )
  await oc.run(session, "spend as an agent", 90_000)
  await until(
    async () => Math.abs((await cost()).total_usd - (all.usd + 0.02)) < 1e-6,
    { timeoutMs: 30_000, intervalMs: 500, what: "the live step" },
  )
  // asked once: the owner's request for it finds it accounted for
  const again = await admin("POST", `/v1/agents/${enc(id)}/account`).then(
    () => "asked",
    (err: any) => err.body?.error?.code,
  )
  expect(again).toBe("accounted")
}, 300_000)

test("a compaction's cost is counted when its turn ends", async () => {
  await admin("PATCH", "/v1/settings", {
    agents: { [id]: { compact_at: "off" } },
  })
  const start = await cost()
  const fake = new FakeModel(node)
  // the agent asks for a compaction; it comes when this turn ends
  await fake.script(
    [
      {
        session,
        tool_calls: [{ name: "autocode_me", arguments: { action: "compact" } }],
      },
      { session, reply: "state written" },
    ],
    true,
  )
  await oc.run(session, "compact yourself", 90_000)
  await until(
    async () =>
      (
        await admin(
          "GET",
          `/v1/history?kind=session.compacted&agent=${enc(id)}`,
        )
      ).history[0],
    { timeoutMs: 60_000, what: "the compaction" },
  )
  // OpenCode's record of the compaction has its cost
  const compactions = await until(
    async () => {
      const c = await recorded("compaction")
      return c.n > 0 && c.usd > 0 ? c : undefined
    },
    { timeoutMs: 90_000, intervalMs: 1000, what: "the compaction's cost" },
  )
  await agentStatus(id, "idle", 90_000)
  // every step of the session and its compaction, once each
  await until(
    async () => {
      const steps = await recorded("assistant")
      const total = (await cost()).total_usd
      return Math.abs(total - (steps.usd + compactions.usd)) < 1e-6
    },
    { timeoutMs: 60_000, intervalMs: 1000, what: "the compaction counted" },
  )
  expect((await cost()).total_usd).toBeGreaterThan(start.total_usd)
}, 300_000)
