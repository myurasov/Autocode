/*
 * Questions, permission prompts and approvals (spec, Questions and
 * Permissions; Approvals; tier 0d), with the plugin played over its channel:
 * an open question or permission reported by the plugin becomes an ask,
 * routed by question_mode, permission_mode or approval_mode (resolved per
 * agent and pattern): answered at once (auto_answer, allow), left to the owner
 * (ask), or sent to another agent (agent:<id>) as a notice while the owner's
 * inbox has it too. The first answer wins and goes back as an instruction to
 * the plugin; an agent answers once or reject only and may escalate; the
 * asking agent is `waiting` and its wakes wait; asks settled in the TUI or
 * whose session went away close. Approvals: ask, wait, the answer as a
 * notice, expiry.
 */
import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
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
let b: string
const HOST = "m:1"
const MIN = 60_000

const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)

// What the plugin sees when the question tool opens a form (OpenCode 2.2.0).
const QUESTION = {
  type: "ask.opened",
  kind: "question",
  session: "ses_a",
  ref: "frm_1",
  title: "Questions",
  questions: [
    {
      key: "q0",
      header: "Which fold?",
      question: "Which fold split should I use?",
      multiple: false,
      options: [
        { label: "v3", description: "folds v3" },
        { label: "v2", description: "the old ones" },
      ],
    },
  ],
}
const PERMISSION = {
  type: "ask.opened",
  kind: "permission",
  session: "ses_a",
  ref: "per_1",
  title: "shell",
  action: "shell",
  resources: ["rm -rf build"],
  save: ["rm *"],
}

// One tick; the instructions it sent (acked), by type.
async function sent(): Promise<any[]> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out) await ack(t, HOST, i.id, { ok: true })
  return out
}
const answers = async () =>
  (await sent()).filter((i) => i.type === "answer").map((i) => i.payload)
const prompts = async () =>
  Object.fromEntries(
    (await sent())
      .filter((i) => i.type === "inject")
      .map((i) => [i.payload.session, i.payload.text]),
  )
const inbox = async () => (await owner("GET", "/v1/inbox")).body.items
const askOf = async () =>
  (await inbox()).find((i: any) => i.kind !== "message" && i.kind !== "alert")

