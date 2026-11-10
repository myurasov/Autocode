/*
 * Spawned agents (spec, Spawned Agents; tier 0f), with the plugin played
 * over its channel: the owner defines a job on a host (its machine and
 * folder); a run starts on its trigger, by the owner, or by an agent; the
 * plugin is told to spawn a session there, reports it, and the server
 * registers it under the run's ID and prompts it. One run at a time: a
 * scheduled one is skipped, an asked-for one refused. It ends with finish
 * (or idle with its last reply), the result goes to the destination (the
 * starter for agents' runs), the session is removed with delete_session; a
 * time limit or run_usd fails it (an alert; the session kept). An ask
 * routed to job:<name> starts a run with the ask in its prompt: a question,
 * a permission (once or reject) or an approval, whose answer goes to the
 * asker; the run may escalate to the owner.
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
let lead: string
const HOST = "m:1"
const MIN = 60_000

const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)

const JOB = {
  host: HOST,
  description: "Summarizes the day's mail",
  model: "fake/main",
  prompt: "Summarize today's mail in five lines.",
  trigger: "fire-only",
  to: "owner",
}

// The instructions sent on a tick, acked; the spawn ones answered with a
// fresh session, as the plugin does.
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
const runs = async (job?: string) =>
  (await owner("GET", `/v1/runs${job ? `?job=${job}` : ""}`)).body.runs

// A run of `job` through to its spawned, prompted session; its token.
async function started(job = "mail") {
  const out = await sent()
  const spawn = out.find((i) => i.type === "spawn")
  expect(spawn).toBeDefined()
  // the server registers the session and prompts it
  const next = await sent()
  const prompt = next.find((i) => i.type === "inject")
  expect(prompt).toBeDefined()
  const run = (await runs(job)).find((r: any) => r.state === "running")
  return { spawn, prompt, run }
}

beforeEach(async () => {
  spawned = 0
  t = await testServer()
  await owner("PATCH", "/v1/settings", {
    server: { timezone: "America/Los_Angeles", min_interval: "1s" },
  })
  await hello(t, HOST)
  lead = await registered(t, HOST, "ses_lead", "team:lead")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("jobs", () => {
  test("the owner sets, lists and deletes a job; agents see names and descriptions", async () => {
    const set = await owner("PUT", "/v1/jobs/mail", JOB)
    expect(set.status).toBe(201)
    expect(set.body.job).toMatchObject({
      name: "mail",
      host: HOST,
      machine: "m",
      directory: "/work",
      model: "fake/main",
      trigger: "fire-only",
      to: "owner",
      timeout: "1h",
      run_usd: "off",
      delete_session: true,
      next: null,
    })
    expect((await owner("GET", "/v1/jobs")).body.jobs.length).toBe(1)
    const seen = (await as(lead, "GET", "/v1/jobs")).body.jobs
    expect(seen).toEqual([
      { name: "mail", description: "Summarizes the day's mail" },
    ])
    expect((await owner("DELETE", "/v1/jobs/mail")).status).toBe(200)
    expect((await owner("GET", "/v1/jobs")).body.jobs).toEqual([])
  })

  test("setting a job again changes it; its runs keep their own prompt", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await owner("POST", "/v1/jobs/mail/run")
    const { prompt } = await started()
    expect(prompt.payload.text).toContain("five lines")
    const res = await owner("PUT", "/v1/jobs/mail", {
      ...JOB,
      prompt: "Summarize today's mail in three lines.",
      description: "Three lines",
    })
    expect(res.status).toBe(200)
    const job = (await owner("GET", "/v1/jobs")).body.jobs.find(
      (j: any) => j.name === "mail",
    )
    expect(job).toMatchObject({
      description: "Three lines",
      prompt: "Summarize today's mail in three lines.",
    })
    expect((await runs("mail")).length).toBe(1)
  })

  test("a job is checked: name, host, prompt, trigger, destination, limits", async () => {
    const bad: [string, unknown][] = [
      ["bad name", JOB],
      ["mail", { ...JOB, host: "nowhere:1" }],
      ["mail", { ...JOB, prompt: "" }],
      ["mail", { ...JOB, trigger: "sometimes" }],
      ["mail", { ...JOB, trigger: "idle 5m" }],
      ["mail", { ...JOB, to: "a b" }],
      ["mail", { ...JOB, timeout: "0s" }],
      ["mail", { ...JOB, run_usd: -1 }],
      ["mail", { ...JOB, keep: true }],
    ]
    for (const [name, body] of bad) {
      const res = await owner(
        "PUT",
        `/v1/jobs/${encodeURIComponent(name)}`,
        body,
      )
      expect(
        res.status,
        `${name} ${JSON.stringify(body)}`,
      ).toBeGreaterThanOrEqual(400)
    }
  })
})

describe("runs", () => {
  test("the owner runs a job: spawned on its host, registered under the run's ID, prompted", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    const res = await owner("POST", "/v1/jobs/mail/run", {
      text: "only work mail",
    })
    expect(res.status).toBe(201)
    expect(res.body.run.id).toBe("mail:2026-10-28T12:00")
    const { spawn, prompt, run } = await started()
    expect(spawn.payload).toEqual({
      run: "mail:2026-10-28T12:00",
      title: "mail:2026-10-28T12:00",
      model: "fake/main",
    })
    expect(prompt.payload.session).toBe("ses_run1")
    expect(prompt.payload.text).toBe(
      "Summarize today's mail in five lines.\n\n" +
        "Added by the owner:\n> only work mail\n\n" +
        "— You are the run mail:2026-10-28T12:00 of job mail, started by " +
        "Autocode. End it with autocode_me action=finish result=<your " +
        "result>; the result goes to the owner.",
    )
    expect(run).toMatchObject({
      id: "mail:2026-10-28T12:00",
      job: "mail",
      by: "owner",
      session: "ses_run1",
      state: "running",
    })
    expect(
      (await owner("GET", "/v1/agents/mail:2026-10-28T12:00")).body.agent
        .session,
    ).toBe("ses_run1")
  })

  test("one run at a time: an asked-for run is refused, a scheduled one skipped", async () => {
    await owner("PUT", "/v1/jobs/mail", { ...JOB, trigger: "every 10m" })
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    const again = await owner("POST", "/v1/jobs/mail/run")
    expect(again.status).toBe(409)
    expect(again.body.error.message).toBe(
      "job mail is running: mail:2026-10-28T12:00, started by the owner",
    )
    t.clock.advance(10 * MIN)
    await sent()
    const all = await runs("mail")
    // newest first
    expect(all.map((r: any) => r.state)).toEqual(["skipped", "running"])
    expect(all[0].reason).toBe("mail:2026-10-28T12:00 still works")
  })

  test("a scheduled run starts on its trigger", async () => {
    await owner("PUT", "/v1/jobs/mail", { ...JOB, trigger: "every 30m" })
    t.clock.advance(30 * MIN)
    await started()
    expect((await runs("mail"))[0]).toMatchObject({
      id: "mail:2026-10-28T12:30",
      by: "schedule",
    })
  })

  test("finish: the result goes to the destination, the agent goes, the session is removed", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    const { sessionToken } = await import("../helpers/server.ts")
    const token = await sessionToken(t, HOST, "ses_run1")
    const fin = await as(token, "POST", "/v1/me/finish", {
      result: "Five lines of mail.",
    })
    expect(fin.status).toBe(200)
    const run = (await runs("mail"))[0]
    expect(run).toMatchObject({
      state: "succeeded",
      result: "Five lines of mail.",
    })
    const item = (await owner("GET", "/v1/inbox")).body.items[0]
    expect(item.title).toBe("Result of run mail:2026-10-28T12:00")
    expect(item.body).toBe("Five lines of mail.")
    expect(
      (await owner("GET", "/v1/agents/mail:2026-10-28T12:00")).status,
    ).toBe(404)
    const out = await sent()
    expect(
      out.filter((i) => i.type === "remove").map((i) => i.payload),
    ).toEqual([{ session: "ses_run1" }])
  })

  test("idle with nothing pending: the last reply is the result", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    await report(t, HOST, [{ type: "turn.started", session: "ses_run1" }])
    await report(t, HOST, [
      {
        type: "turn.ended",
        session: "ses_run1",
        outcome: "succeeded",
        reply: "Done: three mails.",
      },
    ])
    expect((await runs("mail"))[0]).toMatchObject({
      state: "succeeded",
      result: "Done: three mails.",
    })
  })

  test("an agent starts a run: the result goes to it; it lists the jobs", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    const res = await as(lead, "POST", "/v1/jobs/mail/run", { text: "urgent" })
    expect(res.status).toBe(201)
    const { prompt } = await started()
    expect(prompt.payload.text).toContain("Added by agent team:lead:\n> urgent")
    expect(prompt.payload.text).toContain("the result goes to team:lead")
    const { sessionToken } = await import("../helpers/server.ts")
    const token = await sessionToken(t, HOST, "ses_run1")
    await as(token, "POST", "/v1/me/finish", { result: "ok" })
    const mine = (await owner("GET", "/v1/messages?agent=team:lead")).body
      .messages
    expect(mine).toMatchObject([
      {
        from: "autocode",
        subject: "result of run mail:2026-10-28T12:00",
      },
    ])
  })

  test("the time limit fails a run: interrupted, an alert, the session kept until the owner deletes it", async () => {
    await owner("PUT", "/v1/jobs/mail", { ...JOB, timeout: "5m" })
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    t.clock.advance(5 * MIN)
    const out = await sent()
    expect(out.map((i) => i.type)).toContain("interrupt")
    expect(out.map((i) => i.type)).not.toContain("remove")
    const run = (await runs("mail"))[0]
    expect(run).toMatchObject({ state: "failed", reason: "time limit (5m)" })
    const alert = (await owner("GET", "/v1/inbox")).body.items.find(
      (i: any) => i.kind === "alert",
    )
    expect(alert.title).toBe(
      "Run mail:2026-10-28T12:00 failed: time limit (5m)",
    )
    const del = await owner("DELETE", `/v1/runs/${run.id}/session`)
    expect(del.status).toBe(200)
    expect(
      (await sent()).filter((i) => i.type === "remove").map((i) => i.payload),
    ).toEqual([{ session: "ses_run1" }])
  })

  test("run_usd fails a run past it", async () => {
    await owner("PUT", "/v1/jobs/mail", { ...JOB, run_usd: 0.5 })
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    await report(t, HOST, [{ type: "turn.started", session: "ses_run1" }])
    await report(t, HOST, [
      { type: "cost", session: "ses_run1", usd: 0.6, context: 1000 },
    ])
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_run1", outcome: "succeeded" },
    ])
    expect((await runs("mail"))[0]).toMatchObject({
      state: "failed",
      reason: "run cap ($0.60 of $0.50)",
      cost: 0.6,
    })
  })

  test("a spawn that fails fails the run", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await owner("POST", "/v1/jobs/mail/run")
    t.server.tick()
    for (const i of await instructions(t, HOST))
      await report(t, HOST, [
        { type: "ack", id: i.id, ok: false, error: "no such model" },
      ])
    t.server.tick()
    expect((await runs("mail"))[0]).toMatchObject({
      state: "failed",
      reason: "the session could not start: no such model",
    })
  })
})

describe("asks answered by a job's run", () => {
  test("job:<name>: a run starts with the ask in its prompt and answers it", async () => {
    await owner("PUT", "/v1/jobs/answerer", { ...JOB, prompt: "Answer it." })
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { question_mode: "job:answerer" } },
    })
    await report(t, HOST, [
      {
        type: "ask.opened",
        kind: "question",
        session: "ses_lead",
        ref: "frm_1",
        questions: [
          {
            header: "Fold",
            question: "Which fold?",
            options: [{ label: "v3" }],
          },
        ],
      },
    ])
    const item = (await owner("GET", "/v1/inbox")).body.items.find(
      (i: any) => i.kind === "question",
    )
    // sent to the job's run, which answers like an agent
    expect(item.routed).toBe("agent:answerer:2026-10-28T12:00")
    const { prompt, run } = await started("answerer")
    expect(prompt.payload.text).toContain("Answer it.")
    expect(prompt.payload.text).toContain("Agent team:lead asks")
    expect(prompt.payload.text).toContain(
      `autocode_message action=answer id=${item.id}`,
    )
    const { sessionToken } = await import("../helpers/server.ts")
    const token = await sessionToken(t, HOST, "ses_run1")
    const res = await as(token, "POST", `/v1/asks/${item.id}/answer`, {
      text: "v3",
    })
    expect(res.status).toBe(200)
    expect(run.ask).toBe(item.id)
  })

  /*
   * The owner, 2026-11-09: "make sure our ci covers jobs functionality,
   * including approving/answering/permitting with jobs". Each kind of ask a
   * job's run takes: its prompt says how to answer, its answer goes to the
   * agent that asked (the plugin's answer; an approval's notice), and the run
   * may escalate to the owner.
   */
  const runToken = async (session = "ses_run1") => {
    const { sessionToken } = await import("../helpers/server.ts")
    return sessionToken(t, HOST, session)
  }
  // the instructions of the next tick, by type
  const next = async (type: string) =>
    (await sent()).filter((i) => i.type === type)
  const inbox = async (kind: string) =>
    (await owner("GET", "/v1/inbox")).body.items.find(
      (i: any) => i.kind === kind,
    )

  test("job:<name> question: the run's answer reaches the asking session", async () => {
    await owner("PUT", "/v1/jobs/answerer", { ...JOB, prompt: "Answer it." })
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { question_mode: "job:answerer" } },
    })
    await report(t, HOST, [
      {
        type: "ask.opened",
        kind: "question",
        session: "ses_lead",
        ref: "frm_9",
        questions: [
          {
            header: "Fold",
            question: "Which fold?",
            options: [{ label: "v3" }],
          },
        ],
      },
    ])
    const item = await inbox("question")
    await started("answerer")
    const res = await as(
      await runToken(),
      "POST",
      `/v1/asks/${item.id}/answer`,
      {
        text: "v3",
      },
    )
    expect(res.status).toBe(200)
    const [answer] = await next("answer")
    expect(answer.payload).toMatchObject({
      session: "ses_lead",
      kind: "question",
      ref: "frm_9",
      answer: { q0: "v3" },
    })
    const h = (await owner("GET", "/v1/history?kind=ask.answered")).body.history
    expect(h[0].data.by).toBe("answerer:2026-10-28T12:00")
    expect((await owner("GET", "/v1/inbox")).body.items).toEqual([])
  })

  test("job:<name> permission: the run allows once or rejects; always stays the owner's", async () => {
    await owner("PUT", "/v1/jobs/guard", { ...JOB, prompt: "Decide it." })
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { permission_mode: "job:guard" } },
    })
    const permission = (ref: string) => ({
      type: "ask.opened",
      kind: "permission",
      session: "ses_lead",
      ref,
      title: "shell",
      action: "shell",
      resources: ["rm -rf build"],
      save: ["rm *"],
    })
    await report(t, HOST, [permission("per_1")])
    const item = await inbox("permission")
    expect(item.routed).toBe("agent:guard:2026-10-28T12:00")
    const { prompt } = await started("guard")
    expect(prompt.payload.text).toContain("Decide it.")
    expect(prompt.payload.text).toContain(
      "Agent team:lead wants to run shell: rm -rf build.",
    )
    expect(prompt.payload.text).toContain("text=once or text=reject")
    const token = await runToken()
    const always = await as(token, "POST", `/v1/asks/${item.id}/answer`, {
      text: "always",
    })
    expect(always.status).toBe(403)
    expect(always.body.error.message).toContain("only the owner")
    const once = await as(token, "POST", `/v1/asks/${item.id}/answer`, {
      text: "once",
    })
    expect(once.status).toBe(200)
    const [answer] = await next("answer")
    expect(answer.payload).toMatchObject({
      session: "ses_lead",
      kind: "permission",
      ref: "per_1",
      decision: "once",
    })
  })

  test("job:<name> approval: the run approves or rejects; the asker's wait and notice say so", async () => {
    await owner("PUT", "/v1/jobs/approver", { ...JOB, prompt: "Review it." })
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { approval_mode: "job:approver" } },
    })
    const asked = await as(lead, "POST", "/v1/me/approvals", {
      text: "Deploy v2?",
      options: ["now", "tonight"],
    })
    expect(asked.status).toBe(201)
    const id = asked.body.approval.id
    expect(asked.body.approval.routed).toBe("agent:approver:2026-10-28T12:00")
    const waiting = as(lead, "GET", `/v1/me/approvals/${id}?wait=10`)
    const { prompt } = await started("approver")
    expect(prompt.payload.text).toContain("Review it.")
    expect(prompt.payload.text).toContain(
      "Agent team:lead asks for approval: Deploy v2?",
    )
    expect(prompt.payload.text).toContain("Options: now, tonight.")
    expect(prompt.payload.text).toContain(
      `autocode_message action=answer id=${id}`,
    )
    const res = await as(await runToken(), "POST", `/v1/asks/${id}/answer`, {
      text: "approve: tonight",
    })
    expect(res.status).toBe(200)
    expect((await waiting).body.approval).toMatchObject({
      state: "approved",
      by: "approver:2026-10-28T12:00",
    })
    const notice = (await next("inject")).find(
      (i) => i.payload.session === "ses_lead",
    )
    expect(notice.payload.text).toStartWith(
      '[autocode] approval "Deploy v2?" approved',
    )
  })

  test("job:<name>: the run escalates; the reason is on the owner's item, and the owner answers", async () => {
    await owner("PUT", "/v1/jobs/answerer", JOB)
    await owner("PATCH", "/v1/settings", {
      agents: { "team:lead": { approval_mode: "job:answerer" } },
    })
    const asked = await as(lead, "POST", "/v1/me/approvals", {
      text: "Pay it?",
    })
    const id = asked.body.approval.id
    await started("answerer")
    const res = await as(await runToken(), "POST", `/v1/asks/${id}/escalate`, {
      text: "a payment is the owner's call",
    })
    expect(res.status).toBe(200)
    const item = await inbox("approval")
    expect(item.notes).toEqual([
      "answerer:2026-10-28T12:00 cannot answer: a payment is the owner's call",
    ])
    await owner("POST", `/v1/asks/${id}/answer`, { text: "reject" })
    expect(
      (await as(lead, "GET", `/v1/me/approvals/${id}`)).body.approval,
    ).toMatchObject({ state: "rejected", by: "owner" })
  })

  test("question_mode, permission_mode and approval_mode take job:<name>", async () => {
    for (const mode of ["question_mode", "permission_mode", "approval_mode"]) {
      const res = await owner("PATCH", "/v1/settings", {
        agents: { "team:lead": { [mode]: "job:answerer" } },
      })
      expect(res.status, mode).toBe(200)
      const bad = await owner("PATCH", "/v1/settings", {
        agents: { "team:lead": { [mode]: "job:" } },
      })
      expect(bad.status, mode).toBe(400)
    }
  })

  test("an ask while the job's run works goes to the owner alone", async () => {
    await owner("PUT", "/v1/jobs/answerer", JOB)
    await owner("PATCH", "/v1/settings", {
      server: { question_mode: "job:answerer" },
    })
    await owner("POST", "/v1/jobs/answerer/run")
    await started("answerer")
    await report(t, HOST, [
      {
        type: "ask.opened",
        kind: "question",
        session: "ses_lead",
        ref: "frm_2",
        questions: [{ header: "Q", question: "Q?", options: [] }],
      },
    ])
    const item = (await owner("GET", "/v1/inbox")).body.items.find(
      (i: any) => i.kind === "question",
    )
    expect(item.routed).toBe("owner")
  })
})

