/*
 * Messages read and steered (the owner, 2026-11-09: "bring back wait, list
 * and read"; "lets implement (2)"): one final state `read`, however a copy
 * got there (read_via: prompt, steer, read, wait, inbox). A message to an
 * agent whose turn runs goes into that turn at once, with OpenCode's steer
 * delivery; the agent can list what waits, read it now, or wait for it,
 * filtered by sender or by the message it answers, Autocode's notices
 * included. What read or wait returned is never injected. The owner's copy is
 * read once its inbox item is answered or closed.
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
let c: string
const HOST = "m:1"

const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)
const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)

// One tick; the instructions it sent, acked (ok unless told otherwise).
async function sent(ok = true): Promise<any[]> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out) await ack(t, HOST, i.id, { ok }, ok)
  return out
}
const injects = async (ok = true) =>
  (await sent(ok)).filter((i) => i.type === "inject")
const started = (session: string) =>
  report(t, HOST, [{ type: "turn.started", session }])
const ended = (session: string) =>
  report(t, HOST, [{ type: "turn.ended", session, outcome: "succeeded" }])
const send = async (token: string, body: Record<string, unknown>) =>
  (await as(token, "POST", "/v1/messages", body)).body.messages[0].id as string
const view = async (id: string) =>
  (await owner("GET", `/v1/messages/${id}`)).body.message

beforeEach(async () => {
  t = await testServer()
  await owner("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  b = await registered(t, HOST, "ses_b", "team:b")
  c = await registered(t, HOST, "ses_c", "team:c")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("one state: read", () => {
  test("a prompt to an idle session marks its messages read, via prompt", async () => {
    const id = await send(a, { to: "team:b", text: "hello" })
    expect((await view(id)).state).toBe("queued")
    const [p] = await injects()
    expect(p.payload.session).toBe("ses_b")
    expect(p.payload.delivery ?? "queue").toBe("queue")
    const m = await view(id)
    expect(m).toMatchObject({ state: "read", read_via: "prompt" })
    expect(m.read_at).toBe(new Date(t.clock.now()).toISOString())
    expect(m).not.toHaveProperty("delivered_at")
  })

  test("a lost prompt puts its messages back in the queue", async () => {
    const id = await send(a, { to: "team:b", text: "hello" })
    await injects(false)
    t.server.tick()
    expect(await view(id)).toMatchObject({ state: "queued", read_via: null })
    t.clock.advance(2000)
    const [again] = await injects()
    expect(again.payload.text).toContain("> hello")
    expect((await view(id)).state).toBe("read")
  })

  test("the owner's copy is read once its inbox item is answered or closed", async () => {
    const one = await send(a, { to: "owner", text: "May I?" })
    const two = await send(a, { to: "owner", text: "FYI" })
    expect((await view(one)).state).toBe("queued")
    const items = (await owner("GET", "/v1/inbox")).body.items
    const item = (text: string) => items.find((i: any) => i.body === text)
    await owner("POST", `/v1/inbox/${item("May I?").id}/answer`, {
      text: "Yes.",
    })
    expect(await view(one)).toMatchObject({ state: "read", read_via: "inbox" })
    expect((await view(two)).state).toBe("queued")
    await owner("POST", `/v1/inbox/${item("FYI").id}/close`)
    expect(await view(two)).toMatchObject({ state: "read", read_via: "inbox" })
  })

  test("the owner's views never change a state", async () => {
    await owner("POST", "/v1/agents/team:b/pause")
    const id = await send(a, { to: "team:b", text: "later" })
    await owner("GET", "/v1/messages")
    await owner("GET", `/v1/messages/${id}`)
    expect((await view(id)).state).toBe("queued")
  })
})

describe("steer: into a running turn", () => {
  test("a message to an agent whose turn runs goes into that turn at once, with steer", async () => {
    await started("ses_b")
    const id = await send(a, { to: "team:b", subject: "q", text: "Ready?" })
    const [p] = await injects()
    expect(p.payload).toMatchObject({ session: "ses_b", delivery: "steer" })
    expect(p.payload.text).toStartWith(
      "[autocode] 1 message, during your turn\n",
    )
    expect(p.payload.text).toContain(
      `Message ${id} from agent team:a, subject "q":\n> Ready?`,
    )
    expect(await view(id)).toMatchObject({ state: "read", read_via: "steer" })
    // the turn goes on: still busy, and min_interval does not count it
    expect((await as(b, "GET", "/v1/me")).body.agent.busy).toBe(true)
    const second = await send(c, { to: "team:b", text: "Me too." })
    const [p2] = await injects()
    expect(p2.payload.delivery).toBe("steer")
    expect(p2.payload.text).toContain("> Me too.")
    expect((await view(second)).read_via).toBe("steer")
    const h = (await owner("GET", "/v1/history?kind=injection.sent")).body
      .history
    expect(h[0].data).toMatchObject({ steer: true, messages: [second] })
  })

  test("Autocode's notices steer too; wakes wait for the turn's end", async () => {
    await owner("PUT", "/v1/agents/team:b/wakes/w", {
      trigger: "fire-only",
      text: "Wake text.",
    })
    await started("ses_b")
    await owner("POST", "/v1/agents/team:b/wakes/w/fire")
    await as(a, "POST", "/v1/locks/gpu-0/acquire", { ttl: "10m" })
    await as(b, "POST", "/v1/locks/gpu-0/acquire", { ttl: "10m" })
    await as(a, "POST", "/v1/locks/gpu-0/release")
    const [p] = await injects()
    expect(p.payload.delivery).toBe("steer")
    expect(p.payload.text).toStartWith(
      '[autocode] lock "gpu-0" granted, during your turn\n',
    )
    expect(p.payload.text).not.toContain("Wake text.")
    await ended("ses_b")
    t.clock.advance(2000)
    const [w] = await injects()
    expect(w.payload.delivery ?? "queue").toBe("queue")
    expect(w.payload.text).toContain("Wake text.")
  })

  test("no steer while paused, or while a prompt of ours has not started its turn", async () => {
    // paused
    await started("ses_b")
    await owner("POST", "/v1/agents/team:b/pause")
    const p1 = await send(a, { to: "team:b", text: "paused" })
    expect(await injects()).toEqual([])
    expect((await view(p1)).state).toBe("queued")
    await owner("POST", "/v1/agents/team:b/resume")
    expect(await injects()).toMatchObject([{ payload: { delivery: "steer" } }])
    // a prompt of ours not yet started: the next goes after it, as a queue
    await ended("ses_b")
    t.clock.advance(2000)
    await send(a, { to: "team:b", text: "first" })
    expect(await injects()).toMatchObject([{ payload: { session: "ses_b" } }])
    const p2 = await send(a, { to: "team:b", text: "second" })
    expect(await injects()).toEqual([])
    expect((await view(p2)).state).toBe("queued")
  })

  test("no steer while the agent waits for messages itself: the wait takes them", async () => {
    await started("ses_b")
    const waiting = as(b, "POST", "/v1/me/messages/read", { wait: 5 })
    await Bun.sleep(300)
    const id = await send(a, { to: "team:b", text: "for the wait" })
    expect(await injects()).toEqual([])
    expect((await waiting).body.messages.map((m: any) => m.id)).toEqual([id])
    expect((await view(id)).read_via).toBe("wait")
  })

  test("a steer the plugin could not deliver comes again in the next prompt", async () => {
    await started("ses_b")
    const id = await send(a, { to: "team:b", text: "try" })
    await injects(false)
    t.server.tick()
    expect((await view(id)).state).toBe("queued")
    await ended("ses_b")
    t.clock.advance(2000)
    const [p] = await injects()
    expect(p.payload.delivery ?? "queue").toBe("queue")
    expect(p.payload.text).toContain("> try")
    expect((await view(id)).read_via).toBe("prompt")
  })
})

describe("list, read and wait", () => {
  beforeEach(async () => {
    // team:b is busy elsewhere: nothing steers while a test sets up
    await owner("POST", "/v1/agents/team:b/pause")
  })

  test("list shows what waits, without text, and marks nothing; filters by sender and reply", async () => {
    const q = await send(b, { to: "team:a", text: "question" })
    const one = await send(a, { to: "team:b", text: "one" })
    const two = await send(c, { to: "team:b", text: "two" })
    const three = await send(a, { to: "team:b", text: "three", reply_to: q })
    const list = (await as(b, "GET", "/v1/me/messages")).body.messages
    expect(list.map((m: any) => m.id)).toEqual([one, two, three])
    expect(list[0]).toMatchObject({ from: "team:a", size: 3, state: "queued" })
    expect(list[0]).not.toHaveProperty("text")
    const from = (await as(b, "GET", "/v1/me/messages?from=team:c")).body
    expect(from.messages.map((m: any) => m.id)).toEqual([two])
    const reply = (await as(b, "GET", `/v1/me/messages?reply_to=${q}`)).body
    expect(reply.messages.map((m: any) => m.id)).toEqual([three])
    expect((await view(one)).state).toBe("queued")
    // only one's own
    expect(
      (await as(c, "GET", "/v1/me/messages")).body.messages.map(
        (m: any) => m.id,
      ),
    ).toEqual([])
  })

  test("read returns what waits, whole and oldest first, marks it read and it is never injected", async () => {
    const one = await send(a, { to: "team:b", subject: "s", text: "one" })
    const two = await send(c, { to: "team:b", text: "two" })
    const res = await as(b, "POST", "/v1/me/messages/read", {})
    expect(res.status).toBe(200)
    expect(res.body.messages).toMatchObject([
      { id: one, from: "team:a", subject: "s", text: "one", state: "read" },
      { id: two, from: "team:c", text: "two", state: "read" },
    ])
    expect(res.body.left).toBe(0)
    expect(await view(one)).toMatchObject({ state: "read", read_via: "read" })
    await owner("POST", "/v1/agents/team:b/resume")
    expect(await injects()).toEqual([])
    const h = (await owner("GET", "/v1/history?kind=message.read")).body.history
    expect(h.map((e: any) => e.data)).toEqual([
      { id: two, from: "team:c", via: "read" },
      { id: one, from: "team:a", via: "read" },
    ])
  })

  test("read by id, by sender or by the message it answers; the rest stay queued and come in a prompt", async () => {
    const q = await send(b, { to: "team:a", text: "question" })
    const x = await send(a, { to: "team:b", text: "x" })
    const y = await send(c, { to: "team:b", text: "y" })
    const z = await send(a, { to: "team:b", text: "z", reply_to: q })
    const byId = (await as(b, "POST", "/v1/me/messages/read", { id: y })).body
    expect(byId.messages.map((m: any) => m.id)).toEqual([y])
    const reply = (await as(b, "POST", "/v1/me/messages/read", { reply_to: q }))
      .body
    expect(reply.messages.map((m: any) => m.id)).toEqual([z])
    expect(reply.left).toBe(1)
    expect((await view(x)).state).toBe("queued")
    await owner("POST", "/v1/agents/team:b/resume")
    const p = (await injects()).find((i) => i.payload.session === "ses_b")!
    expect(p.payload.text).toStartWith("[autocode] 1 message\n")
    expect(p.payload.text).toContain("> x")
    expect(p.payload.text).not.toContain("> y")
    // a message read already, by id: returned again, still read via read
    const again = (await as(b, "POST", "/v1/me/messages/read", { id: y })).body
    expect(again.messages).toMatchObject([{ id: y, text: "y", state: "read" }])
    expect((await view(y)).read_via).toBe("read")
    // another agent's message, or none: not found
    expect(
      (await as(c, "POST", "/v1/me/messages/read", { id: x })).status,
    ).toBe(404)
  })

  test("read takes up to 32,000 characters at a time; the rest stay for the next read", async () => {
    for (const n of [1, 2, 3])
      await send(a, { to: "team:b", text: `${n}${"y".repeat(14_999)}` })
    const first = (await as(b, "POST", "/v1/me/messages/read", {})).body
    expect(first.messages.length).toBe(2)
    expect(first.left).toBe(1)
    const second = (await as(b, "POST", "/v1/me/messages/read", {})).body
    expect(second.messages.map((m: any) => m.text[0])).toEqual(["3"])
    expect(second.left).toBe(0)
  })

  test("Autocode's notices are read too, and take no filter by sender but autocode", async () => {
    await as(c, "POST", "/v1/locks/gpu-0/acquire", { ttl: "10m" })
    await as(b, "POST", "/v1/locks/gpu-0/acquire", { ttl: "10m" })
    await as(c, "POST", "/v1/locks/gpu-0/release")
    await send(a, { to: "team:b", text: "plain" })
    const res = (
      await as(b, "POST", "/v1/me/messages/read", { from: "autocode" })
    ).body
    expect(res.messages).toMatchObject([
      { from: "autocode", subject: 'lock "gpu-0" granted' },
    ])
    expect(res.messages[0].text).toContain('You hold lock "gpu-0" now')
  })

  test("wait returns at once when something waits, else when a message comes; then it is read via wait", async () => {
    const waiting = as(b, "POST", "/v1/me/messages/read", { wait: 5 })
    await Bun.sleep(300)
    const id = await send(a, { to: "team:b", text: "here" })
    const res = (await waiting).body
    expect(res.messages.map((m: any) => m.id)).toEqual([id])
    expect(await view(id)).toMatchObject({ state: "read", read_via: "wait" })
    // filtered: a message from another sender does not end it
    const only = as(b, "POST", "/v1/me/messages/read", {
      wait: 5,
      from: "team:a",
    })
    await Bun.sleep(200)
    const other = await send(c, { to: "team:b", text: "not this" })
    await Bun.sleep(300)
    const mine = await send(a, { to: "team:b", text: "this" })
    expect((await only).body.messages.map((m: any) => m.id)).toEqual([mine])
    expect((await view(other)).state).toBe("queued")
  })

  test("wait gives up after its seconds (at most max_tool_wait) with nothing", async () => {
    await owner("PATCH", "/v1/settings", { server: { max_tool_wait: "1s" } })
    const start = Date.now()
    const res = (await as(b, "POST", "/v1/me/messages/read", { wait: 30 })).body
    expect(res.messages).toEqual([])
    expect(Date.now() - start).toBeLessThan(5000)
    expect(Date.now() - start).toBeGreaterThanOrEqual(900)
  })

  test("bad input: unknown fields, a bad wait, a filter that is not a string", async () => {
    for (const body of [{ nope: 1 }, { wait: -1 }, { wait: "x" }, { from: 3 }])
      expect(
        (await as(b, "POST", "/v1/me/messages/read", body)).status,
        JSON.stringify(body),
      ).toBe(400)
    expect((await owner("POST", "/v1/me/messages/read", {})).status).toBe(403)
  })

  test("/v1/me says how many wait", async () => {
    await send(a, { to: "team:b", text: "one" })
    expect((await as(b, "GET", "/v1/me")).body.waiting).toBe(1)
    await as(b, "POST", "/v1/me/messages/read", {})
    expect((await as(b, "GET", "/v1/me")).body.waiting).toBe(0)
  })
})

describe("dropped", () => {
  test("an agent that unregisters: what still waits is dropped; what it read stays read", async () => {
    await owner("POST", "/v1/agents/team:b/pause")
    const read = await send(a, { to: "team:b", text: "read it" })
    await as(b, "POST", "/v1/me/messages/read", { id: read })
    const left = await send(a, { to: "team:b", text: "left" })
    await owner("DELETE", "/v1/agents/team:b")
    expect((await view(read)).state).toBe("read")
    expect((await view(left)).state).toBe("dropped")
  })
})