beforeEach(async () => {
  t = await testServer()
  await owner("PATCH", "/v1/settings", {
    server: { timezone: "America/Los_Angeles", min_interval: "1s" },
  })
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:worker")
  b = await registered(t, HOST, "ses_b", "team:lead")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("questions", () => {
  test("ask (the default): an inbox item; the owner's answer goes back to the form; the agent waits meanwhile", async () => {
    await report(t, HOST, [QUESTION])
    const item = await askOf()
    expect(item).toMatchObject({
      kind: "question",
      agent: "team:worker",
      title: "Question from team:worker: Which fold?",
      routed: "owner",
      questions: [
        {
          question: "Which fold split should I use?",
          options: ["v3", "v2"],
          multiple: false,
        },
      ],
    })
    expect(
      (await owner("GET", "/v1/agents/team:worker")).body.agent.status,
    ).toBe("waiting")
    const res = await owner("POST", `/v1/asks/${item.id}/answer`, {
      text: "v3",
    })
    expect(res.status).toBe(200)
    expect(await answers()).toEqual([
      {
        session: "ses_a",
        kind: "question",
        ref: "frm_1",
        answer: { q0: "v3" },
      },
    ])
    expect(await inbox()).toEqual([])
    // a later answer is refused
    const again = await owner("POST", `/v1/asks/${item.id}/answer`, {
      text: "v2",
    })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("ask_closed")
    // OpenCode's own reply settles it; the agent is no longer waiting
    await report(t, HOST, [
      { type: "ask.settled", session: "ses_a", ref: "frm_1", how: "answered" },
    ])
    expect(
      (await owner("GET", "/v1/agents/team:worker")).body.agent.status,
    ).toBe("idle")
    const h = (await owner("GET", "/v1/history?kind=ask.*")).body.history
    expect(h.map((e: any) => e.kind).reverse()).toEqual([
      "ask.opened",
      "ask.answered",
    ])
    expect(h[0].data).toMatchObject({ by: "owner", id: item.id })
  })

  test("a free text answer to a question with several questions: each its own field", async () => {
    await report(t, HOST, [
      {
        ...QUESTION,
        questions: [
          QUESTION.questions[0],
          { key: "q1", header: "Why?", question: "Why?", options: [] },
        ],
      },
    ])
    const item = await askOf()
    await owner("POST", `/v1/asks/${item.id}/answer`, {
      answers: ["v2", "it is faster"],
    })
    expect((await answers())[0].answer).toEqual({
      q0: "v2",
      q1: "it is faster",
    })
  })

  test("auto_answer: dismissed at once with auto_answer_text, nothing in the inbox", async () => {
    await owner("PATCH", "/v1/settings", {
      server: { question_mode: "auto_answer" },
    })
    await report(t, HOST, [QUESTION])
    expect(await answers()).toEqual([
      {
        session: "ses_a",
        kind: "question",
        ref: "frm_1",
        cancel:
          "Act according to your best judgement and safe practices to " +
          "achieve my goals.",
      },
    ])
    expect(await inbox()).toEqual([])
    const h = (await owner("GET", "/v1/history?kind=ask.answered")).body.history
    // who answered keeps its word: "auto", at once by the setting
    expect(h[0].data).toMatchObject({ by: "auto" })
    // how it was routed is the setting's value (1.1.0-rc6: its new name)
    const opened = (await owner("GET", "/v1/history?kind=ask.opened")).body
      .history
    expect(opened[0].data).toMatchObject({ routed: "auto_answer" })
  })

  test("a session that is no agent's is left alone", async () => {
    await report(t, HOST, [{ ...QUESTION, session: "ses_loose" }])
    expect(await inbox()).toEqual([])
    expect(await answers()).toEqual([])
  })

  test("answered in the TUI: the item closes", async () => {
    await report(t, HOST, [QUESTION])
    await report(t, HOST, [
      { type: "ask.settled", session: "ses_a", ref: "frm_1", how: "answered" },
    ])
    expect(await inbox()).toEqual([])
    expect(
      (await owner("GET", "/v1/history?kind=ask.settled")).body.history[0].data,
    ).toMatchObject({ how: "answered" })
  })

  test("the same form reported again (a reconnect) is one ask", async () => {
    await report(t, HOST, [QUESTION])
    await report(t, HOST, [QUESTION])
    expect((await inbox()).length).toBe(1)
  })
})

describe("permissions", () => {
  test("ask: once, always or reject from the owner; reject carries the text", async () => {
    await report(t, HOST, [PERMISSION])
    const item = await askOf()
    expect(item).toMatchObject({
      kind: "permission",
      title: "Permission for team:worker: shell rm -rf build",
      action: "shell",
      resources: ["rm -rf build"],
      decisions: ["once", "always", "reject"],
    })
    const bad = await owner("POST", `/v1/asks/${item.id}/answer`, {
      decision: "maybe",
    })
    expect(bad.status).toBe(400)
    await owner("POST", `/v1/asks/${item.id}/answer`, {
      decision: "reject",
      text: "not the build folder",
    })
    expect(await answers()).toEqual([
      {
        session: "ses_a",
        kind: "permission",
        ref: "per_1",
        decision: "reject",
        message: "not the build folder",
      },
    ])
  })

  test("allow: once, at once", async () => {
    await owner("PATCH", "/v1/settings", {
      rules: [{ match: "team:*", settings: { permission_mode: "allow" } }],
    })
    await report(t, HOST, [PERMISSION])
    expect(await answers()).toEqual([
      { session: "ses_a", kind: "permission", ref: "per_1", decision: "once" },
    ])
    expect(await inbox()).toEqual([])
    const opened = (await owner("GET", "/v1/history?kind=ask.opened")).body
      .history
    expect(opened[0].data).toMatchObject({ routed: "allow" })
  })
})

describe("answers by another agent", () => {
  test("agent:<id>: a notice to that agent, the item in the owner's inbox too; the agent's answer goes in", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:worker": { question_mode: "agent:team:lead" } },
    })
    await report(t, HOST, [QUESTION])
    const item = await askOf()
    expect(item.routed).toBe("agent:team:lead")
    const notice = (await prompts()).ses_b
    expect(notice).toStartWith(
      '[autocode] question from team:worker: "Which fold?"\n\n',
    )
    expect(notice).toContain("Which fold split should I use?")
    expect(notice).toContain("- v3: folds v3")
    expect(notice).toContain(
      `autocode_message action=answer id=${item.id} text=...`,
    )
    expect(notice).toContain(`action=escalate id=${item.id}`)
    const res = await as(b, "POST", `/v1/asks/${item.id}/answer`, {
      text: "v3",
    })
    expect(res.status).toBe(200)
    expect((await answers())[0]).toMatchObject({ answer: { q0: "v3" } })
    const h = (await owner("GET", "/v1/history?kind=ask.answered")).body.history
    expect(h[0].data).toMatchObject({ by: "team:lead" })
  })

  test("the owner answers first: the agent's later answer is refused", async () => {
    await owner("PATCH", "/v1/settings", {
      server: { question_mode: "agent:team:lead" },
    })
    await report(t, HOST, [QUESTION])
    const item = await askOf()
    await owner("POST", `/v1/asks/${item.id}/answer`, { text: "v2" })
    const late = await as(b, "POST", `/v1/asks/${item.id}/answer`, {
      text: "v3",
    })
    expect(late.status).toBe(409)
    expect(late.body.error.message).toContain("already answered by the owner")
  })

  test("only the agent it was sent to (or the owner) answers", async () => {
    await report(t, HOST, [QUESTION])
    const item = await askOf()
    const res = await as(b, "POST", `/v1/asks/${item.id}/answer`, {
      text: "v3",
    })
    expect(res.status).toBe(403)
  })

  test("a delegated permission: once or reject; always is the owner's", async () => {
    await owner("PATCH", "/v1/settings", {
      server: { permission_mode: "agent:team:lead" },
    })
    await report(t, HOST, [PERMISSION])
    const item = await askOf()
    const notice = (await prompts()).ses_b
    expect(notice).toStartWith(
      "[autocode] permission for team:worker: shell rm -rf build",
    )
    expect(notice).toContain("text=once or text=reject")
    const always = await as(b, "POST", `/v1/asks/${item.id}/answer`, {
      text: "always",
    })
    expect(always.status).toBe(403)
    expect(always.body.error.message).toContain("only the owner")
    await as(b, "POST", `/v1/asks/${item.id}/answer`, { text: "once" })
    expect((await answers())[0]).toMatchObject({ decision: "once" })
  })

  test("escalate: the reason on the owner's item; the owner answers; the agent is not locked out", async () => {
    await owner("PATCH", "/v1/settings", {
      server: { question_mode: "agent:team:lead" },
    })
    await report(t, HOST, [QUESTION])
    const item = await askOf()
    const res = await as(b, "POST", `/v1/asks/${item.id}/escalate`, {
      text: "I do not know the folds",
    })
    expect(res.status).toBe(200)
    expect((await askOf()).notes).toEqual([
      "team:lead cannot answer: I do not know the folds",
    ])
    expect(
      (await owner("GET", "/v1/history?kind=ask.escalated")).body.history[0]
        .agent,
    ).toBe("team:lead")
    await owner("POST", `/v1/asks/${item.id}/answer`, { text: "v3" })
    expect((await answers()).length).toBe(1)
  })

  test("its own ask, or an agent that is not registered: the owner alone", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: {
        "team:worker": { question_mode: "agent:team:worker" },
        "team:lead": { question_mode: "agent:team:nobody" },
      },
    })
    await report(t, HOST, [
      QUESTION,
      { ...QUESTION, session: "ses_b", ref: "frm_2" },
    ])
    const items = await inbox()
    expect(items.map((i: any) => i.routed)).toEqual(["owner", "owner"])
    expect(await prompts()).toEqual({})
  })

  /*
   * 1.1.0-rc6: a value that is none of a setting's is refused on input,
   * and migration 30 renames the old names, so only a database edited by
   * hand holds one. Such a value sends the ask to the owner: an ask is
   * never left with nobody to answer it.
   */
  test("a stored value that is none of the setting's sends the ask to the owner", async () => {
    const db = new Database(join(t.dataDir, "autocode.db"))
    const odd: [string, string][] = [
      ["question_mode", "auto"],
      ["permission_mode", "approve"],
      ["approval_mode", "approve"],
    ]
    for (const [key, value] of odd)
      db.run(
        "INSERT OR REPLACE INTO settings (scope, key, value) VALUES " +
          "('server', ?, ?)",
        [key, JSON.stringify(value)],
      )
    db.close()
    await report(t, HOST, [QUESTION])
    await report(t, HOST, [{ ...PERMISSION, session: "ses_b" }])
    expect(await answers()).toEqual([])
    expect(
      (await inbox()).map((i: any) => [i.kind, i.routed, i.state]).sort(),
    ).toEqual([
      ["permission", "owner", "open"],
      ["question", "owner", "open"],
    ])
    // the owner answers the question; only that answer goes out
    const first = (await inbox()).find((i: any) => i.kind === "question")
    await owner("POST", `/v1/asks/${first.id}/answer`, { text: "v3" })
    expect((await answers()).map((x: any) => x.ref)).toEqual(["frm_1"])
    const res = await as(a, "POST", "/v1/me/approvals", { text: "Go?" })
    expect(res.body.approval).toMatchObject({ state: "open", routed: "owner" })
    // a value of another kind's setting is no better
    const again = new Database(join(t.dataDir, "autocode.db"))
    again.run(
      "UPDATE settings SET value = '\"allow\"' WHERE key = 'question_mode'",
    )
    again.close()
    await report(t, HOST, [{ ...QUESTION, ref: "frm_9" }])
    expect(await answers()).toEqual([])
    expect(
      (await inbox())
        .filter((i: any) => i.kind === "question" && i.state === "open")
        .map((i: any) => i.routed),
    ).toEqual(["owner"])
  })

  test("job:<name> of no such job is the owner's", async () => {
    await owner("PATCH", "/v1/settings", {
      server: { question_mode: "job:answerer" },
    })
    await report(t, HOST, [QUESTION])
    expect((await askOf()).routed).toBe("owner")
  })

  test("modes take agent:<id> and job:<name>; others are refused", async () => {
    for (const value of [
      "agent:team:lead",
      "job:answerer",
      "ask",
      "auto_answer",
    ]) {
      const res = await owner("PATCH", "/v1/settings", {
        server: { question_mode: value },
      })
      expect(res.status, value).toBe(200)
    }
    for (const value of ["agent:", "agent:owner", "job:", "maybe", "allow"]) {
      const res = await owner("PATCH", "/v1/settings", {
        server: { question_mode: value },
      })
      expect(res.status, value).toBe(400)
    }
    expect(
      (
        await owner("PATCH", "/v1/settings", {
          server: { permission_mode: "auto_answer" },
        })
      ).status,
    ).toBe(400)
  })

  /*
   * 1.1.0-rc6 (the owner, 2026-11-22: "lets rename: "approve" to "allow"
   * "auto" to "auto_answer" "off" to "deny""): an old name is refused in
   * every scope, the message names the new one, and nothing is stored.
   */
  test("an old name of a mode value is refused, with the new one", async () => {
    const old: [string, string, string][] = [
      ["question_mode", "auto", "auto_answer"],
      ["permission_mode", "approve", "allow"],
      ["approval_mode", "approve", "allow"],
      ["job_mode", "approve", "allow"],
      ["job_mode", "off", "deny"],
      ["wake_mode", "approve", "allow"],
      ["wake_mode", "off", "deny"],
    ]
    for (const [key, was, now] of old)
      for (const body of [
        { server: { [key]: was } },
        { rules: [{ match: "team:*", settings: { [key]: was } }] },
        { agents: { "team:worker": { [key]: was } } },
      ]) {
        const res = await owner("PATCH", "/v1/settings", body)
        expect(res.status, `${key} ${was}`).toBe(400)
        expect(res.body.error.code).toBe("bad_setting")
        expect(res.body.error.message).toContain(
          `${key}: "${was}" is now "${now}" (renamed in 1.1.0-rc6)`,
        )
      }
    const view = (await owner("GET", "/v1/settings")).body
    for (const [key] of old) expect(view.server[key], key).toBeUndefined()
    expect(view.rules).toEqual([])
    expect(view.agents).toEqual({})
    // what the schema offers, and the defaults
    expect(view.schema.question_mode.values).toEqual(["ask", "auto_answer"])
    expect(view.schema.permission_mode.values).toEqual(["ask", "allow"])
    expect(view.schema.approval_mode.values).toEqual(["ask", "allow"])
    expect(view.schema.job_mode.values).toEqual(["ask", "allow", "deny"])
    expect(view.schema.wake_mode.values).toEqual(["ask", "allow", "deny"])
    expect(view.schema.wake_mode.default).toBe("allow")
  })
})

