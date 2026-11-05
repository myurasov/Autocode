/*
 * The history API: entries come newest first and filter by agent (or an agent
 * pattern), kind (or a kind prefix), since, before (paging) and limit; the
 * kinds there are, with counts; the consumer token may read them, a session
 * token may not; entries older than history_days are trimmed.
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  call,
  hello,
  registered,
  sessionToken,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

const running: TestServer[] = []
afterEach(async () => {
  for (const t of running.splice(0)) await t.stop()
})

async function start(options: Parameters<typeof testServer>[0] = {}) {
  const t = await testServer(options)
  running.push(t)
  return t
}

const DAY = 86_400_000

describe("history", () => {
  test("the server's start is recorded", async () => {
    const t = await start()
    const res = await call(t.url, t.admin, "GET", "/v1/history")
    expect(res.body.history.map((h: any) => h.kind)).toContain("server.started")
  })

  test("entries are newest first, with time, kind, agent and data; filters by agent, kind and since", async () => {
    const t = await start()
    await hello(t, "m:1")
    const token = await sessionToken(t, "m:1", "ses_1")
    t.clock.advance(1000)
    await call(t.url, token, "POST", "/v1/agents", { id: "a:b" })
    t.clock.advance(1000)
    await call(t.url, token, "DELETE", "/v1/me")
    const all = (await call(t.url, t.admin, "GET", "/v1/history")).body.history
    expect(Date.parse(all[0].at)).toBeGreaterThanOrEqual(Date.parse(all[1].at))
    const mine = (await call(t.url, t.admin, "GET", "/v1/history?agent=a:b"))
      .body.history
    expect(mine.map((h: any) => h.kind)).toEqual([
      "agent.unregistered",
      "agent.registered",
    ])
    expect(mine[1]).toMatchObject({
      agent: "a:b",
      session: "ses_1",
      host: "m:1",
    })
    const kind = (
      await call(t.url, t.admin, "GET", "/v1/history?kind=agent.registered")
    ).body.history
    expect(kind.length).toBe(1)
    const since = new Date(t.clock.now() - 500).toISOString()
    const recent = (
      await call(t.url, t.admin, "GET", `/v1/history?since=${since}`)
    ).body.history
    expect(recent.map((h: any) => h.kind)).toEqual(["agent.unregistered"])
    expect(
      (await call(t.url, t.admin, "GET", "/v1/history?limit=1")).body.history
        .length,
    ).toBe(1)
  })

  test("the consumer token may read the history; a session token may not", async () => {
    const t = await start()
    await hello(t, "m:1")
    const token = await sessionToken(t, "m:1", "ses_1")
    expect((await call(t.url, t.consumer, "GET", "/v1/history")).status).toBe(
      200,
    )
    expect((await call(t.url, token, "GET", "/v1/history")).status).toBe(403)
  })

  test("entries older than history_days are trimmed", async () => {
    const t = await start()
    await hello(t, "m:1")
    t.clock.advance(29 * DAY)
    await hello(t, "m:2")
    t.clock.advance(2 * DAY)
    t.server.maintenance()
    const kinds = (
      await call(t.url, t.admin, "GET", "/v1/history")
    ).body.history.map((h: any) => `${h.kind} ${h.host ?? ""}`)
    expect(kinds).toContain("host.online m:2")
    expect(kinds).not.toContain("host.online m:1")
    expect(kinds.some((k: string) => k.startsWith("server.started"))).toBe(
      false,
    )
  })

  test("a shorter history_days trims sooner", async () => {
    const t = await start()
    await hello(t, "m:1")
    await call(t.url, t.admin, "PATCH", "/v1/settings", {
      server: { history_days: 1 },
    })
    t.clock.advance(DAY + 1000)
    t.server.maintenance()
    const kinds = (
      await call(t.url, t.admin, "GET", "/v1/history")
    ).body.history.map((h: any) => h.kind)
    expect(kinds).not.toContain("host.online")
  })

  test("bad filters are refused", async () => {
    const t = await start()
    expect(
      (await call(t.url, t.admin, "GET", "/v1/history?since=yesterday")).status,
    ).toBe(400)
    expect(
      (await call(t.url, t.admin, "GET", "/v1/history?limit=0")).status,
    ).toBe(400)
  })

  // The web UI's History tab (the owner, 2026-11-04).
  test("match takes an agent pattern or a list", async () => {
    const t = await start()
    await hello(t, "m:1")
    const pairs: [string, string][] = [
      ["ses_1", "team:a"],
      ["ses_2", "team:b"],
      ["ses_3", "other:c"],
    ]
    for (const [ses, id] of pairs) await registered(t, "m:1", ses, id)
    const agents = async (q: string) =>
      [
        ...new Set(
          (
            await call(t.url, t.admin, "GET", `/v1/history?match=${q}`)
          ).body.history.map((h: any) => h.agent),
        ),
      ].sort()
    expect(await agents("team:*")).toEqual(["team:a", "team:b"])
    expect(await agents(encodeURIComponent("team:a,other:*"))).toEqual([
      "other:c",
      "team:a",
    ])
  })

  test("a kind ending in .* matches every kind it starts", async () => {
    const t = await start()
    await hello(t, "m:1")
    await registered(t, "m:1", "ses_1", "team:a")
    const kinds = async (q: string) => [
      ...new Set(
        (
          await call(t.url, t.admin, "GET", `/v1/history?kind=${q}`)
        ).body.history.map((h: any) => h.kind),
      ),
    ]
    const agent = await kinds("agent.*")
    expect(agent).toContain("agent.registered")
    expect(agent.every((k) => String(k).startsWith("agent."))).toBe(true)
    expect(await kinds("server.started")).toEqual(["server.started"])
    expect(
      (await call(t.url, t.admin, "GET", "/v1/history?kind=a*")).status,
    ).toBe(400)
  })

  test("before pages back: the entries older than that one, newest first", async () => {
    const t = await start()
    await hello(t, "m:1")
    for (let i = 0; i < 5; i++) {
      t.clock.advance(1000)
      await registered(t, "m:1", `ses_${i}`, `team:a${i}`)
    }
    const page = async (q: string) =>
      (
        await call(
          t.url,
          t.admin,
          "GET",
          `/v1/history?kind=agent.registered${q}`,
        )
      ).body.history
    const first = await page("&limit=2")
    expect(first.map((h: any) => h.agent)).toEqual(["team:a4", "team:a3"])
    const second = await page(`&limit=2&before=${first.at(-1).id}`)
    expect(second.map((h: any) => h.agent)).toEqual(["team:a2", "team:a1"])
    const last = await page(`&limit=2&before=${second.at(-1).id}`)
    expect(last.map((h: any) => h.agent)).toEqual(["team:a0"])
    expect(
      (await call(t.url, t.admin, "GET", "/v1/history?before=x")).status,
    ).toBe(400)
  })

  test("kinds: every kind there is, with how many, most first", async () => {
    const t = await start()
    await hello(t, "m:1")
    await registered(t, "m:1", "ses_1", "team:a")
    await registered(t, "m:1", "ses_2", "team:b")
    const res = await call(t.url, t.admin, "GET", "/v1/history/kinds")
    expect(res.status).toBe(200)
    const kinds = res.body.kinds as { kind: string; count: number }[]
    expect(kinds.find((k) => k.kind === "agent.registered")?.count).toBe(2)
    expect(kinds.find((k) => k.kind === "server.started")?.count).toBe(1)
    for (let i = 1; i < kinds.length; i++)
      expect(kinds[i - 1]!.count).toBeGreaterThanOrEqual(kinds[i]!.count)
    const consumer = await call(t.url, t.consumer, "GET", "/v1/history/kinds")
    expect(consumer.status).toBe(200)
  })
})
