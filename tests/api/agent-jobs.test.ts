/*
 * Jobs that agents set (the owner, 2026-11-09, rc2): `autocode_me
 * action=job_set` and `job_delete` (POST /v1/me/jobs, DELETE
 * /v1/me/jobs/{name}) take a job's whole definition; its name is prefixed
 * with the agent's ID (<agent>:<name>), so the owner's rules for that pattern
 * apply to its runs; run_usd is required. job_mode, per agent and pattern:
 * ask (the default: an approval in the owner's inbox with the whole
 * definition; the job exists once the owner approves it), approve (set at
 * once), off (refused). Changing a job asks again. The job records its
 * creator; all its runs count for the creator; it is deleted when the creator
 * unregisters.
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

const DEF = {
  name: "digest",
  description: "Writes the morning digest",
  model: "fake/main",
  prompt: "Write the digest of incoming/ into digest.md.",
  trigger: 'cron "0 9 * * 1-5"',
  run_usd: 2,
}

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
const job = async (name: string) =>
  (await owner("GET", "/v1/jobs")).body.jobs.find((j: any) => j.name === name)
const approvalOf = async () =>
  (await owner("GET", "/v1/inbox")).body.items.find(
    (i: any) => i.kind === "approval" && i.agent === "team:lead",
  )
const notices = async () =>
  (await sent())
    .filter((i) => i.type === "inject" && i.payload.session === "ses_lead")
    .map((i) => i.payload.text as string)

beforeEach(async () => {
  spawned = 0
  t = await testServer()
  await owner("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
  await hello(t, HOST)
  lead = await registered(t, HOST, "ses_lead", "team:lead")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("an agent sets a job", () => {
  test("job_mode ask: an approval with the whole definition; the job exists once the owner approves", async () => {
    const res = await as(lead, "POST", "/v1/me/jobs", DEF)
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({
      state: "asked",
      name: "team:lead:digest",
    })
    expect(await job("team:lead:digest")).toBeUndefined()
    const item = await approvalOf()
    expect(item.title).toBe("Job team:lead:digest, set by team:lead")
    for (const part of [
      "team:lead asks to set the job team:lead:digest:",
      "- host: m:1",
      "- model: fake/main",
      '- trigger: cron "0 9 * * 1-5"',
      "- run_usd: $2.00",
      "- results to: team:lead",
      "- time limit: 1h",
      "Write the digest of incoming/ into digest.md.",
    ])
      expect(item.text, part).toContain(part)
    // the agent goes on: a proposal does not make it waiting
    expect((await owner("GET", "/v1/agents/team:lead")).body.agent.status).toBe(
      "idle",
    )
    await owner("POST", `/v1/asks/${item.id}/answer`, { text: "approve" })
    expect(await job("team:lead:digest")).toMatchObject({
      name: "team:lead:digest",
      created_by: "team:lead",
      host: HOST,
      run_usd: 2,
      to: "team:lead",
    })
    const [notice] = await notices()
    expect(notice).toContain(
      '[autocode] approval "Job team:lead:digest" approved',
    )
    expect(notice).toContain("The job team:lead:digest is set.")
    const h = (await owner("GET", "/v1/history?kind=job.set")).body.history
    expect(h[0].data).toMatchObject({
      name: "team:lead:digest",
      by: "team:lead",
    })
  })

  test("the owner rejects it: no job; the agent is told", async () => {
    await as(lead, "POST", "/v1/me/jobs", DEF)
    const item = await approvalOf()
    await owner("POST", `/v1/asks/${item.id}/answer`, {
      text: "reject: not every weekday",
    })
    expect(await job("team:lead:digest")).toBeUndefined()
    const [notice] = await notices()
    expect(notice).toContain('approval "Job team:lead:digest" rejected')
    expect(notice).toContain("not every weekday")
  })

  test("job_mode approve: set at once; off: refused", async () => {
    await owner("PATCH", "/v1/settings", {
      rules: [{ match: "team:*", settings: { job_mode: "approve" } }],
    })
    const res = await as(lead, "POST", "/v1/me/jobs", DEF)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ state: "set", name: "team:lead:digest" })
    expect(await job("team:lead:digest")).toMatchObject({
      created_by: "team:lead",
    })
    expect(await approvalOf()).toBeUndefined()
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { job_mode: "off" } },
    })
    const off = await as(lead, "POST", "/v1/me/jobs", { ...DEF, name: "other" })
    expect(off.status).toBe(403)
    expect(off.body.error.message).toContain("job_mode is off")
  })

  test("the definition is checked: run_usd is required; a name stays the agent's own", async () => {
    const { run_usd: _, ...noCap } = DEF
    const res = await as(lead, "POST", "/v1/me/jobs", noCap)
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain("run_usd is required")
    // a name already prefixed is not prefixed twice
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { job_mode: "approve" } },
    })
    const twice = await as(lead, "POST", "/v1/me/jobs", {
      ...DEF,
      name: "team:lead:digest",
    })
    expect(twice.body.name).toBe("team:lead:digest")
    // the same checks as the owner's
    const bad = await as(lead, "POST", "/v1/me/jobs", {
      ...DEF,
      trigger: "idle 1h",
    })
    expect(bad.status).toBe(400)
    // the host: the agent's own unless it names one
    expect((await job("team:lead:digest")).host).toBe(HOST)
  })

  test("changing a job asks again; it stays as it was until approved", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { job_mode: "approve" } },
    })
    await as(lead, "POST", "/v1/me/jobs", DEF)
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { job_mode: "ask" } },
    })
    const res = await as(lead, "POST", "/v1/me/jobs", {
      ...DEF,
      prompt: "Write a shorter digest.",
    })
    expect(res.status).toBe(202)
    expect((await job("team:lead:digest")).prompt).toBe(DEF.prompt)
    const item = await approvalOf()
    expect(item.text).toContain("team:lead asks to change the job")
    expect(item.text).toContain("Write a shorter digest.")
    await owner("POST", `/v1/asks/${item.id}/answer`, { text: "approve" })
    expect((await job("team:lead:digest")).prompt).toBe(
      "Write a shorter digest.",
    )
  })

  test("a second proposal for the same name replaces the open one", async () => {
    await as(lead, "POST", "/v1/me/jobs", DEF)
    const first = await approvalOf()
    await as(lead, "POST", "/v1/me/jobs", { ...DEF, run_usd: 3 })
    const items = (await owner("GET", "/v1/inbox")).body.items.filter(
      (i: any) => i.kind === "approval",
    )
    expect(items.length).toBe(1)
    expect(items[0].id).not.toBe(first.id)
    expect(items[0].text).toContain("- run_usd: $3.00")
  })

  test("job_delete: an agent's own jobs only", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { job_mode: "approve" } },
    })
    await as(lead, "POST", "/v1/me/jobs", DEF)
    await owner("PUT", "/v1/jobs/mail", {
      host: HOST,
      model: "fake/main",
      prompt: "x",
      trigger: "fire-only",
    })
    const other = await as(lead, "DELETE", "/v1/me/jobs/mail")
    expect(other.status).toBe(404)
    expect(other.body.error.message).toContain("no job team:lead:mail")
    const res = await as(lead, "DELETE", "/v1/me/jobs/digest")
    expect(res.status).toBe(200)
    expect(await job("team:lead:digest")).toBeUndefined()
    expect(await job("mail")).toBeDefined()
  })

  test("its runs count for the creator, scheduled ones too", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { job_mode: "approve" } },
    })
    await as(lead, "POST", "/v1/me/jobs", { ...DEF, trigger: "fire-only" })
    await owner(
      "POST",
      `/v1/jobs/${encodeURIComponent("team:lead:digest")}/run`,
    )
    await sent()
    await sent()
    await report(t, HOST, [
      { type: "cost", session: "ses_run1", usd: 0.4, step: "j1", context: 10 },
    ])
    const rows = (await owner("GET", "/v1/costs")).body.agents
    expect(rows.map((r: any) => r.agent)).toEqual(["team:lead"])
    expect(rows[0]).toMatchObject({ today_usd: 0.4, runs_today_usd: 0.4 })
    // the owner's rules for the agent's pattern apply to its runs
    const run = (await owner("GET", "/v1/runs")).body.runs[0]
    expect(run.id).toMatch(/^team:lead:digest:/)
    expect(run.bill_to).toBe("team:lead")
  })

  // Found in the agents suite (haiku-5.5, 2026-11-09): job_set took
  // job=count, then run job=count said "no job count".
  test("run takes the agent's own job by its short name too", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { job_mode: "approve" } },
    })
    await as(lead, "POST", "/v1/me/jobs", { ...DEF, trigger: "fire-only" })
    const res = await as(lead, "POST", "/v1/jobs/digest/run", {})
    expect(res.status).toBe(201)
    expect(res.body.run.id).toMatch(/^team:lead:digest:/)
    // a job of that very name (the owner's) comes first
    await owner("PUT", "/v1/jobs/plain", {
      host: HOST,
      model: "fake/main",
      prompt: "x",
      trigger: "fire-only",
    })
    expect(
      (await as(lead, "POST", "/v1/jobs/plain/run", {})).body.run.id,
    ).toMatch(/^plain:/)
  })

  test("the creator's jobs go when it unregisters", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { job_mode: "approve" } },
    })
    await as(lead, "POST", "/v1/me/jobs", DEF)
    await as(lead, "POST", "/v1/me/jobs", { ...DEF, name: "second" })
    await as(lead, "DELETE", "/v1/me")
    expect(await job("team:lead:digest")).toBeUndefined()
    expect(await job("team:lead:second")).toBeUndefined()
    const h = (await owner("GET", "/v1/history?kind=job.deleted")).body.history
    expect(h.map((x: any) => x.data.why)).toEqual([
      "creator unregistered",
      "creator unregistered",
    ])
  })

  test("an open proposal goes when its agent unregisters", async () => {
    await as(lead, "POST", "/v1/me/jobs", DEF)
    const item = await approvalOf()
    await as(lead, "DELETE", "/v1/me")
    const late = await owner("POST", `/v1/asks/${item.id}/answer`, {
      text: "approve",
    })
    expect(late.status).toBe(409)
    expect(await job("team:lead:digest")).toBeUndefined()
  })

  test("only a registered session sets jobs", async () => {
    const token = await sessionToken(t, HOST, "ses_x")
    const res = await as(token, "POST", "/v1/me/jobs", DEF)
    expect(res.status).toBe(403)
  })
})