describe("waiting", () => {
  test("wakes and messages wait while an ask is open, then come", async () => {
    await report(t, HOST, [QUESTION])
    await as(a, "PUT", "/v1/me/wakes/tick", {
      text: "Tick.",
      trigger: "every 1m",
    })
    t.clock.advance(MIN)
    expect((await prompts()).ses_a).toBeUndefined()
    const item = await askOf()
    await owner("POST", `/v1/asks/${item.id}/answer`, { text: "v3" })
    await report(t, HOST, [
      { type: "ask.settled", session: "ses_a", ref: "frm_1", how: "answered" },
    ])
    t.clock.advance(2000)
    expect((await prompts()).ses_a).toStartWith('[autocode] wake "tick"')
  })

  test("a deleted session's asks close", async () => {
    await report(t, HOST, [QUESTION])
    await report(t, HOST, [{ type: "session.deleted", session: "ses_a" }])
    expect(await inbox()).toEqual([])
  })

  test("/v1/me says what is open", async () => {
    await report(t, HOST, [QUESTION])
    const me = (await as(a, "GET", "/v1/me")).body
    expect(me.agent.status).toBe("waiting")
    expect(me.asks).toEqual([
      expect.objectContaining({ kind: "question", title: expect.any(String) }),
    ])
  })
})

