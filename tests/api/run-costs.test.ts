/*
 * The costs of job runs (the owner, 2026-11-09, rc2): a run's steps count
 * for whom it was for. A run an agent started counts for that agent (its
 * Today, Daily Cap, Last 7 Days and Total, and its cap's notice and pause);
 * a run another run started counts up the chain to the first agent; a run an
 * ask started (job:<name>) counts for the agent that asked; a run of a job an
 * agent set counts for that agent. Runs no agent started (the owner, a
 * schedule) count for their job's row, `job:<name>`. Each cost is in exactly
 * one row, so the totals are the true spend; an agent's tooltip says how much
 * was its runs'. Each run's own cost (the Jobs page) and run_usd stay.
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
let lead: string
const HOST = "m:1"

const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)

const JOB = {
  host: HOST,
  model: "fake/main",
  prompt: "Summarize the mail.",
  trigger: "fire-only",
}

// Each spawn answered with a fresh session, as the plugin does.
let spawned = 0
async function sent(): Promise<any[]> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out) {
    if (i.type === "spawn") {
      spawned += 1
      await ack(t, HOST, i.id, { session: `ses_run${spawned}` })
    } else await ack(t, HOST, i.id, { ok: true })
  }
  return out
}
// The next run through to its prompted session: its session and token.
async function runs_() {
  await sent()
  await sent()
  const session = `ses_run${spawned}`
  return { session, token: await sessionToken(t, HOST, session) }
}
const step = (session: string, usd: number, n: string) =>
  report(t, HOST, [{ type: "cost", session, usd, step: n, context: 1000 }])
const turn = async (session: string, f: () => Promise<unknown>) => {
  await report(t, HOST, [{ type: "turn.started", session }])
  await f()
  await report(t, HOST, [{ type: "turn.ended", session, outcome: "succeeded" }])
}
const costs = async (q = "") => (await owner("GET", `/v1/costs${q}`)).body
const row = async (id: string) =>
  (await costs()).agents.find((a: any) => a.agent === id)

beforeEach(async () => {
  spawned = 0
  t = await testServer()
  await owner("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
  await hello(t, HOST)
  lead = await registered(t, HOST, "ses_lead", "team:lead")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("whom a run's cost counts for", () => {
  test("a run an agent started counts for that agent; no row for the run", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await step("ses_lead", 0.1, "s1")
    const started = await as(lead, "POST", "/v1/jobs/mail/run", {})
    expect(started.status).toBe(201)
    const run = await runs_()
    await step(run.session, 0.25, "s2")
    await step(run.session, 0.15, "s3")
    const r = await row("team:lead")
    expect(r).toMatchObject({
      today_usd: 0.5,
      total_usd: 0.5,
      runs_today_usd: 0.4,
      runs_total_usd: 0.4,
    })
    expect(r.week.at(-1).usd).toBe(0.5)
    const ids = (await costs()).agents.map((a: any) => a.agent)
    expect(ids).toEqual(["team:lead"])
    // each cost once: the totals are the true spend
    expect((await costs()).totals).toMatchObject({ today_usd: 0.5 })
    // the run's own cost stays, on the Jobs page
    const view = (await owner("GET", "/v1/runs?job=mail")).body.runs[0]
    await turn(run.session, async () => {})
    expect((await owner("GET", "/v1/runs?job=mail")).body.runs[0].cost).toBe(
      0.4,
    )
    expect(view.bill_to).toBe("team:lead")
    // an agent's days: its own and its runs'
    const days = (await owner("GET", "/v1/costs/team:lead")).body
    expect(days.days[0]).toMatchObject({ usd: 0.5, steps: 3 })
    expect(days.cost).toMatchObject({ runs_total_usd: 0.4 })
  })

  test("a run another run started counts up the chain to the first agent", async () => {
    await owner("PUT", "/v1/jobs/outer", JOB)
    await owner("PUT", "/v1/jobs/inner", JOB)
    await as(lead, "POST", "/v1/jobs/outer/run", {})
    const outer = await runs_()
    const inner = await as(outer.token, "POST", "/v1/jobs/inner/run", {})
    expect(inner.status).toBe(201)
    const run = await runs_()
    await step(outer.session, 0.2, "o1")
    await step(run.session, 0.3, "i1")
    expect(await row("team:lead")).toMatchObject({
      today_usd: 0.5,
      runs_today_usd: 0.5,
    })
    const all = (await owner("GET", "/v1/runs")).body.runs
    expect(all.map((r: any) => r.bill_to)).toEqual(["team:lead", "team:lead"])
  })

  test("a run an ask started (job:<name>) counts for the agent that asked", async () => {
    await owner("PUT", "/v1/jobs/answerer", JOB)
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { approval_mode: "job:answerer" } },
    })
    await as(lead, "POST", "/v1/me/approvals", { text: "Go?" })
    const run = await runs_()
    await step(run.session, 0.3, "a1")
    expect(await row("team:lead")).toMatchObject({
      today_usd: 0.3,
      runs_today_usd: 0.3,
    })
  })

  test("runs no agent started count for the job's row, job:<name>", async () => {
    await owner("PUT", "/v1/jobs/mail", { ...JOB, trigger: "every 1h" })
    await owner("POST", "/v1/jobs/mail/run")
    const run = await runs_()
    await step(run.session, 0.25, "m1")
    await turn(run.session, async () => {})
    t.clock.advance(60 * 60_000)
    const next = await runs_()
    await step(next.session, 0.5, "m2")
    const view = await costs()
    const job = view.agents.find((a: any) => a.agent === "job:mail")
    expect(job).toMatchObject({
      registered: false,
      status: "job",
      job: "mail",
      today_usd: 0.75,
      total_usd: 0.75,
      daily_usd: "off",
    })
    expect(job.week.at(-1).usd).toBe(0.75)
    // no row for a single run
    expect(view.agents.map((a: any) => a.agent)).toEqual([
      "job:mail",
      "team:lead",
    ])
    expect(view.totals.today_usd).toBe(0.75)
    const days = (await owner("GET", "/v1/costs/job:mail")).body
    expect(days).toMatchObject({ agent: "job:mail", registered: false })
    expect(days.days[0]).toMatchObject({ usd: 0.75, steps: 2 })
    // a run's own ID has no costs of its own any more
    const runId = (await owner("GET", "/v1/runs?job=mail")).body.runs[0].id
    expect(
      (await owner("GET", `/v1/costs/${encodeURIComponent(runId)}`)).status,
    ).toBe(404)
  })

  test("the agent's cap counts its runs: the notice, and the pause", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { daily_usd: 1 } },
    })
    await as(lead, "POST", "/v1/jobs/mail/run", {})
    const run = await runs_()
    await step(run.session, 0.95, "c1")
    // the notice at cap_warn goes to the agent, not to the run
    const notices = (await owner("GET", "/v1/history?kind=cap.warned")).body
      .history
    expect(notices.map((h: any) => h.agent)).toEqual(["team:lead"])
    await turn(run.session, () => step(run.session, 0.2, "c2"))
    // past the cap: the agent is paused (no turn of its own runs); the run
    // goes on to its own limits
    const agent = (await owner("GET", "/v1/agents/team:lead")).body.agent
    expect(agent.status).toBe("paused")
    const alert = (await owner("GET", "/v1/inbox")).body.items.find(
      (i: any) => i.kind === "alert" && i.agent === "team:lead",
    )
    expect(alert.title).toBe("team:lead reached its daily cap ($1.15 of $1.00)")
    expect((await owner("GET", "/v1/runs?job=mail")).body.runs[0].state).toBe(
      "running",
    )
  })

  test("past the cap during its own turn, the agent is paused when that turn ends", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { daily_usd: 1 } },
    })
    await as(lead, "POST", "/v1/jobs/mail/run", {})
    const run = await runs_()
    await report(t, HOST, [{ type: "turn.started", session: "ses_lead" }])
    await step(run.session, 1.2, "p1")
    await turn(run.session, async () => {})
    expect((await owner("GET", "/v1/agents/team:lead")).body.agent.status).toBe(
      "working",
    )
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_lead", outcome: "succeeded" },
    ])
    expect((await owner("GET", "/v1/agents/team:lead")).body.agent.status).toBe(
      "paused",
    )
  })

  test("run_usd still caps the run by its own cost", async () => {
    await owner("PUT", "/v1/jobs/mail", { ...JOB, run_usd: 0.5 })
    await as(lead, "POST", "/v1/jobs/mail/run", {})
    const run = await runs_()
    await turn(run.session, () => step(run.session, 0.6, "u1"))
    expect(
      (await owner("GET", "/v1/runs?job=mail")).body.runs[0],
    ).toMatchObject({
      state: "failed",
      reason: "run cap ($0.60 of $0.50)",
      cost: 0.6,
    })
    expect(await row("team:lead")).toMatchObject({ today_usd: 0.6 })
  })

  test("an agent cannot take an ID that starts with job:", async () => {
    const t2 = await sessionToken(t, HOST, "ses_x")
    const res = await as(t2, "POST", "/v1/agents", { id: "job:mail" })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain("job:")
  })

  test("a job row's spend stays after its job is deleted", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await owner("POST", "/v1/jobs/mail/run")
    const run = await runs_()
    await step(run.session, 0.25, "d1")
    await owner("DELETE", "/v1/jobs/mail")
    expect(await row("job:mail")).toMatchObject({ total_usd: 0.25 })
  })
})
