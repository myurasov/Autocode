/*
 * What waits for the owner (1.1.0-rc2; the owner, 2026-11-20: "add red-pink
 * hilight at the top of inbox tab when it has messages for us"): the count
 * behind the Inbox tab's highlight. An open message to the owner that is
 * not a report, an open alert, and an open ask that is the owner's to
 * answer; GET /v1/inbox/count, and `open` in GET /v1/inbox.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
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
let a: string // team:a on ses_a
let b: string // team:b on ses_b
const HOST = "m:1"

const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)
const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const count = async () => (await owner("GET", "/v1/inbox/count")).body
const question = (session: string, ref: string) => ({
  type: "ask.opened",
  kind: "question",
  session,
  ref,
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
})

beforeEach(async () => {
  t = await testServer()
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  b = await registered(t, HOST, "ses_b", "team:b")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

test("messages, alerts and the owner's asks count; reports and asks sent to an agent do not; a close takes one off", async () => {
  expect(await count()).toEqual({ open: 0 })
  // a message to the owner: 1; a report: still 1
  await as(a, "POST", "/v1/messages", { to: "owner", text: "May I?" })
  await as(a, "POST", "/v1/messages", {
    to: "owner",
    text: "All folds done.",
    report: true,
  })
  expect(await count()).toEqual({ open: 1 })
  // an alert: team:a's turn failed and is not retried
  await report(t, HOST, [
    { type: "turn.started", session: "ses_a" },
    {
      type: "turn.ended",
      session: "ses_a",
      outcome: "failed",
      error: "provider.auth",
    },
  ])
  expect(await count()).toEqual({ open: 2 })
  // team:b's question goes to team:a, not to the owner: not counted; the
  // Inbox lists it all the same
  await owner("PATCH", "/v1/settings", {
    agents: { "team:b": { question_mode: "agent:team:a" } },
  })
  await report(t, HOST, [question("ses_b", "frm_b")])
  const listed = (await owner("GET", "/v1/inbox")).body
  expect(listed.items.length).toBe(4)
  expect(listed.open).toBe(2)
  // team:a hands it back to the owner: counted
  const ask = listed.items.find((i: any) => i.kind === "question")
  expect(ask.routed).toBe("agent:team:a")
  expect(
    (
      await as(a, "POST", `/v1/asks/${ask.id}/escalate`, {
        text: "I cannot say.",
      })
    ).status,
  ).toBe(200)
  expect(await count()).toEqual({ open: 3 })
  // the list's filter does not change the number
  expect((await owner("GET", "/v1/inbox?match=team:b")).body).toMatchObject({
    open: 3,
  })
  // closing the message and answering the ask take them off
  const message = listed.items.find(
    (i: any) => i.kind === "message" && !i.report,
  )
  await owner("POST", `/v1/inbox/${message.id}/close`)
  expect(await count()).toEqual({ open: 2 })
  const answered = await owner("POST", `/v1/inbox/${ask.id}/answer`, {
    answers: ["v3"],
  })
  expect(answered.status).toBe(200)
  expect(await count()).toEqual({ open: 1 })
})

test("the owner's alone: the consumer token and an agent's are refused", async () => {
  expect((await call(t.url, t.consumer, "GET", "/v1/inbox/count")).status).toBe(
    403,
  )
  expect((await as(a, "GET", "/v1/inbox/count")).status).toBe(403)
  expect(b).toBeTruthy()
})