describe("approvals", () => {
  test("ask: an inbox item with options; the owner approves; the answer comes as a notice and ends the wait", async () => {
    const res = await as(a, "POST", "/v1/me/approvals", {
      text: "Deploy v2 to production?",
      options: ["now", "tonight"],
      expires: "1h",
    })
    expect(res.status).toBe(201)
    const id = res.body.approval.id
    expect(res.body.approval).toMatchObject({
      state: "open",
      expires: "2026-10-28T13:00:00.000Z",
    })
    // an agent calls the tool during a turn
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    const item = await askOf()
    expect(item).toMatchObject({
      id,
      kind: "approval",
      title: "Approval for team:worker: Deploy v2 to production?",
      options: ["now", "tonight"],
    })
    expect(
      (await owner("GET", "/v1/agents/team:worker")).body.agent.status,
    ).toBe("waiting")
    const waiting = as(a, "GET", `/v1/me/approvals/${id}?wait=10`)
    await Bun.sleep(200)
    await owner("POST", `/v1/asks/${id}/answer`, {
      decision: "approve",
      option: "tonight",
      text: "after 22:00",
    })
    const done = (await waiting).body.approval
    expect(done).toMatchObject({
      state: "approved",
      option: "tonight",
      note: "after 22:00",
      by: "owner",
    })
    // the approval was asked during a turn; it ends, then the notice comes
    expect(
      (await owner("GET", "/v1/agents/team:worker")).body.agent.status,
    ).toBe("working")
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    const notice = (await prompts()).ses_a
    expect(notice).toStartWith(
      '[autocode] approval "Deploy v2 to production?" approved\n\n',
    )
    expect(notice).toContain("Option: tonight. Note: after 22:00")
  })

  test("expiry counts as rejected, and the agent is told", async () => {
    const res = await as(a, "POST", "/v1/me/approvals", {
      text: "Pay the invoice?",
      expires: "10m",
    })
    const id = res.body.approval.id
    t.clock.advance(10 * MIN)
    const notice = (await prompts()).ses_a
    expect(notice).toStartWith(
      '[autocode] approval "Pay the invoice?" rejected (expired)',
    )
    expect(
      (await as(a, "GET", `/v1/me/approvals/${id}`)).body.approval.state,
    ).toBe("expired")
    expect(await inbox()).toEqual([])
  })

  test("allow mode approves at once; agent:<id> sends it to that agent", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: {
        "team:worker": { approval_mode: "allow" },
        "team:lead": { approval_mode: "agent:team:worker" },
      },
    })
    const quick = await as(a, "POST", "/v1/me/approvals", { text: "Go?" })
    expect(quick.body.approval.state).toBe("approved")
    const sentOn = await as(b, "POST", "/v1/me/approvals", {
      text: "Merge it?",
    })
    const id = sentOn.body.approval.id
    expect((await prompts()).ses_a).toStartWith(
      '[autocode] approval for team:lead: "Merge it?"',
    )
    await as(a, "POST", `/v1/asks/${id}/answer`, { text: "approve" })
    expect(
      (await as(b, "GET", `/v1/me/approvals/${id}`)).body.approval,
    ).toMatchObject({ state: "approved", by: "team:worker" })
  })

  test("approvals need text; options are short; expiry a duration", async () => {
    for (const body of [
      {},
      { text: "" },
      { text: "x", options: "a" },
      { text: "x", expires: "soon" },
      { text: "x", hold: false },
    ]) {
      const res = await as(a, "POST", "/v1/me/approvals", body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })
})

