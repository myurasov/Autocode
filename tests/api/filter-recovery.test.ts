/*
 * Phase 2 (the owner, 2026-11-09: "do one retry (in a hope issue will clear
 * itself), if it doesnt help - try compacting and retrying after that"; the
 * go 2026-11-10): recovery from a reply the provider's content filter blocked
 * (provider.content-filter). The first block: one retry, whose prompt says
 * the reply was blocked, asks for other, shorter wording with long text in a
 * file, and warns that another block compacts the session. Blocked again:
 * a compaction (no compaction notice), then a retry. A third block, or a
 * compaction that fails: no more retries, an inbox alert. A turn that
 * succeeds starts it over. filter_recovery: retry compact (the default),
 * retry, off. A run of a job takes the same steps before it fails.
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
const HOST = "m:1"
const MIN = 60_000
const FILTER = "provider.content-filter"

const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)

// One tick; what it sent (acked ok unless told), oldest first.
async function tick(fail?: string): Promise<any[]> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out.filter((i) => i.type !== "check"))
    if (fail && i.type === fail)
      await report(t, HOST, [
        { type: "ack", id: i.id, ok: false, error: "it broke" },
      ])
    else await ack(t, HOST, i.id, { ok: true })
  return out
}
const texts = (out: any[]) =>
  out.filter((i) => i.type === "inject").map((i) => i.payload.text as string)
const turn = async (outcome: string, error?: string, session = "ses_a") => {
  await report(t, HOST, [{ type: "turn.started", session }])
  await report(t, HOST, [
    {
      type: "turn.ended",
      session,
      outcome,
      ...(error ? { error } : {}),
    },
  ])
}
const agent = async (id = "team:a") =>
  (await owner("GET", `/v1/agents/${encodeURIComponent(id)}`)).body.agent
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
  await registered(t, HOST, "ses_a", "team:a")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("a blocked reply", () => {
  test("first block: one retry an interval later; its prompt says why, asks for shorter wording and warns", async () => {
    await turn("failed", FILTER)
    expect(await agent()).toMatchObject({
      status: "error",
      error: {
        type: FILTER,
        retryable: true,
        next_retry: "2026-10-28T12:01:00.000Z",
        recovery: "retry",
      },
    })
    expect(await alerts()).toEqual([])
    t.clock.advance(MIN)
    const [text] = texts(await tick())
    expect(text).toStartWith("[autocode] retry 1 (blocked reply)\n\n")
    for (const part of [
      "The provider's content filter blocked your last reply",
      "Write it again in other, shorter words",
      "put long text in a file and give only its path",
      "If it is blocked again, Autocode compacts this session",
      "save what you need to files now",
    ])
      expect(text, part).toContain(part)
    const h = await kinds("recovery.retry")
    expect(h.length).toBe(1)
  })

  test("blocked again: a compaction (no notice), then a retry after it; a third block stops with an alert", async () => {
    await turn("failed", FILTER)
    t.clock.advance(MIN)
    await tick()
    await turn("failed", FILTER)
    expect((await agent()).error.recovery).toBe("compact")
    t.clock.advance(MIN)
    const out = await tick()
    // the compaction, with no compaction notice and no prompt
    expect(out.map((i) => i.type)).toEqual(["compact"])
    expect(texts(out)).toEqual([])
    expect((await kinds("recovery.compacted")).length).toBe(1)
    // its own turn ends: the retry comes right after it
    await turn("succeeded", undefined)
    expect((await agent()).status).toBe("error")
    const [text] = texts(await tick())
    expect(text).toStartWith(
      "[autocode] retry 2 (blocked reply, compacted)\n\n",
    )
    expect(text).toContain("Autocode compacted this session")
    expect(text).toContain("If it is blocked again, Autocode stops retrying")
    // a third block: no more retries; the alert
    await turn("failed", FILTER)
    expect(await agent()).toMatchObject({
      error: { recovery: null, next_retry: null, retryable: false },
    })
    t.clock.advance(10 * MIN)
    expect(texts(await tick())).toEqual([])
    expect((await alerts()).map((i: any) => i.title)).toEqual([
      `Agent team:a: its replies were blocked 3 times (${FILTER}); not retried`,
    ])
    expect((await alerts())[0].body).toContain(
      "A retry and a compaction did not help",
    )
  })

  test("a compaction that fails: no retry, the alert at once", async () => {
    await turn("failed", FILTER)
    t.clock.advance(MIN)
    await tick()
    await turn("failed", FILTER)
    t.clock.advance(MIN)
    await tick("compact")
    // the plugin's answer is read at the next tick (a second later)
    await tick()
    expect((await agent()).error).toMatchObject({
      recovery: null,
      next_retry: null,
    })
    expect((await alerts()).map((i: any) => i.title)).toEqual([
      `Agent team:a: its reply was blocked (${FILTER}) and its compaction failed; not retried`,
    ])
  })

  test("a turn that succeeds ends it; the next block starts from the first step", async () => {
    await turn("failed", FILTER)
    t.clock.advance(MIN)
    await tick()
    await turn("succeeded")
    expect((await agent()).status).toBe("idle")
    await turn("failed", FILTER)
    expect((await agent()).error.recovery).toBe("retry")
    t.clock.advance(MIN)
    expect(texts(await tick())[0]).toStartWith(
      "[autocode] retry 1 (blocked reply)",
    )
  })

  test("filter_recovery retry: one retry, no compaction; off: not retried, as before", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { filter_recovery: "retry" } },
    })
    await turn("failed", FILTER)
    t.clock.advance(MIN)
    await tick()
    await turn("failed", FILTER)
    expect((await agent()).error.recovery).toBe(null)
    t.clock.advance(MIN)
    expect((await tick()).map((i) => i.type)).toEqual([])
    expect((await alerts()).length).toBe(1)
    await turn("succeeded")
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { filter_recovery: "off" } },
    })
    await turn("failed", FILTER)
    expect((await agent()).error).toMatchObject({
      retryable: false,
      recovery: null,
      next_retry: null,
    })
    expect((await alerts()).map((i: any) => i.title)).toContain(
      `Agent team:a: its turn failed (${FILTER}); not retried`,
    )
  })

  test("the setting takes retry compact, retry or off", async () => {
    for (const v of ["retry compact", "retry", "off"])
      expect(
        (
          await owner("PATCH", "/v1/settings", {
            agents: { "team:a": { filter_recovery: v } },
          })
        ).status,
        v,
      ).toBe(200)
    const bad = await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { filter_recovery: "compact" } },
    })
    expect(bad.status).toBe(400)
  })

  test("retry_attempts set lower still caps it", async () => {
    await owner("PATCH", "/v1/settings", { server: { retry_attempts: 1 } })
    await turn("failed", FILTER)
    t.clock.advance(MIN)
    await tick()
    await turn("failed", FILTER)
    t.clock.advance(MIN)
    expect((await tick()).map((i) => i.type)).toEqual([])
    expect((await alerts()).length).toBe(1)
  })

  test("other failures that are not retried stay so", async () => {
    await turn("failed", "provider.auth")
    expect((await agent()).error).toMatchObject({
      retryable: false,
      recovery: null,
    })
  })

  test("the owner's retry still works after it stopped", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: { "team:a": { filter_recovery: "off" } },
    })
    await turn("failed", FILTER)
    const res = await owner("POST", "/v1/agents/team:a/retry")
    expect(res.status).toBe(200)
    expect(texts(await tick())[0]).toStartWith("[autocode] retry 1")
  })
})