test("a run's first prompt has OpenCode's form of a message ID", async () => {
  await owner("PUT", "/v1/jobs/mail", JOB)
  await owner("POST", "/v1/jobs/mail/run")
  const { prompt } = await started()
  expect(prompt.payload.prompt_id).toMatch(/^msg_[0-9a-f]{24}$/)
})

// The adversarial review of 0f (2026-11-07).
describe("review of 0f", () => {
  const tokenOf = async (session: string) => {
    const { sessionToken } = await import("../helpers/server.ts")
    return sessionToken(t, HOST, session)
  }

  test("a run with its own wake still waiting does not end at its reply", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    const token = await tokenOf("ses_run1")
    await as(token, "PUT", "/v1/me/wakes/later", {
      text: "Look again.",
      trigger: "in 10m",
    })
    await report(t, HOST, [{ type: "turn.started", session: "ses_run1" }])
    await report(t, HOST, [
      {
        type: "turn.ended",
        session: "ses_run1",
        outcome: "succeeded",
        reply: "Waiting for the next look.",
      },
    ])
    expect((await runs("mail"))[0].state).toBe("running")
  })

  test("the hello names the host's run sessions (the plugin forgot them after a restart)", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    const reply = (await hello(t, HOST)).body
    expect(reply.runs).toEqual(["ses_run1"])
  })

  test("a run whose turns fail and are not retried fails", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    await report(t, HOST, [{ type: "turn.started", session: "ses_run1" }])
    await report(t, HOST, [
      {
        type: "turn.ended",
        session: "ses_run1",
        outcome: "failed",
        error: "provider.auth",
      },
    ])
    expect((await runs("mail"))[0]).toMatchObject({
      state: "failed",
      reason: "its turn failed (provider.auth); not retried",
    })
  })

  test("a run's cost counts all its days (a run across midnight)", async () => {
    await owner("PUT", "/v1/jobs/mail", { ...JOB, run_usd: 1 })
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    await report(t, HOST, [
      { type: "cost", session: "ses_run1", usd: 0.7, context: 1000 },
    ])
    t.clock.advance(12 * 3_600_000)
    await report(t, HOST, [
      { type: "cost", session: "ses_run1", usd: 0.6, context: 1000 },
    ])
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_run1", outcome: "succeeded" },
    ])
    expect((await runs("mail"))[0]).toMatchObject({
      state: "failed",
      reason: "run cap ($1.30 of $1.00)",
      cost: 1.3,
    })
  })

  test("deleting a running run's session is refused", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await owner("POST", "/v1/jobs/mail/run")
    const { run } = await started()
    const res = await owner("DELETE", `/v1/runs/${run.id}/session`)
    expect(res.status).toBe(409)
  })

  test("a run never takes an ID another agent holds", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await registered(t, HOST, "ses_squat", "mail:2026-10-28T12:00")
    for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
    await owner("POST", "/v1/jobs/mail/run")
    await sent()
    await sent()
    expect((await runs("mail"))[0]).toMatchObject({
      state: "failed",
      reason:
        "could not register: mail:2026-10-28T12:00 belongs to another " +
        "session that is still there (ses_squat); the owner can force the move",
    })
    expect(
      (await owner("GET", "/v1/agents/mail:2026-10-28T12:00")).body.agent
        .session,
    ).toBe("ses_squat")
  })

  test("a destination list with owner reaches the owner and the agents", async () => {
    await owner("PUT", "/v1/jobs/mail", { ...JOB, to: "owner,team:lead" })
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    const token = await tokenOf("ses_run1")
    await as(token, "POST", "/v1/me/finish", { result: "done" })
    const item = (await owner("GET", "/v1/inbox")).body.items[0]
    expect(item.title).toBe("Result of run mail:2026-10-28T12:00")
    const mine = (await owner("GET", "/v1/messages?agent=team:lead")).body
      .messages
    expect(mine[0].subject).toBe("result of run mail:2026-10-28T12:00")
  })

  test("a long result is kept whole in the run; the message is cut", async () => {
    await owner("PUT", "/v1/jobs/mail", { ...JOB, to: "team:lead" })
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    const token = await tokenOf("ses_run1")
    const long = "x".repeat(40_000)
    await as(token, "POST", "/v1/me/finish", { result: long })
    expect((await runs("mail"))[0].result.length).toBe(40_000)
    const mine = (await owner("GET", "/v1/messages?agent=team:lead")).body
      .messages
    const text = (await owner("GET", `/v1/messages/${mine[0].id}`)).body.message
      .text
    expect(text.length).toBeLessThan(33_000)
    expect(text).toContain("(cut; the whole result is in the run: autocode")
  })

  test("delete_session: the session is removed once the run's last turn ends", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    await report(t, HOST, [{ type: "turn.started", session: "ses_run1" }])
    const token = await tokenOf("ses_run1")
    await as(token, "POST", "/v1/me/finish", { result: "done" })
    // the finish call's turn still runs: nothing removed yet
    expect((await sent()).filter((i) => i.type === "remove")).toEqual([])
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_run1", outcome: "succeeded" },
    ])
    expect(
      (await sent()).filter((i) => i.type === "remove").map((i) => i.payload),
    ).toEqual([{ session: "ses_run1" }])
  })

  test("a scheduled run refused in the same minute is recorded as skipped", async () => {
    await owner("PUT", "/v1/jobs/mail", { ...JOB, trigger: "every 1m" })
    t.clock.advance(MIN)
    // the owner's run at the minute the schedule is due; its spawn fails
    await owner("POST", "/v1/jobs/mail/run")
    for (const i of await instructions(t, HOST))
      await report(t, HOST, [{ type: "ack", id: i.id, ok: false, error: "x" }])
    await sent()
    const all = await runs("mail")
    expect(all.map((r: any) => r.state)).toEqual(["skipped", "failed"])
    expect(all[0].reason).toBe("mail:2026-10-28T12:01 was started this minute")
  })

  test("an agent named like a starter (schedule, ask) is still refused while a run works", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    const sched = await registered(t, HOST, "ses_s", "schedule")
    for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    const res = await as(sched, "POST", "/v1/jobs/mail/run")
    expect(res.status).toBe(409)
  })

  test("every keeps its anchor: no drift from late ticks", async () => {
    await owner("PUT", "/v1/jobs/mail", { ...JOB, trigger: "every 30m" })
    t.clock.advance(31 * MIN)
    t.server.tick()
    const job = (await owner("GET", "/v1/jobs")).body.jobs[0]
    expect(job.next).toBe("2026-10-28T13:00:00.000Z")
  })

  test("the failure alert names a way to delete the session", async () => {
    await owner("PUT", "/v1/jobs/mail", { ...JOB, timeout: "5m" })
    await owner("POST", "/v1/jobs/mail/run")
    await started()
    t.clock.advance(5 * MIN)
    await sent()
    const alert = (await owner("GET", "/v1/inbox")).body.items.find(
      (i: any) => i.kind === "alert",
    )
    expect(alert.body).toContain(
      "autocode job delete-session mail:2026-10-28T12:00",
    )
  })

  test("a job's host offline: the run waits for it (up to the time limit) and the loader is asked", async () => {
    await owner("PUT", "/v1/jobs/mail", JOB)
    t.server.db.query("UPDATE hosts SET online = 0 WHERE id = ?").run(HOST)
    await owner("POST", "/v1/jobs/mail/run")
    t.clock.advance(3 * MIN)
    t.server.tick()
    expect((await runs("mail"))[0].state).toBe("starting")
    await hello(t, HOST)
    await started()
  })
})