describe("the owner's inbox lists every kind", () => {
  test("messages, alerts and asks together, oldest first", async () => {
    await as(a, "POST", "/v1/messages", { to: "owner", text: "FYI" })
    t.clock.advance(1000)
    await report(t, HOST, [QUESTION])
    t.clock.advance(1000)
    await as(a, "POST", "/v1/me/approvals", { text: "Go?" })
    expect((await inbox()).map((i: any) => i.kind)).toEqual([
      "message",
      "question",
      "approval",
    ])
  })
  // The owner, 2026-11-17: "add filtering by agent name on inbox tab": an
  // agent pattern, as on the other tabs; an ask sent to another agent
  // matches that agent too; items without an agent match none.
  test("?match= filters by an agent pattern: whose item, or the agent an ask went to", async () => {
    await as(a, "POST", "/v1/messages", {
      to: "owner",
      text: "from the worker",
    })
    await as(b, "POST", "/v1/messages", { to: "owner", text: "from the lead" })
    await owner("PATCH", "/v1/settings", {
      agents: { "team:worker": { approval_mode: "agent:team:lead" } },
    })
    await as(a, "POST", "/v1/me/approvals", { text: "Go?" })
    const items = async (q: string) =>
      (await owner("GET", `/v1/inbox?${q}`)).body.items.map(
        (i: any) => `${i.kind}:${i.agent}`,
      )
    expect(await items("match=team:worker")).toEqual([
      "message:team:worker",
      "approval:team:worker",
    ])
    // the lead's own message, and the approval sent to it
    expect(await items("match=team:lead")).toEqual([
      "message:team:lead",
      "approval:team:worker",
    ])
    expect(await items("match=team:*")).toHaveLength(3)
    expect(await items("match=team:worker,other:*")).toHaveLength(2)
    expect(await items("match=other:*")).toEqual([])
    // with Closed too
    const [first] = (await owner("GET", "/v1/inbox")).body.items
    await owner("POST", `/v1/inbox/${first.id}/close`)
    expect(await items("all=1&match=team:worker")).toEqual([
      "message:team:worker",
      "approval:team:worker",
    ])
    expect(await items("match=team:worker")).toEqual(["approval:team:worker"])
    // a bad pattern is the API's own error
    const bad = await owner("GET", "/v1/inbox?match=a%20b")
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe("bad_pattern")
  })

  // The owner, 2026-11-17: "on inbox i want close all button". It closes the
  // open messages and alerts (of the agents that match, with ?match=); asks
  // stay open: an agent's turn waits for their answer.
  test("close-all closes the open messages and alerts (of matching agents); asks stay open", async () => {
    await as(a, "POST", "/v1/messages", { to: "owner", text: "one" })
    await as(a, "POST", "/v1/messages", { to: "owner", text: "two" })
    await as(b, "POST", "/v1/messages", { to: "owner", text: "lead's" })
    await as(a, "POST", "/v1/me/approvals", { text: "Go?" })
    const kinds = async (q = "") =>
      (await owner("GET", `/v1/inbox${q}`)).body.items.map(
        (i: any) => `${i.kind}:${i.agent}`,
      )
    // with a pattern: only the worker's
    const some = await owner("POST", "/v1/inbox/close-all?match=team:w*")
    expect(some.status).toBe(200)
    expect(some.body.closed).toBe(2)
    expect(await kinds()).toEqual(["message:team:lead", "approval:team:worker"])
    // the messages count as processed, as with Close
    const worker = (
      await owner("GET", "/v1/messages?agent=team:worker")
    ).body.messages.filter((m: any) => m.to === "owner")
    expect(worker.map((m: any) => m.state)).toEqual(["processed", "processed"])
    // all of them; the ask stays
    const rest = await owner("POST", "/v1/inbox/close-all")
    expect(rest.body.closed).toBe(1)
    expect(await kinds()).toEqual(["approval:team:worker"])
    expect((await owner("POST", "/v1/inbox/close-all")).body.closed).toBe(0)
    const closed = (await owner("GET", "/v1/history?kind=inbox.closed")).body
      .history
    expect(closed.length).toBe(3)
    // a bad pattern is the API's own error; the owner's only
    const bad = await owner("POST", "/v1/inbox/close-all?match=a%20b")
    expect(bad.body.error.code).toBe("bad_pattern")
    expect((await as(a, "POST", "/v1/inbox/close-all")).status).toBe(403)
  })

  // The owner, 2026-11-17: "close all button should close only sessions
  // visible (considering filter if any)": the page sends the items it shows;
  // only those close, and only the open messages and alerts among them.
  test("close-all with ids closes only those, of the open messages and alerts; others stay", async () => {
    for (const text of ["one", "two", "three"])
      await as(a, "POST", "/v1/messages", { to: "owner", text })
    await as(a, "POST", "/v1/me/approvals", { text: "Go?" })
    const items = (await owner("GET", "/v1/inbox")).body.items
    const byText = (t: string) => items.find((i: any) => i.body === t)
    const ask = items.find((i: any) => i.kind === "approval")
    const res = await owner("POST", "/v1/inbox/close-all", {
      ids: [byText("one").id, byText("two").id, ask.id, "ib_nope"],
    })
    expect(res.status).toBe(200)
    // the ask and an unknown ID are skipped, not errors
    expect(res.body.closed).toBe(2)
    const open = (await owner("GET", "/v1/inbox")).body.items
    expect(open.map((i: any) => i.body ?? i.kind).sort()).toEqual([
      "approval",
      "three",
    ])
    // closed already: skipped; ?match= still applies
    const again = await owner("POST", "/v1/inbox/close-all?match=other:*", {
      ids: [byText("one").id, byText("three").id],
    })
    expect(again.body.closed).toBe(0)
    // not a list of IDs
    const bad = await owner("POST", "/v1/inbox/close-all", { ids: "x" })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe("bad_request")
  })

  // The agents CI (2026-11-08): the owner answers what the inbox lists by
  // its ID, an ask too (models ask approval for "ask the owner").
  test("an ask is answered and closed through the inbox's own routes too", async () => {
    const res = await as(a, "POST", "/v1/me/approvals", { text: "Delete?" })
    const id = res.body.approval.id
    const answered = await owner("POST", `/v1/inbox/${id}/answer`, {
      text: "Yes, you may delete them.",
    })
    expect(answered.status).toBe(200)
    expect(answered.body.item).toMatchObject({
      id,
      kind: "approval",
      state: "answered",
      answer: { decision: "approve", text: "you may delete them." },
    })
    await report(t, HOST, [QUESTION])
    const q = await askOf()
    const closed = await owner("POST", `/v1/inbox/${q.id}/close`)
    expect(closed.status).toBe(200)
    expect(closed.body.item).toMatchObject({ id: q.id, state: "gone" })
    expect(await askOf()).toBeUndefined()
  })
})

