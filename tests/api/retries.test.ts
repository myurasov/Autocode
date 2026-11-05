/*
 * The error state and retries (tier 0b3): a failed turn puts its agent in the
 * error state; Autocode sends a retry prompt every retry_interval, carrying
 * the wakes and messages that waited, up to retry_attempts (0: no limit),
 * then alerts the owner; failures that would fail again are not retried; a
 * turn that succeeds clears the state; the owner can retry at once.
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
const SEC = 1000
const MIN = 60_000
const FOOTER =
  "— From Autocode, not the owner. Your wakes: autocode_wake list. " +
  "How Autocode works: autocode_me action=help."

const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)
const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)

// One scheduler tick; the prompts it sent (acked), oldest first.
async function tick(): Promise<string[]> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out.filter((i) => i.type !== "check"))
    await ack(t, HOST, i.id, { ok: true })
  return out.filter((i) => i.type === "inject").map((i) => i.payload.text)
}
const started = () =>
  report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
const ended = (outcome: string, error?: string) =>
  report(t, HOST, [
    {
      type: "turn.ended",
      session: "ses_a",
      outcome,
      ...(error ? { error } : {}),
    },
  ])
const fail = (error = "provider.internal") => ended("failed", error)
const agent = async () => (await owner("GET", "/v1/agents/team:a")).body.agent
const alerts = async () =>
  (await owner("GET", "/v1/inbox")).body.items.filter(
    (i: any) => i.kind === "alert" && i.agent === "team:a",
  )
const kinds = async (kind: string) =>
  (await owner("GET", `/v1/history?kind=${kind}&agent=team:a`)).body.history

beforeEach(async () => {
  t = await testServer()
  await owner("PATCH", "/v1/settings", {
    server: { timezone: "America/Los_Angeles" },
  })
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  b = await registered(t, HOST, "ses_b", "team:b")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("the error state", () => {
  test("a failed turn puts the agent in the error state, with the error and the next retry", async () => {
    // 12:00 UTC is 05:00 PDT
    await fail()
    expect(await agent()).toMatchObject({
      status: "error",
      error: {
        type: "provider.internal",
        since: "2026-10-28T12:00:00.000Z",
        at: "2026-10-28T12:00:00.000Z",
        retries: 0,
        next_retry: "2026-10-28T12:01:00.000Z",
        retryable: true,
      },
    })
    expect((await kinds("agent.error")).length).toBe(1)
    // the agent's own view, with the retry settings
    const me = (await as(a, "GET", "/v1/me")).body
    expect(me.agent.status).toBe("error")
    expect(me.agent.error.type).toBe("provider.internal")
    expect(me.settings).toMatchObject({
      retry_interval: "1m",
      retry_attempts: 0,
    })
  })

  test("retries every retry_interval while it fails; a turn that succeeds clears it", async () => {
    await fail()
    t.clock.advance(30 * SEC)
    expect(await tick()).toEqual([])
    t.clock.advance(30 * SEC)
    expect(await tick()).toEqual([
      "[autocode] retry 1\n\n" +
        "Your last turn failed: provider.internal (at 2026-10-28 05:00 " +
        "PDT). Continue where you left off.\n\n" +
        FOOTER,
    ])
    expect((await agent()).error).toMatchObject({
      retries: 1,
      next_retry: null,
    })
    await started()
    t.clock.advance(10 * SEC)
    await fail()
    // the streak keeps its start; the next retry an interval after this one
    expect((await agent()).error).toMatchObject({
      since: "2026-10-28T12:00:00.000Z",
      at: "2026-10-28T12:01:10.000Z",
      next_retry: "2026-10-28T12:02:10.000Z",
    })
    t.clock.advance(MIN)
    const [second] = await tick()
    expect(second).toStartWith("[autocode] retry 2\n\n")
    expect(second).toContain(
      "Your last turn failed: provider.internal (at 2026-10-28 05:01 PDT; " +
        "failing since 2026-10-28 05:00 PDT). Continue where you left off.",
    )
    await started()
    await ended("succeeded")
    const ok = await agent()
    expect(ok.status).toBe("idle")
    expect(ok.error).toBeUndefined()
    const [recovered] = await kinds("agent.recovered")
    expect(recovered.data).toMatchObject({
      error: "provider.internal",
      retries: 2,
    })
    expect((await kinds("retry.sent")).length).toBe(2)
    // one agent.error per streak
    expect((await kinds("agent.error")).length).toBe(1)
  })

  test("the retry interval is a setting, per agent", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { retry_interval: "5m" } },
    })
    await fail()
    expect((await agent()).error.next_retry).toBe("2026-10-28T12:05:00.000Z")
    t.clock.advance(4 * MIN)
    expect(await tick()).toEqual([])
    t.clock.advance(MIN)
    expect((await tick()).length).toBe(1)
  })

  test("an interrupted turn leaves the error state; the next retry comes an interval after it", async () => {
    await fail()
    t.clock.advance(MIN)
    expect((await tick()).length).toBe(1)
    await started()
    t.clock.advance(20 * SEC)
    await ended("interrupted")
    expect(await agent()).toMatchObject({
      status: "error",
      error: { retries: 1, next_retry: "2026-10-28T12:02:20.000Z" },
    })
  })
})

describe("holding", () => {
  test("while in error, wakes and messages wait and come with the retry", async () => {
    await fail()
    await as(a, "PUT", "/v1/me/wakes/soon", {
      text: "Look.",
      trigger: "in 20s",
    })
    t.clock.advance(10 * SEC)
    await as(b, "POST", "/v1/messages", { to: "team:a", text: "hi" })
    t.clock.advance(20 * SEC)
    expect(await tick()).toEqual([])
    t.clock.advance(30 * SEC)
    const [prompt] = await tick()
    expect(prompt).toStartWith('[autocode] retry 1, wake "soon", 1 message\n\n')
    expect(prompt).toContain("Continue where you left off.")
    expect(prompt).toContain(
      'Wake "soon" (once, this was its only run):\nLook.',
    )
    expect(prompt).toContain("from agent team:b:\n> hi")
    expect(prompt).toEndWith(FOOTER)
  })

  test("after a turn succeeds, what waits is delivered as usual", async () => {
    await fail()
    await as(b, "POST", "/v1/messages", { to: "team:a", text: "hi" })
    expect(await tick()).toEqual([])
    await ended("succeeded")
    const [prompt] = await tick()
    expect(prompt).toStartWith("[autocode] 1 message\n\n")
  })

  test("a paused agent gets no retries until it is resumed", async () => {
    await fail()
    await owner("POST", "/v1/agents/team:a/pause")
    t.clock.advance(5 * MIN)
    expect(await tick()).toEqual([])
    expect((await agent()).status).toBe("paused")
    await owner("POST", "/v1/agents/team:a/resume")
    const [prompt] = await tick()
    expect(prompt).toStartWith("[autocode] retry 1\n\n")
  })
})

describe("limits and alerts", () => {
  test("retry_attempts: after that many retries failed, no more, and an inbox alert", async () => {
    await owner("PATCH", "/v1/settings", { server: { retry_attempts: 2 } })
    await fail()
    for (const n of [1, 2]) {
      t.clock.advance(MIN)
      const [prompt] = await tick()
      expect(prompt).toStartWith(`[autocode] retry ${n} of 2\n\n`)
      await started()
      await fail()
    }
    expect(await agent()).toMatchObject({
      status: "error",
      error: { retries: 2, next_retry: null, retryable: true },
    })
    t.clock.advance(10 * MIN)
    expect(await tick()).toEqual([])
    const [alert] = await alerts()
    expect(alert.title).toBe(
      "Agent team:a: its turns still fail after 2 retries (provider.internal)",
    )
    expect(alert.body).toContain("Autocode stopped retrying.")
    expect((await kinds("retry.exhausted")).length).toBe(1)
  })

  test("a failure that would fail again is not retried: the error state and an inbox alert", async () => {
    for (const type of [
      "provider.auth",
      "provider.invalid-request",
      "provider.content-filter",
      "provider.unknown",
      "provider.unsupported-operation",
    ]) {
      await fail(type)
      expect(await agent(), type).toMatchObject({
        status: "error",
        error: { type, next_retry: null, retryable: false },
      })
      await ended("succeeded")
    }
    await fail("provider.auth")
    t.clock.advance(10 * MIN)
    expect(await tick()).toEqual([])
    const titles = (await alerts()).map((i: any) => i.title)
    expect(titles).toContain(
      "Agent team:a: its turn failed (provider.auth); not retried",
    )
  })

  test("the owner's retry: one now, also when not retried or after the retries ran out; only in the error state", async () => {
    expect(
      (await owner("POST", "/v1/agents/team:a/retry")).body.error.code,
    ).toBe("not_in_error")
    await fail("provider.auth")
    const res = await owner("POST", "/v1/agents/team:a/retry")
    expect(res.status).toBe(200)
    expect(res.body.agent.error.next_retry).toBe("2026-10-28T12:00:00.000Z")
    const [prompt] = await tick()
    expect(prompt).toStartWith("[autocode] retry 1\n\n")
    expect(prompt).toContain("Your last turn failed: provider.auth")
    const [requested] = await kinds("retry.requested")
    expect(requested.data).toMatchObject({ by: "owner" })
  })

  test("a failed turn without an error type is retried", async () => {
    await ended("failed")
    expect((await agent()).error).toMatchObject({
      type: "failed",
      retryable: true,
    })
  })
})
