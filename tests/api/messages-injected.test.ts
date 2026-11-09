/*
 * Phase 1 (the owner, 2026-11-08: option C): messages reach an agent only in
 * an injection, always whole. No `inline_limit`; a copy is queued, then
 * delivered (no `read` state); one prompt carries messages up to 32,000
 * characters of their text together, the rest wait for the next one; the
 * agent's own message routes are gone, and /v1/me says how many wait. The
 * owner's views keep every message.
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

const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)
const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)

async function prompts(): Promise<any[]> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out) await ack(t, HOST, i.id, { ok: true })
  return out.filter((i) => i.type === "inject")
}
const promptFor = async (session: string) =>
  (await prompts()).find((p) => p.payload.session === session)
const turnEnds = (session: string) =>
  report(t, HOST, [{ type: "turn.ended", session, outcome: "succeeded" }])

beforeEach(async () => {
  t = await testServer()
  await owner("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  b = await registered(t, HOST, "ses_b", "team:b")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("messages through injections only", () => {
  test("a long message arrives whole, and is then delivered", async () => {
    const long = "x".repeat(5000)
    const sent = await as(a, "POST", "/v1/messages", {
      to: "team:b",
      text: long,
    })
    const id = sent.body.messages[0].id
    const text = (await promptFor("ses_b")).payload.text as string
    expect(text).toContain(`Message ${id} from agent team:a:`)
    expect(text).toContain(`> ${long}`)
    expect(text).not.toContain("read it with")
    const view = (await owner("GET", `/v1/messages/${id}`)).body.message
    expect(view.state).toBe("delivered")
    expect(view).not.toHaveProperty("read_at")
  })

  test("one prompt carries up to 32,000 characters of messages; the rest come in the next", async () => {
    await owner("POST", "/v1/agents/team:b/pause")
    for (const n of [1, 2, 3])
      await as(a, "POST", "/v1/messages", {
        to: "team:b",
        text: `${n}${"y".repeat(14_999)}`,
      })
    await owner("POST", "/v1/agents/team:b/resume")
    const first = (await promptFor("ses_b")).payload.text as string
    expect(first).toStartWith("[autocode] 2 messages\n")
    expect(first).toContain(`> 1${"y".repeat(14_999)}`)
    expect(first).toContain(`> 2${"y".repeat(14_999)}`)
    expect(first).not.toContain(`> 3${"y"}`)
    await report(t, HOST, [{ type: "turn.started", session: "ses_b" }])
    await turnEnds("ses_b")
    t.clock.advance(2000)
    const second = (await promptFor("ses_b")).payload.text as string
    expect(second).toStartWith("[autocode] 1 message\n")
    expect(second).toContain(`> 3${"y".repeat(14_999)}`)
  })

  test("inline_limit is no setting any more; a stored value is ignored", async () => {
    const res = await owner("PATCH", "/v1/settings", {
      server: { inline_limit: 10 },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain("inline_limit")
    const schema = (await owner("GET", "/v1/settings")).body.schema
    expect(schema).not.toHaveProperty("inline_limit")
    expect((await as(a, "GET", "/v1/me")).body.settings).not.toHaveProperty(
      "inline_limit",
    )
  })

  test("the agent's message routes are gone; /v1/me says how many wait", async () => {
    await owner("POST", "/v1/agents/team:b/pause")
    const sent = await as(a, "POST", "/v1/messages", {
      to: "team:b",
      text: "hello",
    })
    const id = sent.body.messages[0].id
    expect((await as(b, "GET", "/v1/me/messages")).status).toBe(404)
    expect((await as(b, "GET", `/v1/me/messages/${id}`)).status).toBe(404)
    const me = (await as(b, "GET", "/v1/me")).body
    expect(me.waiting).toBe(1)
    expect(me).not.toHaveProperty("unread")
    await owner("POST", "/v1/agents/team:b/resume")
    expect((await promptFor("ses_b")).payload.text).toContain("> hello")
    expect((await as(b, "GET", "/v1/me")).body.waiting).toBe(0)
  })

  test("a message sent during a turn comes when that turn ends; a reply wakes the agent that waits for it", async () => {
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await as(a, "POST", "/v1/messages", { to: "team:b", text: "Ready?" })
    const asked = (await promptFor("ses_b")).payload.text as string
    expect(asked).toContain("> Ready?")
    // team:a ends its turn to wait; team:b's reply wakes it
    await turnEnds("ses_a")
    await as(b, "POST", "/v1/messages", { to: "team:a", text: "Yes." })
    t.clock.advance(2000)
    const reply = (await promptFor("ses_a")).payload.text as string
    expect(reply).toStartWith("[autocode] 1 message\n")
    expect(reply).toContain("> Yes.")
  })

  test("the owner still sees every message, queued or delivered", async () => {
    await owner("POST", "/v1/agents/team:b/pause")
    await as(a, "POST", "/v1/messages", { to: "team:b", text: "one" })
    let list = (await owner("GET", "/v1/messages")).body.messages
    expect(list.map((m: any) => m.state)).toEqual(["queued"])
    await owner("POST", "/v1/agents/team:b/resume")
    await prompts()
    list = (await owner("GET", "/v1/messages")).body.messages
    expect(list.map((m: any) => m.state)).toEqual(["delivered"])
  })
})