// The adversarial review of 0d (2026-11-07).
describe("review of 0d", () => {
  test("a settled form reported again (a late list at hello) opens no second ask", async () => {
    await report(t, HOST, [QUESTION])
    await report(t, HOST, [
      { type: "ask.settled", session: "ses_a", ref: "frm_1", how: "answered" },
    ])
    await report(t, HOST, [QUESTION])
    expect(await askOf()).toBeUndefined()
    expect(
      (await owner("GET", "/v1/agents/team:worker")).body.agent.status,
    ).toBe("idle")
  })

  test("a turn that ends closes its open question and permission (a form only lives in its tool call)", async () => {
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [QUESTION, PERMISSION])
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "interrupted" },
    ])
    expect(await askOf()).toBeUndefined()
    const all = (await owner("GET", "/v1/inbox?all=1")).body.items
    expect(
      all.filter((i: any) => i.kind !== "message").map((i: any) => i.state),
    ).toEqual(["gone", "gone"])
  })

  test("a hello's pending list closes the asks OpenCode no longer has", async () => {
    await report(t, HOST, [QUESTION, PERMISSION])
    await hello(t, HOST, {
      pending: { ses_a: ["per_1"] },
    })
    const open = (await inbox()).filter((i: any) => i.kind !== "message")
    expect(open.map((i: any) => i.kind)).toEqual(["permission"])
  })

  test("the owner closes an ask", async () => {
    await report(t, HOST, [QUESTION])
    const item = await askOf()
    const res = await owner("POST", `/v1/asks/${item.id}/close`)
    expect(res.status).toBe(200)
    expect(res.body.ask.state).toBe("gone")
    expect(await askOf()).toBeUndefined()
    // closing again is a 409
    expect((await owner("POST", `/v1/asks/${item.id}/close`)).status).toBe(409)
  })

  test("an answer the plugin could not carry out opens the ask again, with an alert", async () => {
    await report(t, HOST, [QUESTION])
    const item = await askOf()
    await owner("POST", `/v1/asks/${item.id}/answer`, { text: "v3" })
    t.server.tick()
    for (const i of await instructions(t, HOST))
      await report(t, HOST, [
        { type: "ack", id: i.id, ok: false, error: "no local API for forms" },
      ])
    t.server.tick()
    const again = await askOf()
    expect(again).toMatchObject({ id: item.id, state: "open" })
    expect(again.notes.at(-1)).toBe(
      "the answer did not reach OpenCode: no local API for forms",
    )
    const alert = (await inbox()).find((i: any) => i.kind === "alert")
    expect(alert.title).toBe(
      "An answer to team:worker's question did not reach OpenCode",
    )
  })

  test("a Subagent's form: the answer goes to the session the form is in", async () => {
    await report(t, HOST, [
      { ...QUESTION, ref: "frm_sub", form_session: "ses_child" },
    ])
    const item = await askOf()
    await owner("POST", `/v1/asks/${item.id}/answer`, { text: "v2" })
    expect(await answers()).toEqual([
      {
        session: "ses_a",
        form_session: "ses_child",
        kind: "question",
        ref: "frm_sub",
        answer: { q0: "v2" },
      },
    ])
  })

  test("answer keys are the ones the plugin reported", async () => {
    await report(t, HOST, [
      {
        ...QUESTION,
        ref: "frm_k",
        questions: [{ ...QUESTION.questions[0]!, key: "fold" }],
      },
    ])
    const item = await askOf()
    await owner("POST", `/v1/asks/${item.id}/answer`, { text: "v3" })
    expect((await answers())[0].answer).toEqual({ fold: "v3" })
  })

  test("job:<name> that cannot start a run now (one started this minute): the owner's", async () => {
    await owner("PUT", "/v1/jobs/quick", {
      host: HOST,
      model: "fake/main",
      prompt: "Answer.",
      trigger: "fire-only",
    })
    await owner("POST", "/v1/jobs/quick/run")
    // the run ends at once (its spawn failed)
    t.server.tick()
    for (const i of await instructions(t, HOST))
      await report(t, HOST, [{ type: "ack", id: i.id, ok: false, error: "x" }])
    t.server.tick()
    await owner("PATCH", "/v1/settings", {
      agents: { "team:worker": { approval_mode: "job:quick" } },
    })
    const res = await as(a, "POST", "/v1/me/approvals", { text: "Go?" })
    expect(res.status).toBe(201)
    expect(res.body.approval.routed).toBe("owner")
  })
})
