/*
 * Messages (spec, Messages): direct and group sends, refusals, the size limit,
 * text only, the states of each copy (queued, then read), the injection that
 * carries them whole (Phase 1: the only way they reach an agent; see also
 * messages-injected.test.ts), and messages to and from the owner through the
 * inbox.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ack,
  call,
  hello,
  instructions,
  registered,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

let t: TestServer
let a: string
let b: string
let c: string
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

beforeEach(async () => {
  t = await testServer()
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  b = await registered(t, HOST, "ses_b", "team:b")
  c = await registered(t, HOST, "ses_c", "other:c")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("sending", () => {
  test("a direct message: stored for the recipient, queued, then read in a prompt", async () => {
    const sent = await as(a, "POST", "/v1/messages", {
      to: "team:b",
      subject: "results",
      text: "The run finished: 0.91.",
    })
    expect(sent.status).toBe(201)
    expect(sent.body.recipients).toEqual(["team:b"])
    const id = sent.body.messages[0].id
    expect(id).toMatch(/^m_/)
    const list = await owner("GET", "/v1/messages?agent=team:b")
    expect(list.body.messages).toEqual([
      expect.objectContaining({
        id,
        from: "team:a",
        to: "team:b",
        subject: "results",
        size: 23,
        state: "queued",
      }),
    ])
    const prompt = await promptFor("ses_b")
    expect(prompt.payload.text).toStartWith("[autocode] 1 message\n")
    expect(prompt.payload.text).toContain(
      `Message ${id} from agent team:a, subject "results":`,
    )
    expect(prompt.payload.text).toContain("The run finished: 0.91.")
    // carried whole in the prompt: read
    const after = await owner("GET", `/v1/messages/${id}`)
    expect(after.body.message.state).toBe("read")
  })

  test("a group: one copy per matching agent, never the sender", async () => {
    const sent = await as(a, "POST", "/v1/messages", {
      to: "team:*",
      text: "Standup in 5.",
    })
    expect(sent.body.recipients).toEqual(["team:b"])
    const list = await as(a, "POST", "/v1/messages", {
      to: ["team:b", "other:c"],
      text: "Both of you.",
    })
    expect(list.body.recipients).toEqual(["other:c", "team:b"])
    expect(new Set(list.body.messages.map((m: any) => m.id)).size).toBe(2)
  })

  test("refusals: an unregistered ID, a group with no match, too long, bad input", async () => {
    const cases: [unknown, number, string][] = [
      [{ to: "team:zz", text: "x" }, 404, "no_recipient"],
      [{ to: "nobody:*", text: "x" }, 404, "no_recipient"],
      [{ to: "team:a", text: "to myself" }, 404, "no_recipient"],
      [{ to: "team:b", text: "x".repeat(32_001) }, 400, "too_large"],
      [{ to: "team:b" }, 400, "bad_request"],
      [{ to: "team:b", text: "x", reply_to: "m_nope" }, 404, "no_message"],
    ]
    for (const [body, status, code] of cases) {
      const res = await as(a, "POST", "/v1/messages", body)
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(status)
      expect(res.body.error.code).toBe(code)
    }
    const { sessionToken } = await import("../helpers/server.ts")
    const loose = await sessionToken(t, HOST, "ses_loose")
    expect(
      (await as(loose, "POST", "/v1/messages", { to: "team:b", text: "x" }))
        .status,
    ).toBe(403)
  })

  // The owner, 2026-11-07: messages are text only.
  test("a message is text: data and mime are refused, and views carry no kind", async () => {
    for (const body of [
      { to: "team:b", data: "eA==", mime: "image/png" },
      { to: "team:b", text: "x", data: "eA==" },
      { to: "team:b", text: "x", mime: "text/plain" },
    ]) {
      const res = await as(a, "POST", "/v1/messages", body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.message).toContain("unknown field")
    }
    const sent = await as(a, "POST", "/v1/messages", {
      to: "team:b",
      text: "hi",
    })
    const id = sent.body.messages[0].id
    const read = (await owner("GET", `/v1/messages/${id}`)).body.message
    expect(read.text).toBe("hi")
    expect(read).not.toHaveProperty("kind")
    expect(read).not.toHaveProperty("mime")
    expect(read).not.toHaveProperty("data")
  })
})

describe("announcing", () => {
  test("messages are never merged: three in one prompt", async () => {
    await owner("POST", "/v1/agents/team:b/pause")
    for (const text of ["one", "two", "three"])
      await as(a, "POST", "/v1/messages", { to: "team:b", text })
    await owner("POST", "/v1/agents/team:b/resume")
    const prompt = await promptFor("ses_b")
    expect(prompt.payload.text).toStartWith("[autocode] 3 messages\n")
    for (const text of ["one", "two", "three"])
      expect(prompt.payload.text).toContain(text)
  })

  test("with a wake, the wake and the waiting messages come together", async () => {
    await owner("POST", "/v1/agents/team:b/pause")
    await as(c, "POST", "/v1/messages", { to: "team:b", text: "new one" })
    await owner("PUT", "/v1/agents/team:b/wakes/look", {
      text: "Look.",
      trigger: "fire-only",
    })
    await owner("POST", "/v1/agents/team:b/wakes/look/fire")
    await owner("POST", "/v1/agents/team:b/resume")
    const text = (await promptFor("ses_b")).payload.text
    expect(text).toStartWith(
      '[autocode] wake "look" fired by the owner, 1 message\n',
    )
    expect(text).toContain("> new one")
  })

  // The owner, 2026-11-05: viewing or listing a message (web UI, CLI) does
  // not change it; the prompt that carries it does.
  test("the owner's list and read leave a message queued and announced", async () => {
    await owner("POST", "/v1/agents/team:b/pause")
    const sent = await as(a, "POST", "/v1/messages", {
      to: "team:b",
      text: "look later",
    })
    const id = sent.body.messages[0].id
    await owner("GET", "/v1/messages")
    await owner("GET", "/v1/messages?agent=team:b")
    expect((await owner("GET", `/v1/messages/${id}`)).body.message.text).toBe(
      "look later",
    )
    expect((await owner("GET", "/v1/messages")).body.messages[0]).toMatchObject(
      { id, state: "queued" },
    )
    await owner("POST", "/v1/agents/team:b/resume")
    expect((await promptFor("ses_b")).payload.text).toContain("> look later")
  })

  test("a reply says what it answers", async () => {
    const first = await as(a, "POST", "/v1/messages", {
      to: "team:b",
      text: "Ready?",
    })
    await prompts()
    const id = first.body.messages[0].id
    const reply = await as(b, "POST", "/v1/messages", {
      to: "team:a",
      text: "Yes.",
      reply_to: id,
    })
    expect(reply.status).toBe(201)
    const prompt = await promptFor("ses_a")
    expect(prompt.payload.text).toContain(`in reply to ${id}`)
  })
})

describe("the owner", () => {
  test("a message to owner lands in the inbox; the answer goes back as a message", async () => {
    const sent = await as(a, "POST", "/v1/messages", {
      to: "owner",
      subject: "budget",
      text: "May I spend $5 more?",
    })
    expect(sent.body.recipients).toEqual(["owner"])
    const inbox = await owner("GET", "/v1/inbox")
    const item = inbox.body.items[0]
    expect(item).toMatchObject({
      kind: "message",
      agent: "team:a",
      message_id: sent.body.messages[0].id,
      title: 'Message from team:a: "budget"',
      body: "May I spend $5 more?",
      closed_at: null,
    })
    const answered = await owner("POST", `/v1/inbox/${item.id}/answer`, {
      text: "Yes, up to $5.",
    })
    expect(answered.status).toBe(200)
    expect((await owner("GET", "/v1/inbox")).body.items).toEqual([])
    expect((await owner("GET", "/v1/inbox?all=1")).body.items[0]).toMatchObject(
      { answer: "Yes, up to $5." },
    )
    const prompt = await promptFor("ses_a")
    expect(prompt.payload.text).toContain("from the owner")
    expect(prompt.payload.text).toContain("Yes, up to $5.")
    expect(prompt.payload.text).toContain(
      `in reply to ${sent.body.messages[0].id}`,
    )
  })

  test("the owner sends as owner; agents' messages never say owner", async () => {
    const sent = await owner("POST", "/v1/messages", {
      to: "team:*",
      text: "Stop at 6.",
    })
    expect(sent.body.recipients).toEqual(["team:a", "team:b"])
    const prompt = await promptFor("ses_a")
    expect(prompt.payload.text).toContain("from the owner")
    expect(
      (await owner("GET", "/v1/messages?agent=team:a")).body.messages[0].from,
    ).toBe("owner")
  })

  test("closing an inbox item; the owner lists every message", async () => {
    await as(a, "POST", "/v1/messages", { to: "owner", text: "FYI" })
    const [item] = (await owner("GET", "/v1/inbox")).body.items
    expect((await owner("POST", `/v1/inbox/${item.id}/close`)).status).toBe(200)
    expect((await owner("GET", "/v1/inbox")).body.items).toEqual([])
    const all = await owner("GET", "/v1/messages")
    expect(all.body.messages.map((m: any) => m.to)).toEqual(["owner"])
  })
})

describe("the owner's list", () => {
  test("messages carry a 200-character preview", async () => {
    const long = `${"x".repeat(199)}yz${"!".repeat(50)}`
    await as(a, "POST", "/v1/messages", { to: "team:b", text: long })
    await as(a, "POST", "/v1/messages", { to: "team:b", text: "short" })
    const [short, first] = (await owner("GET", "/v1/messages")).body.messages
    expect(first.preview).toBe(`${"x".repeat(199)}y`)
    expect(short.preview).toBe("short")
  })
})
