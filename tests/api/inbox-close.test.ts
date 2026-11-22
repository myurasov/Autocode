/*
 * An agent closes what it put into the owner's Inbox (spec, Messages and
 * Approvals; 1.1.0-rc4; the owner, 2026-11-22: "i want autocode agents to
 * be able to close messages/questions/etc in inbox when they become
 * irrelevant (eg when i answered in prompt or things changed/etc)"). Its
 * own open messages and reports to the owner, and its own open approvals
 * (a job it proposed too): POST /v1/me/inbox/close {id, text}. Not a
 * question or a permission (they close by themselves), not an alert, and
 * nothing of another agent's, an earlier holder of its ID included. A
 * reason is required: History says who closed what and why, and GET
 * /v1/me lists what the agent has open there.
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
let b: string
const HOST = "m:1"
const MIN = 60_000

const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)
const WHY = "it no longer matters"
// With a reason, unless the test gives its own (null: none at all).
const close = (token: string, id: unknown, text: unknown = WHY) =>
  as(token, "POST", "/v1/me/inbox/close", {
    ...(id === undefined ? {} : { id }),
    ...(text === null ? {} : { text }),
  })
const inbox = async () => (await owner("GET", "/v1/inbox")).body.items
const history = async (kind: string) =>
  (await owner("GET", `/v1/history?kind=${kind}`)).body.history
const status = async (agent: string) =>
  (await owner("GET", `/v1/agents/${agent}`)).body.agent.status
// A message to the owner: the ID of the owner's copy.
async function send(
  token: string,
  text: string,
  more: Record<string, unknown> = {},
): Promise<string> {
  const res = await as(token, "POST", "/v1/messages", {
    to: "owner",
    text,
    ...more,
  })
  expect(res.status).toBe(201)
  return res.body.messages[0].id
}
// One tick; the prompts it sent (acked), by session.
async function prompts(): Promise<Record<string, string>> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out) await ack(t, HOST, i.id, { ok: true })
  return Object.fromEntries(
    out
      .filter((i) => i.type === "inject")
      .map((i) => [i.payload.session, i.payload.text]),
  )
}

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

describe("a message to the owner", () => {
  test("its sender closes it by the message's ID: gone from the Inbox, read, and History says who and why", async () => {
    const id = await send(a, "Which fold split?", { subject: "folds" })
    expect((await owner("GET", "/v1/inbox/count")).body.open).toBe(1)
    const res = await close(a, id, "the owner answered in the session")
    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({
      kind: "message",
      message_id: id,
      title: 'Message from team:worker: "folds"',
    })
    expect(res.body.item.closed_at).not.toBeNull()
    expect(await inbox()).toEqual([])
    expect((await owner("GET", "/v1/inbox/count")).body.open).toBe(0)
    // the owner's copy is read, as at any close
    const copy = (await owner("GET", `/v1/messages/${id}`)).body.message
    expect(copy).toMatchObject({
      state: "processed",
      processed_via: "inbox",
    })
    const [entry] = await history("inbox.closed")
    expect(entry).toMatchObject({
      agent: "team:worker",
      data: {
        id: res.body.item.id,
        by: "team:worker",
        why: "the owner answered in the session",
        title: 'Message from team:worker: "folds"',
      },
    })
    // nothing was sent to anyone
    expect(await prompts()).toEqual({})
  })

  test("by the Inbox item's ID too, and a report too", async () => {
    const id = await send(a, "Done: 0.91.", { report: true })
    const item = (await inbox())[0]
    expect(item).toMatchObject({ report: true, message_id: id })
    const res = await close(a, item.id)
    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({ id: item.id, report: true })
    expect(await inbox()).toEqual([])
    const [entry] = await history("inbox.closed")
    expect(entry.data).toEqual({
      id: item.id,
      by: "team:worker",
      why: WHY,
      title: "Report from team:worker",
    })
  })

  test("one send to the owner and to an agent: only the owner's copy is in the Inbox", async () => {
    const res = await as(a, "POST", "/v1/messages", {
      to: ["owner", "team:lead"],
      text: "Fold 3 is done.",
    })
    const copies: any[] = res.body.messages
    const mine = copies.find((m) => m.to === "owner").id
    const other = copies.find((m) => m.to === "team:lead").id
    expect((await close(a, other)).status).toBe(404)
    expect((await close(a, mine)).status).toBe(200)
    expect(await inbox()).toEqual([])
  })

  test("after a rename the agent still closes what it sent under its old ID", async () => {
    const id = await send(a, "Which fold split?")
    await as(a, "POST", "/v1/me/rename", { id: "team:w2" })
    expect(
      (await as(a, "GET", "/v1/me")).body.inbox.map((i: any) => i.id),
    ).toEqual([id])
    expect((await close(a, id)).status).toBe(200)
    expect((await history("inbox.closed"))[0]).toMatchObject({
      agent: "team:w2",
      data: { by: "team:w2" },
    })
  })

  test("the owner's own close and answer record no agent's name", async () => {
    const id = await send(a, "One.")
    await send(a, "Two.")
    const [one, two] = await inbox()
    expect(one.message_id).toBe(id)
    await owner("POST", `/v1/inbox/${one.id}/close`)
    await owner("POST", `/v1/inbox/${two.id}/answer`, { text: "Yes." })
    const closed = await history("inbox.closed")
    expect(closed.length).toBe(1)
    expect(closed[0].data.by).toBeUndefined()
  })
})

describe("what an agent has open in the Inbox", () => {
  test("GET /v1/me lists its open messages and reports, oldest first, until they are closed or answered", async () => {
    expect((await as(a, "GET", "/v1/me")).body.inbox).toEqual([])
    const one = await send(a, "Which fold split?", { subject: "folds" })
    t.clock.advance(MIN)
    const two = await send(a, "Done: 0.91.", { report: true })
    t.clock.advance(MIN)
    const three = await send(a, "Shall I go on?")
    await send(b, "Another agent's.")
    const mine = (await as(a, "GET", "/v1/me")).body.inbox
    expect(mine).toEqual([
      {
        id: one,
        kind: "message",
        title: 'Message from team:worker: "folds"',
        created_at: "2026-10-28T12:00:00.000Z",
      },
      {
        id: two,
        kind: "report",
        title: "Report from team:worker",
        created_at: "2026-10-28T12:01:00.000Z",
      },
      {
        id: three,
        kind: "message",
        title: "Message from team:worker",
        created_at: "2026-10-28T12:02:00.000Z",
      },
    ])
    await close(a, two)
    const item = (await inbox()).find((i: any) => i.message_id === one)
    await owner("POST", `/v1/inbox/${item.id}/answer`, { text: "v3." })
    expect(
      (await as(a, "GET", "/v1/me")).body.inbox.map((i: any) => i.id),
    ).toEqual([three])
    // the other agent sees its own only
    expect((await as(b, "GET", "/v1/me")).body.inbox.length).toBe(1)
  })

  test("an alert about the agent is not among them, and not the agent's to close", async () => {
    // a turn that fails and is not retried leaves an alert
    await owner("PATCH", "/v1/settings", {
      server: { retry_attempts: 1, retry_interval: "1s" },
    })
    await report(t, HOST, [
      { type: "turn.started", session: "ses_a" },
      {
        type: "turn.ended",
        session: "ses_a",
        outcome: "failed",
        error: "the provider is down",
      },
    ])
    for (let i = 0; i < 4; i++) {
      t.clock.advance(2000)
      t.server.tick()
      for (const inj of await instructions(t, HOST)) {
        await ack(t, HOST, inj.id, { ok: true })
        if (inj.type !== "inject") continue
        await report(t, HOST, [
          { type: "turn.started", session: "ses_a" },
          {
            type: "turn.ended",
            session: "ses_a",
            outcome: "failed",
            error: "the provider is down",
          },
        ])
      }
    }
    const alert = (await inbox()).find((i: any) => i.kind === "alert")
    expect(alert).toBeDefined()
    expect(alert.agent).toBe("team:worker")
    expect((await as(a, "GET", "/v1/me")).body.inbox).toEqual([])
    const res = await close(a, alert.id)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("no_item")
    expect((await inbox()).some((i: any) => i.id === alert.id)).toBe(true)
  })
})

describe("what is refused", () => {
  test("another agent's item and an ID that names nothing get the same answer", async () => {
    const id = await send(a, "Which fold split?")
    const item = (await inbox())[0]
    for (const other of [id, item.id, "m_none", "ib_none", "ask_none"]) {
      const res = await close(b, other)
      expect(res.status, other).toBe(404)
      expect(res.body.error.code).toBe("no_item")
      expect(res.body.error.message).toBe(
        `no item of yours has the ID ${other}`,
      )
    }
    expect((await inbox()).length).toBe(1)
    expect(await history("inbox.closed")).toEqual([])
  })

  /*
   * The second review before 1.1.0-rc4: a message stays open in the Inbox
   * when its agent unregisters. The next session that takes the ID did not
   * write it, and has no memory of it.
   */
  test("the next holder of an ID neither sees nor closes what an earlier holder sent", async () => {
    const id = await send(a, "Done: 0.91.", { report: true })
    await as(a, "DELETE", "/v1/me")
    t.clock.advance(MIN)
    const next = await registered(t, HOST, "ses_next", "team:worker")
    expect((await as(next, "GET", "/v1/me")).body.inbox).toEqual([])
    const res = await close(next, id)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("no_item")
    expect((await inbox()).length).toBe(1)
    // its own it does
    const own = await send(next, "Shall I go on?")
    expect(
      (await as(next, "GET", "/v1/me")).body.inbox.map((i: any) => i.id),
    ).toEqual([own])
    expect((await close(next, own)).status).toBe(200)
  })

  test("its own item that is closed already", async () => {
    const id = await send(a, "Which fold split?")
    const item = (await inbox())[0]
    await owner("POST", `/v1/inbox/${item.id}/answer`, { text: "v3." })
    const res = await close(a, id)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("closed")
    expect(res.body.error.message).toContain("answered or closed already")
  })

  test("a call without an ID or without a reason, with one that is too long, by the owner's token or by a session that is no agent", async () => {
    const id = await send(a, "Which fold split?")
    expect((await close(a, undefined)).status).toBe(400)
    expect((await close(a, 7)).status).toBe(400)
    expect((await close(a, "m_".padEnd(256, "x"))).status).toBe(400)
    // the reason is what the owner reads in History: there must be one
    for (const none of [null, "", "  \n ", 7]) {
      const res = await close(a, id, none)
      expect(res.status, String(none)).toBe(400)
      expect(res.body.error.message).toBe(
        "close needs text: why the item no longer matters, in a line",
      )
    }
    const long = await close(a, id, "x".repeat(501))
    expect(long.status).toBe(400)
    expect(long.body.error.message).toContain("500")
    const extra = await as(a, "POST", "/v1/me/inbox/close", { id, all: true })
    expect(extra.status).toBe(400)
    expect((await close(t.admin, id)).status).toBe(403)
    await as(b, "DELETE", "/v1/me")
    const none = await close(b, id)
    expect(none.status).toBe(403)
    expect(none.body.error.code).toBe("not_registered")
    expect((await inbox()).length).toBe(1)
    // just short enough, and written on one line whatever came
    expect(
      (await close(a, id, `${"x".repeat(249)}\n \t${"y".repeat(250)}`)).status,
    ).toBe(200)
    expect((await history("inbox.closed"))[0].data.why).toBe(
      `${"x".repeat(249)} ${"y".repeat(250)}`,
    )
  })
})

