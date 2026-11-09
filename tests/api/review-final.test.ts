/*
 * The final adversarial review of Phase 0 and Phase 1 (2026-11-08): each
 * finding's case, red before its fix. Messages keep their order across
 * prompts; an unregistered ID's waiting messages are dropped, not left
 * waiting; an ID that moves to a new session starts it fresh (no old
 * context, cut or compaction); a compaction notice that did not arrive is
 * sent again; an unknown model window keeps the last known one and falls
 * back to the 500,000 cap, and status says so; the context counts again
 * once the compaction's turn ends; no notice or compaction jumps ahead of
 * the retries in the error state; and a step sent again after a server
 * restart counts once.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMe } from "../../packages/plugin/src/tools.ts"
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

const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)
const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)

const step = (usd: number, context: number, session = "ses_a") => ({
  type: "cost",
  session,
  usd,
  context,
  limit: 200_000,
  model: "fake/main",
})
async function sent(): Promise<any[]> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out) await ack(t, HOST, i.id, { ok: true })
  return out
}
const first = (out: any[]) =>
  out.map((i) => `${i.type} ${(i.payload.text ?? "").split("\n")[0]}`.trim())
const promptFor = async (session: string) =>
  (await sent()).find(
    (i) => i.type === "inject" && i.payload.session === session,
  )
const turn = async (session = "ses_a", outcome = "succeeded") => {
  await report(t, HOST, [{ type: "turn.started", session }])
  await report(t, HOST, [{ type: "turn.ended", session, outcome }])
}
const turnEnds = (session = "ses_a") =>
  report(t, HOST, [{ type: "turn.ended", session, outcome: "succeeded" }])

beforeEach(async () => {
  t = await testServer()
  await owner("PATCH", "/v1/settings", {
    server: { min_interval: "1s", compact_at: "50%" },
  })
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  b = await registered(t, HOST, "ses_b", "team:b")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("final review", () => {
  // 1
  test("messages keep their order: one that does not fit holds back the later ones", async () => {
    await owner("POST", "/v1/agents/team:b/pause")
    for (const [n, size] of [20_000, 15_000, 5_000].entries())
      await as(a, "POST", "/v1/messages", {
        to: "team:b",
        text: `M${n + 1}:${"y".repeat(size - 3)}`,
      })
    await owner("POST", "/v1/agents/team:b/resume")
    const one = (await promptFor("ses_b")).payload.text as string
    expect(one).toStartWith("[autocode] 1 message\n")
    expect(one).toContain("> M1:")
    expect(one).not.toContain("> M3:")
    await turn("ses_b")
    t.clock.advance(2000)
    const two = (await promptFor("ses_b")).payload.text as string
    expect(two).toStartWith("[autocode] 2 messages\n")
    expect(two.indexOf("> M2:")).toBeLessThan(two.indexOf("> M3:"))
  })

  // 2
  test("an unregistered ID's waiting messages are dropped (recorded), not left waiting", async () => {
    await owner("POST", "/v1/agents/team:b/pause")
    const sent1 = await as(a, "POST", "/v1/messages", {
      to: "team:b",
      text: "hello b",
    })
    const id = sent1.body.messages[0].id
    await as(b, "DELETE", "/v1/me")
    const b2 = await registered(t, HOST, "ses_b", "team:b")
    for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
    expect((await as(b2, "GET", "/v1/me")).body.waiting).toBe(0)
    const view = (await owner("GET", `/v1/messages/${id}`)).body.message
    expect(view.state).toBe("dropped")
    const dropped = (
      await owner("GET", "/v1/history?kind=message.dropped&agent=team:b")
    ).body.history
    expect(dropped[0].data).toMatchObject({ id, why: "unregistered" })
  })

  // 3
  test("an ID that moves to a new session starts it fresh: no old context, cut or compaction", async () => {
    await report(t, HOST, [step(0.01, 120_000)])
    t.server.db
      .query(
        "UPDATE agents SET cut_at = 1, compact_wanted = 1 WHERE id = 'team:a'",
      )
      .run()
    await report(t, HOST, [{ type: "session.deleted", session: "ses_a" }])
    const a2 = await registered(t, HOST, "ses_new", "team:a")
    for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
    const k = (await owner("GET", "/v1/costs/team:a")).body.cost
    expect(k.context).toBeNull()
    // its spend stays
    expect(k.total_usd).toBe(0.01)
    await as(a2, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 1m" })
    t.clock.advance(MIN)
    expect(first(await sent())).toEqual(['inject [autocode] wake "w"'])
  })

  // 4
  test("a compaction notice that did not arrive is sent again, before any compaction", async () => {
    await report(t, HOST, [step(0.01, 120_000)])
    await turnEnds()
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 1m" })
    t.clock.advance(MIN)
    t.server.tick()
    const out = await instructions(t, HOST)
    expect(first(out)).toEqual(["inject [autocode] compaction next"])
    // the plugin could not type it
    for (const i of out) await ack(t, HOST, i.id, null, false)
    t.clock.advance(2000)
    expect(first(await sent())).toEqual(["inject [autocode] compaction next"])
  })

  // 5
  test("an unknown window: the last known one stays; none at all: the 500,000 cap; status says which", async () => {
    await report(t, HOST, [step(0.01, 50_000)])
    await report(t, HOST, [
      { type: "cost", session: "ses_a", usd: 0.01, context: 120_000 },
    ])
    let k = (await owner("GET", "/v1/costs/team:a")).body.cost
    expect(k).toMatchObject({ context_limit: 200_000, compact_at: 100_000 })
    // an agent whose window was never known
    await report(t, HOST, [
      { type: "cost", session: "ses_b", usd: 0.01, context: 300_000 },
    ])
    k = (await owner("GET", "/v1/costs/team:b")).body.cost
    expect(k).toMatchObject({ context_limit: null, compact_at: 500_000 })
    const status = await runMe({ action: "status" }, async (m, p, body) => {
      return (await as(b, m, p, body)).body
    })
    expect(status).toContain(
      "compacted past 500,000 (compact_at; the model's window is not known)",
    )
    expect(status).not.toContain("compact_at off")
  })

  // 6
  test("once the compaction's turn ends, the context counts again (the owner's own turns too)", async () => {
    await as(a, "POST", "/v1/me/compact")
    await turnEnds()
    expect(first(await sent())).toEqual(["compact"])
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [step(0.01, 8000)])
    await turnEnds()
    for (const c of [50_000, 90_000, 150_000]) {
      await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
      await report(t, HOST, [step(0.01, c)])
      await turnEnds()
    }
    expect((await owner("GET", "/v1/costs/team:a")).body.cost.context).toBe(
      150_000,
    )
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 1m" })
    t.clock.advance(MIN)
    expect(first(await sent())).toEqual(["inject [autocode] compaction next"])
  })

  // 7
  test("in the error state no notice or compaction jumps ahead of the retries", async () => {
    await owner("PATCH", "/v1/settings", {
      server: { retry_interval: "10m" },
    })
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [step(0.01, 120_000)])
    await report(t, HOST, [
      {
        type: "turn.ended",
        session: "ses_a",
        outcome: "failed",
        error: "provider.internal",
      },
    ])
    await owner("POST", "/v1/messages", { to: "team:a", text: "hi" })
    t.clock.advance(2000)
    expect(first(await sent())).toEqual([])
    // the retry comes at retry_interval, and only the retry
    t.clock.advance(10 * MIN)
    const out = first(await sent())
    expect(out.length).toBe(1)
    expect(out[0]).toStartWith("inject [autocode] retry 1")
  })

  // 9
  test("a step sent again after the server restarted (its reply lost) counts once", async () => {
    // a data folder of the test's own, kept across the restart
    await t.stop()
    const dir = mkdtempSync(join(tmpdir(), "autocode-restart-"))
    try {
      t = await testServer({ dataDir: dir })
      await hello(t, HOST)
      await registered(t, HOST, "ses_a", "team:a")
      await report(t, HOST, [{ ...step(0.25, 1000), step: "msg_restart" }])
      await t.stop()
      t = await testServer({ dataDir: dir })
      await hello(t, HOST)
      await report(t, HOST, [{ ...step(0.25, 1000), step: "msg_restart" }])
      const k = (await owner("GET", "/v1/costs/team:a")).body.cost
      expect(k.total_usd).toBe(0.25)
      expect(k.today_usd).toBe(0.25)
    } finally {
      await t.stop()
      rmSync(dir, { recursive: true, force: true })
      // afterEach stops the server again: give it one of its own
      t = await testServer()
    }
  })
})
