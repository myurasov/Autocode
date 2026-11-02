/*
 * The agents API: registering, moving and unregistering an ID (one live session
 * holds it at a time), discovery by pattern with status and last activity, and
 * the owner's forced moves, description changes and token rotation.
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  call,
  hello,
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
  await hello(t, "m:1")
  return t
}

const register = (
  t: TestServer,
  token: string,
  id: string,
  description?: string,
) =>
  call(t.url, token, "POST", "/v1/agents", {
    id,
    ...(description === undefined ? {} : { description }),
  })

async function kinds(t: TestServer): Promise<string[]> {
  return (
    await call(t.url, t.admin, "GET", "/v1/history?limit=200")
  ).body.history.map((h: any) => h.kind)
}

describe("registration", () => {
  test("a new ID is registered to the calling session", async () => {
    const t = await start()
    const token = await sessionToken(t, "m:1", "ses_1")
    const res = await register(t, token, "kaggle:lead", "Lead agent")
    expect(res.status).toBe(201)
    expect(res.body.agent).toMatchObject({
      id: "kaggle:lead",
      description: "Lead agent",
      session: "ses_1",
      status: "idle",
    })
    const me = await call(t.url, token, "GET", "/v1/me")
    expect(me.body).toMatchObject({
      registered: true,
      agent: { id: "kaggle:lead", session: "ses_1" },
    })
    expect(await kinds(t)).toContain("agent.registered")
  })

  test("the same ID from the same session is accepted again and nothing changes", async () => {
    const t = await start()
    const token = await sessionToken(t, "m:1", "ses_1")
    await register(t, token, "kaggle:lead", "first")
    const again = await register(t, token, "kaggle:lead", "second")
    expect(again.status).toBe(200)
    expect(again.body.agent.description).toBe("first")
  })

  test("the same ID from another session is refused while the old session lives", async () => {
    const t = await start()
    const one = await sessionToken(t, "m:1", "ses_1")
    const two = await sessionToken(t, "m:1", "ses_2")
    await register(t, one, "kaggle:lead")
    const res = await register(t, two, "kaggle:lead")
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("id_taken")
    expect(await kinds(t)).toContain("agent.refused")
  })

  test("the ID moves to the new session once the old session is gone", async () => {
    const t = await start()
    const one = await sessionToken(t, "m:1", "ses_1")
    const two = await sessionToken(t, "m:1", "ses_2")
    await register(t, one, "kaggle:lead", "kept")
    await call(t.url, t.consumer, "POST", "/v1/hosts/m:1/events", {
      instance: "inst-m:1",
      events: [{ type: "session.deleted", session: "ses_1" }],
    })
    const res = await register(t, two, "kaggle:lead")
    expect(res.status).toBe(200)
    expect(res.body.agent).toMatchObject({
      id: "kaggle:lead",
      session: "ses_2",
      description: "kept",
    })
    expect(await kinds(t)).toContain("agent.moved")
  })

  test("a session that already holds another ID is refused until it unregisters", async () => {
    const t = await start()
    const token = await sessionToken(t, "m:1", "ses_1")
    await register(t, token, "a:one")
    const res = await register(t, token, "a:two")
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("session_has_id")
    expect((await call(t.url, token, "DELETE", "/v1/me")).status).toBe(200)
    expect((await register(t, token, "a:two")).status).toBe(201)
  })

  test("the owner can force the move to a live session", async () => {
    const t = await start()
    const one = await sessionToken(t, "m:1", "ses_1")
    await sessionToken(t, "m:1", "ses_2")
    await register(t, one, "kaggle:lead")
    const refused = await call(t.url, t.admin, "POST", "/v1/agents", {
      id: "kaggle:lead",
      session: "ses_2",
    })
    expect(refused.status).toBe(409)
    const forced = await call(t.url, t.admin, "POST", "/v1/agents", {
      id: "kaggle:lead",
      session: "ses_2",
      force: true,
    })
    expect(forced.status).toBe(200)
    expect(forced.body.agent.session).toBe("ses_2")
    expect((await call(t.url, one, "GET", "/v1/me")).body.registered).toBe(
      false,
    )
  })

  test("reserved and malformed IDs are refused", async () => {
    const t = await start()
    const token = await sessionToken(t, "m:1", "ses_1")
    expect((await register(t, token, "owner")).status).toBe(400)
    expect((await register(t, token, "autocode")).status).toBe(400)
    expect((await register(t, token, "has space")).status).toBe(400)
    expect((await register(t, token, "x".repeat(256))).status).toBe(400)
    expect((await call(t.url, token, "POST", "/v1/agents", {})).status).toBe(
      400,
    )
  })

  test("a description is text of at most 1000 characters", async () => {
    const t = await start()
    const token = await sessionToken(t, "m:1", "ses_1")
    expect((await register(t, token, "a:b", "x".repeat(1001))).status).toBe(400)
  })
})

describe("unregistering", () => {
  test("unregister frees the ID; the history stays", async () => {
    const t = await start()
    const one = await sessionToken(t, "m:1", "ses_1")
    const two = await sessionToken(t, "m:1", "ses_2")
    await register(t, one, "kaggle:lead")
    const res = await call(t.url, one, "DELETE", "/v1/me")
    expect(res.status).toBe(200)
    expect((await call(t.url, one, "GET", "/v1/me")).body.registered).toBe(
      false,
    )
    expect((await register(t, two, "kaggle:lead")).status).toBe(201)
    const history = (
      await call(t.url, t.admin, "GET", "/v1/history?agent=kaggle:lead")
    ).body.history
    expect(history.map((h: any) => h.kind)).toEqual(
      ["agent.registered", "agent.unregistered", "agent.registered"].reverse(),
    )
  })

  test("unregistering an unregistered session answers 404", async () => {
    const t = await start()
    const token = await sessionToken(t, "m:1", "ses_1")
    expect((await call(t.url, token, "DELETE", "/v1/me")).status).toBe(404)
  })

  test("the owner can unregister any agent", async () => {
    const t = await start()
    const token = await sessionToken(t, "m:1", "ses_1")
    await register(t, token, "kaggle:lead")
    expect(
      (await call(t.url, t.admin, "DELETE", "/v1/agents/kaggle:lead")).status,
    ).toBe(200)
    expect((await call(t.url, token, "GET", "/v1/me")).body.registered).toBe(
      false,
    )
    expect(
      (await call(t.url, t.admin, "DELETE", "/v1/agents/kaggle:lead")).status,
    ).toBe(404)
  })
})

describe("discovery and status", () => {
  test("agents discover others by pattern and see ID, description, status and last activity", async () => {
    const t = await start()
    for (const [session, id] of [
      ["ses_1", "kaggle:casmi26:lead"],
      ["ses_2", "kaggle:casmi26:worker-1"],
      ["ses_3", "cosa:updater"],
    ] as const)
      await register(
        t,
        await sessionToken(t, "m:1", session),
        id,
        `about ${id}`,
      )
    const me = await sessionToken(t, "m:1", "ses_1")
    const res = await call(t.url, me, "GET", "/v1/agents?match=kaggle:*")
    expect(res.status).toBe(200)
    expect(res.body.agents.map((a: any) => a.id).sort()).toEqual([
      "kaggle:casmi26:lead",
      "kaggle:casmi26:worker-1",
    ])
    const agent = res.body.agents[0]
    expect(Object.keys(agent).sort()).toEqual([
      "description",
      "id",
      "last_active",
      "status",
    ])
    const list = await call(t.url, me, "GET", "/v1/agents?match=cosa:*,*:lead")
    expect(list.body.agents.map((a: any) => a.id).sort()).toEqual([
      "cosa:updater",
      "kaggle:casmi26:lead",
    ])
    expect(
      (await call(t.url, me, "GET", "/v1/agents?match=bad pattern")).status,
    ).toBe(400)
  })

  test("the owner's view adds the session, host, machine and folder", async () => {
    const t = await start()
    await register(t, await sessionToken(t, "m:1", "ses_1"), "a:b")
    for (const token of [t.admin, t.consumer]) {
      const res = await call(t.url, token, "GET", "/v1/agents")
      expect(res.body.agents[0]).toMatchObject({
        id: "a:b",
        session: "ses_1",
        host: "m:1",
        machine: "m",
        directory: "/work",
      })
    }
  })

  test("an agent is offline while its host is offline", async () => {
    const t = await start({ offlineAfter: 3 })
    const token = await sessionToken(t, "m:1", "ses_1")
    await register(t, token, "a:b")
    expect((await call(t.url, token, "GET", "/v1/me")).body.agent.status).toBe(
      "idle",
    )
    t.clock.advance(5_000)
    t.server.maintenance()
    expect((await call(t.url, token, "GET", "/v1/me")).body.agent.status).toBe(
      "offline",
    )
    expect(
      (await call(t.url, t.admin, "GET", "/v1/agents/a:b")).body.agent.status,
    ).toBe("offline")
  })

  test("an agent's own calls count as activity", async () => {
    const t = await start()
    const token = await sessionToken(t, "m:1", "ses_1")
    await register(t, token, "a:b")
    const before = (await call(t.url, token, "GET", "/v1/me")).body.agent
      .last_active
    t.clock.advance(60_000)
    await call(t.url, token, "GET", "/v1/agents?match=*")
    const after = (await call(t.url, token, "GET", "/v1/me")).body.agent
      .last_active
    expect(Date.parse(after) - Date.parse(before)).toBe(60_000)
  })
})

describe("token rotation", () => {
  test("the owner rotates an agent's token: the old one stops working and the plugin is told to get a new one", async () => {
    const t = await start()
    const old = await sessionToken(t, "m:1", "ses_1")
    await register(t, old, "a:b")
    const res = await call(
      t.url,
      t.admin,
      "POST",
      "/v1/agents/a:b/token/rotate",
    )
    expect(res.status).toBe(200)
    expect((await call(t.url, old, "GET", "/v1/me")).status).toBe(401)
    const polled = await call(
      t.url,
      t.consumer,
      "GET",
      "/v1/hosts/m:1/next?wait=1&instance=inst-m:1",
    )
    const instruction = polled.body.instructions.find(
      (i: any) => i.type === "token",
    )
    // Only the session: the plugin fetches the new token itself, so no token
    // ever sits in the database in plain text.
    expect(instruction.payload).toEqual({ session: "ses_1" })
    const fresh = await sessionToken(t, "m:1", "ses_1")
    expect((await call(t.url, fresh, "GET", "/v1/me")).body.agent.id).toBe(
      "a:b",
    )
    expect(await kinds(t)).toContain("token.rotated")
  })
})

describe("changing an agent", () => {
  test("the owner changes an agent's description; unknown agents, bad IDs and bad text are refused", async () => {
    const t = await start()
    await register(t, await sessionToken(t, "m:1", "ses_1"), "a:b", "before")
    const res = await call(t.url, t.admin, "PATCH", "/v1/agents/a:b", {
      description: "after",
    })
    expect(res.status).toBe(200)
    expect(res.body.agent).toMatchObject({ id: "a:b", description: "after" })
    expect(
      (await call(t.url, t.admin, "GET", "/v1/agents/a:b")).body.agent
        .description,
    ).toBe("after")
    expect(await kinds(t)).toContain("agent.changed")
    expect(
      (
        await call(t.url, t.admin, "PATCH", "/v1/agents/x:y", {
          description: "z",
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await call(t.url, t.admin, "PATCH", "/v1/agents/a:b", {
          description: "x".repeat(1001),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call(t.url, t.admin, "PATCH", "/v1/agents/a:b", {
          description: 5,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call(t.url, t.consumer, "PATCH", "/v1/agents/a:b", {
          description: "no",
        })
      ).status,
    ).toBe(403)
  })
})

describe("deleted sessions", () => {
  test("a late token request for a deleted session is refused, so the session stays gone and its ID can move", async () => {
    const t = await start()
    const gone = await sessionToken(t, "m:1", "ses_gone")
    expect((await register(t, gone, "a:mover")).status).toBe(201)
    await call(t.url, t.consumer, "POST", "/v1/hosts/m:1/events", {
      events: [{ type: "session.deleted", session: "ses_gone" }],
    })
    // a tool call that was in flight gets 401, and the plugin asks for a fresh
    // token for that session
    const late = await call(
      t.url,
      t.consumer,
      "POST",
      "/v1/hosts/m:1/sessions/ses_gone/token",
      {},
    )
    expect(late.status).toBe(410)
    expect(late.body.error.code).toBe("session_gone")
    const next = await sessionToken(t, "m:1", "ses_next")
    expect((await register(t, next, "a:mover")).status).toBe(200)
  })

  test("an agent whose session was deleted shows offline", async () => {
    const t = await start()
    await register(t, await sessionToken(t, "m:1", "ses_1"), "a:b")
    await call(t.url, t.consumer, "POST", "/v1/hosts/m:1/events", {
      events: [{ type: "session.deleted", session: "ses_1" }],
    })
    expect(
      (await call(t.url, t.admin, "GET", "/v1/agents/a:b")).body.agent.status,
    ).toBe("offline")
  })

  test("IDs made only of dots are refused: they could never be addressed in a URL", async () => {
    const t = await start()
    const token = await sessionToken(t, "m:1", "ses_dots")
    for (const id of [".", ".."])
      expect((await register(t, token, id)).status).toBe(400)
  })
})