describe("an approval", () => {
  test("its asker closes it: no longer waiting, its wake comes, no notice, and History says who and why", async () => {
    await as(a, "PUT", "/v1/me/wakes/tick", {
      text: "Tick.",
      trigger: "every 1m",
    })
    const res = await as(a, "POST", "/v1/me/approvals", {
      text: "Deploy v2 to production?",
      options: ["now", "tonight"],
    })
    const id = res.body.approval.id
    expect(await status("team:worker")).toBe("waiting")
    expect((await as(a, "GET", "/v1/me")).body.asks.length).toBe(1)
    // its wake waits while the approval is open
    t.clock.advance(MIN)
    expect(await prompts()).toEqual({})
    const waiting = as(a, "GET", `/v1/me/approvals/${id}?wait=10`)
    await Bun.sleep(200)
    const done = await close(a, id, "the owner said go in the session")
    expect(done.status).toBe(200)
    expect(done.body.item).toMatchObject({
      id,
      kind: "approval",
      state: "gone",
      by: "team:worker",
    })
    // a wait on it returns: closed, which is not approved
    expect((await waiting).body.approval).toMatchObject({
      state: "gone",
      by: "team:worker",
    })
    expect(await status("team:worker")).toBe("idle")
    expect((await as(a, "GET", "/v1/me")).body.asks).toEqual([])
    expect(await inbox()).toEqual([])
    const [entry] = await history("ask.closed")
    expect(entry).toMatchObject({
      agent: "team:worker",
      data: {
        id,
        by: "team:worker",
        why: "the owner said go in the session",
        title: "Approval for team:worker: Deploy v2 to production?",
      },
    })
    // the wake that waited comes, and no notice about the approval
    const text = (await prompts()).ses_a
    expect(text).toStartWith('[autocode] wake "tick"\n')
    expect(text).not.toContain("approval")
    // too late for an answer
    const late = await owner("POST", `/v1/asks/${id}/answer`, {
      decision: "approve",
    })
    expect(late.status).toBe(409)
    expect(late.body.error.code).toBe("ask_closed")
    // closed, not answered: the words say which
    expect(late.body.error.message).toBe(`ask ${id} was closed by team:worker`)
    // and closed is closed
    const again = await close(a, id)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("ask_closed")
  })

  test("one that was sent to another agent: that agent is told that it needs no answer, and finds it closed", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:worker": { approval_mode: "agent:team:lead" } },
    })
    const res = await as(a, "POST", "/v1/me/approvals", { text: "Go on?" })
    const id = res.body.approval.id
    expect((await prompts()).ses_b).toContain(id)
    await report(t, HOST, [
      { type: "turn.started", session: "ses_b" },
      { type: "turn.ended", session: "ses_b", outcome: "succeeded" },
    ])
    // not the lead's to close
    const not = await close(b, id)
    expect(not.status).toBe(404)
    expect(not.body.error.code).toBe("no_item")
    expect((await close(a, id, "the plan changed")).status).toBe(200)
    t.clock.advance(2000)
    const told = (await prompts()).ses_b
    // a notice of Autocode's own, like the one that brought the ask
    // (what the asker wrote is quoted, like anything others wrote)
    expect(told).toStartWith(
      "[autocode] approval for team:worker closed\n\n" +
        `The approval ${id} of team:worker was closed by team:worker and ` +
        "needs no answer any more.\nIt asked:\n> Go on?\nThe reason " +
        "given:\n> the plan changed\n",
    )
    const late = await as(b, "POST", `/v1/asks/${id}/answer`, {
      text: "approve",
    })
    expect(late.status).toBe(409)
    expect(late.body.error.message).toBe(`ask ${id} was closed by team:worker`)
  })

  test("the owner's own close of an ask reads as closed too, not as answered", async () => {
    const res = await as(a, "POST", "/v1/me/approvals", { text: "Go on?" })
    const id = res.body.approval.id
    await owner("POST", `/v1/asks/${id}/close`)
    const late = await owner("POST", `/v1/asks/${id}/answer`, {
      decision: "approve",
    })
    expect(late.status).toBe(409)
    expect(late.body.error.message).toBe(`ask ${id} was closed by the owner`)
    // the agent, too late with its own close
    const mine = await close(a, id)
    expect(mine.status).toBe(409)
    expect(mine.body.error.code).toBe("ask_closed")
  })

  test("a job that waits for the owner's word is taken back the same way, and is not set", async () => {
    const set = await as(a, "POST", "/v1/me/jobs", {
      name: "review",
      host: HOST,
      model: "fake/main",
      prompt: "Review the last commit.",
      trigger: "fire-only",
      run_usd: 1,
    })
    expect(set.status).toBe(202)
    const id = (await inbox())[0].id
    const res = await close(a, id, "no review needed after all")
    expect(res.status).toBe(200)
    // the answer says that it was a job's, for the tool's words
    expect(res.body.item).toMatchObject({
      id,
      kind: "approval",
      state: "gone",
      job: "team:worker:review",
    })
    expect(await inbox()).toEqual([])
    expect((await owner("GET", "/v1/jobs")).body.jobs).toEqual([])
  })
})

describe("questions and permissions", () => {
  test("are not closed by their agent: they close by themselves, and the answer says how", async () => {
    await report(t, HOST, [
      {
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
            options: [{ label: "v3", description: "folds v3" }],
          },
        ],
      },
    ])
    const ask = (await inbox())[0]
    expect(ask.kind).toBe("question")
    const res = await close(a, ask.id)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("bad_request")
    expect(res.body.error.message).toBe(
      "a question closes by itself: when it is answered in OpenCode, when " +
        "its turn ends, or when OpenCode no longer has it",
    )
    expect((await inbox()).length).toBe(1)
    expect(await status("team:worker")).toBe("waiting")
  })
})
