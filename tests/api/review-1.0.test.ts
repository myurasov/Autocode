/*
 * The adversarial review before 1.0.0 (2026-11-17), the server's side: each
 * test is a defect a reviewer proved, as it must behave now. A consumer
 * rotation ends what the old token could mint and its open polls; a host
 * whose OpenCode is too old loses its session tokens, raises one alert only
 * and none of the loader's; Close All refuses a body that is not an object;
 * a Subagent's ask outlives its session's turn (OpenCode 2.3 runs Subagents
 * in the background); ?agent= applies with ?from= and ?to=; "compaction
 * done" comes only after a compaction.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ack,
  call,
  hello,
  instructions,
  registered,
  report,
  sessionToken,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

let t: TestServer
const HOST = "m:1"
const enc = encodeURIComponent
const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)
async function sent(): Promise<any[]> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out) await ack(t, HOST, i.id, { ok: true })
  return out
}
const titles = async () =>
  (await owner("GET", "/v1/inbox")).body.items.map((x: any) => x.title)

beforeEach(async () => {
  t = await testServer({ machine: "m" })
  await owner("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
  await hello(t, HOST, { process: { kind: "tui", pid: 77 } })
})
afterEach(() => t.stop())

describe("replacing the consumer token", () => {
  test("ends every session token: what the leaked token minted no longer acts as an agent", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    await registered(t, HOST, "ses_b", "team:b")
    // whoever holds the consumer token can get a token of any session
    const stolen = await sessionToken(t, HOST, "ses_a")
    expect((await as(stolen, "GET", "/v1/me")).status).toBe(200)
    const rot = await owner("POST", "/v1/tokens/consumer/rotate")
    expect(rot.status).toBe(200)
    expect((await hello(t, HOST)).status).toBe(401)
    expect((await as(stolen, "GET", "/v1/me")).status).toBe(401)
    expect(
      (
        await as(stolen, "POST", "/v1/messages", {
          to: "team:b",
          text: "as team:a",
        })
      ).status,
    ).toBe(401)
    // with the new consumer token a plugin gets its sessions' tokens again
    const fresh = rot.body.token as string
    const again = await call(
      t.url,
      fresh,
      "POST",
      `/v1/hosts/${enc(HOST)}/sessions/ses_a/token`,
      { instance: `inst-${HOST}` },
    )
    expect(again.status).toBe(200)
    expect((await as(again.body.token, "GET", "/v1/me")).body.agent.id).toBe(
      "team:a",
    )
    // an admin rotation leaves the sessions' tokens alone
    expect((await owner("POST", "/v1/tokens/admin/rotate")).status).toBe(200)
    expect((await as(again.body.token, "GET", "/v1/me")).status).toBe(200)
  })

  test("a long poll opened with the old token ends at once and carries nothing", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
    const poll = call(
      t.url,
      t.consumer,
      "GET",
      `/v1/hosts/${enc(HOST)}/next?wait=5&instance=${enc(`inst-${HOST}`)}`,
    )
    await Bun.sleep(200)
    const began = Date.now()
    expect((await owner("POST", "/v1/tokens/consumer/rotate")).status).toBe(200)
    await owner("POST", "/v1/messages", { to: "team:a", text: "SECRET-42" })
    t.clock.advance(2000)
    t.server.tick()
    const got = await poll
    expect(Date.now() - began).toBeLessThan(3000)
    expect(got.status).toBe(401)
    expect(JSON.stringify(got.body)).not.toContain("SECRET-42")
  })
})

describe("a host whose OpenCode is older than the minimum", () => {
  const old = () =>
    hello(t, HOST, {
      opencode: { version: "2.2.0" },
      process: { kind: "tui", pid: 77 },
    })

  test("its sessions' tokens stop working; after the update it gets new ones", async () => {
    const a = await registered(t, HOST, "ses_a", "team:a")
    for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
    expect((await old()).status).toBe(426)
    // an older plugin, or a script with the token: not served either
    expect((await as(a, "GET", "/v1/me")).status).toBe(401)
    expect(
      (await as(a, "POST", "/v1/messages", { to: "owner", text: "hi" })).status,
    ).toBe(401)
    expect((await owner("GET", "/v1/agents/team:a")).body.agent.status).toBe(
      "offline",
    )
    // OpenCode was updated: the host is back, the agent keeps its ID
    expect((await hello(t, HOST, { instance: "new-one" })).status).toBe(200)
    const fresh = await call(
      t.url,
      t.consumer,
      "POST",
      `/v1/hosts/${enc(HOST)}/sessions/ses_a/token`,
      { instance: "new-one" },
    )
    expect(fresh.status).toBe(200)
    expect((await as(fresh.body.token, "GET", "/v1/me")).body.agent.id).toBe(
      "team:a",
    )
  })

  test("one alert for it, not again once closed, and none that its OpenCode is gone", async () => {
    const a = await registered(t, HOST, "ses_a", "team:a")
    await sent()
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 1m" })
    expect((await old()).status).toBe(426)
    // its wake falls due: the loader must not take the host for a lost one
    t.clock.advance(2 * 60_000)
    t.server.tick()
    await Bun.sleep(50)
    expect(await titles()).toEqual([
      "Host m:1 runs OpenCode v2.2.0: too old for Autocode",
    ])
    // the owner closes it; the plugin asks again and again
    expect((await owner("POST", "/v1/inbox/close-all", {})).body.closed).toBe(1)
    for (let n = 0; n < 3; n++) {
      t.clock.advance(10 * 60_000)
      expect((await old()).status).toBe(426)
      t.server.tick()
    }
    await Bun.sleep(50)
    expect(await titles()).toEqual([])
  })
})

describe("Close All", () => {
  test("a body that is not an object is refused, and closes nothing", async () => {
    for (let n = 1; n <= 3; n++)
      t.server.db
        .query(
          "INSERT INTO inbox (id, kind, title, body, created_at) " +
            "VALUES (?, 'alert', ?, '', ?)",
        )
        .run(`ib_t${n}`, `alert ${n}`, t.clock.now() + n)
    for (const body of [["ib_t2"], "ib_t2", 7, null]) {
      const res = await owner("POST", "/v1/inbox/close-all", body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe("bad_request")
    }
    expect((await titles()).length).toBe(3)
    // no body, or an empty object: all, as before
    expect((await owner("POST", "/v1/inbox/close-all")).body.closed).toBe(3)
  })
})

describe("a Subagent's question or permission (OpenCode 2.3: in the background)", () => {
  test("stays open when its top-level session's turn ends; that session's own go", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    const permission = (ref: string, child?: string) => ({
      type: "ask.opened",
      session: "ses_a",
      ...(child ? { form_session: child } : {}),
      kind: "permission",
      ref,
      action: "bash",
      resources: [`run ${ref}`],
    })
    await report(t, HOST, [
      permission("per_own"),
      permission("per_sub", "ses_a_child"),
    ])
    const open = async () =>
      (await owner("GET", "/v1/inbox")).body.items.filter(
        (x: any) => x.kind === "permission",
      )
    expect((await open()).length).toBe(2)
    // the turn ends while the Subagent still works, and waits for its answer
    await report(t, HOST, [
      {
        type: "turn.ended",
        session: "ses_a",
        outcome: "succeeded",
        background: 1,
      },
    ])
    const left = await open()
    expect(left.map((x: any) => x.body ?? x.title)).toHaveLength(1)
    expect(JSON.stringify(left[0])).toContain("per_sub")
    // the owner's answer still reaches the Subagent's request
    const answer = await owner("POST", `/v1/asks/${left[0].id}/answer`, {
      decision: "once",
    })
    expect(answer.status).toBe(200)
    const out = await instructions(t, HOST)
    expect(
      out.filter((i) => JSON.stringify(i.payload).includes("per_sub")).length,
    ).toBe(1)
    // a later turn's end (another Subagent's result) changes nothing more
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    expect((await open()).length).toBe(0)
  })
})

describe("GET /v1/messages", () => {
  test("?agent= applies together with ?from= and ?to=", async () => {
    const a = await registered(t, HOST, "ses_a", "team:a")
    const b = await registered(t, HOST, "ses_b", "team:b")
    await as(a, "POST", "/v1/messages", { to: "team:b", text: "a to b" })
    await as(b, "POST", "/v1/messages", { to: "owner", text: "b to owner" })
    await owner("POST", "/v1/messages", { to: "team:a", text: "owner to a" })
    await owner("POST", "/v1/messages", { to: "team:b", text: "owner to b" })
    const list = async (query: string) =>
      (await owner("GET", `/v1/messages?${query}`)).body.messages
        .map((m: any) => `${m.from}>${m.to}`)
        .sort()
    expect(await list("from=owner")).toEqual(["owner>team:a", "owner>team:b"])
    expect(await list("agent=team:b&from=owner")).toEqual(["owner>team:b"])
    expect(await list("agent=team:b&to=owner")).toEqual(["team:b>owner"])
    expect(await list("agent=team:b")).toEqual([
      "owner>team:b",
      "team:a>team:b",
      "team:b>owner",
    ])
  })
})

describe("compaction done", () => {
  const step = (context: number) => ({
    type: "cost",
    session: "ses_a",
    usd: 0.01,
    context,
    limit: 200_000,
    model: "fake/main",
  })

  test("is not sent when the compaction did not happen and another turn ends", async () => {
    const a = await registered(t, HOST, "ses_a", "team:a")
    for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
    await report(t, HOST, [
      { type: "turn.started", session: "ses_a" },
      step(50_000),
    ])
    expect((await as(a, "POST", "/v1/me/compact")).status).toBe(200)
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    t.server.tick()
    const out = await instructions(t, HOST)
    expect(out.map((i) => i.type)).toEqual(["compact"])
    // OpenCode could not compact: the plugin says so; no turn follows
    await ack(t, HOST, out[0].id, null, false)
    t.clock.advance(180_000)
    t.server.tick()
    // later the owner types in OpenCode: a turn of their own
    await report(t, HOST, [
      { type: "turn.started", session: "ses_a" },
      step(51_000),
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    t.clock.advance(5000)
    const texts = (await sent())
      .filter((i) => i.type === "inject")
      .map((i) => String(i.payload.text))
    expect(texts.join("\n")).not.toContain("compaction done")
    expect(
      (await owner("GET", "/v1/history?kind=session.compact.done")).body
        .history,
    ).toEqual([])
    // the agent asked for it: it is told that nothing was compacted
    expect(texts.join("\n")).toContain("compaction failed")
    expect(texts.join("\n")).toContain(
      "Ask again with autocode_me action=compact",
    )
    expect(
      (await owner("GET", "/v1/history?kind=session.compact.failed")).body
        .history.length,
    ).toBe(1)
  })
})
