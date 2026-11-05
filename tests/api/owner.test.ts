/*
 * Turn status and the owner's controls (spec, Agents and Registration; Owner
 * Controls): the plugin's turn events and hello set an agent's status
 * (working, idle, paused, offline); the owner pauses and resumes one agent,
 * stops all (pause and interrupt) and resumes all; the plugin hears of every
 * registration change of its sessions (for the agent guide).
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
const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const status = async (id: string) =>
  (await owner("GET", `/v1/agents/${id}`)).body.agent

async function drain(): Promise<any[]> {
  const out = await instructions(t, HOST)
  for (const i of out) await ack(t, HOST, i.id, { ok: true })
  return out
}

beforeEach(async () => {
  t = await testServer()
  await hello(t, HOST)
})
afterEach(() => t.stop())

describe("turn status", () => {
  test("turn events make an agent working, then idle with the time it went idle (in the error state after a failed turn)", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    expect((await status("team:a")).status).toBe("idle")
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    expect((await status("team:a")).status).toBe("working")
    t.clock.advance(5000)
    await report(t, HOST, [
      {
        type: "turn.ended",
        session: "ses_a",
        outcome: "failed",
        error: "rate_limit",
      },
    ])
    // a failed turn leaves it in the error state (tier 0b3)
    const agent = await status("team:a")
    expect(agent).toMatchObject({
      status: "error",
      idle_since: "2026-10-28T12:00:05.000Z",
      last_outcome: "failed",
      error: { type: "rate_limit" },
    })
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    expect((await status("team:a")).status).toBe("idle")
  })

  test("a hello says which sessions are busy now (after a reconnect)", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    await registered(t, HOST, "ses_b", "team:b")
    await hello(t, HOST, { active: ["ses_b"] })
    expect((await status("team:a")).status).toBe("idle")
    expect((await status("team:b")).status).toBe("working")
    await hello(t, HOST, { active: [] })
    expect((await status("team:b")).status).toBe("idle")
    // a hello without the list leaves the status as it was
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await hello(t, HOST)
    expect((await status("team:a")).status).toBe("working")
  })

  test("an agent whose host is offline is offline", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    t.clock.advance(60_000)
    t.server.maintenance()
    expect((await status("team:a")).status).toBe("offline")
  })
})

describe("pause, resume, stop all", () => {
  test("pause and resume one agent; unknown agents are refused", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    const paused = await owner("POST", "/v1/agents/team:a/pause")
    expect(paused.body.agent).toMatchObject({
      status: "paused",
      paused: "owner",
    })
    expect(
      (await owner("POST", "/v1/agents/team:a/resume")).body.agent,
    ).toMatchObject({ status: "idle", paused: "" })
    expect((await owner("POST", "/v1/agents/team:zz/pause")).status).toBe(404)
    const history = await owner("GET", "/v1/history?agent=team:a")
    const kinds = history.body.history.map((h: any) => h.kind)
    expect(kinds).toContain("agent.paused")
    expect(kinds).toContain("agent.resumed")
  })

  test("stop all pauses every agent and interrupts every session of an online host; resume all undoes only that", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    await registered(t, HOST, "ses_b", "team:b")
    await registered(t, HOST, "ses_c", "team:c")
    await owner("POST", "/v1/agents/team:c/pause")
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await drain()
    const stop = await owner("POST", "/v1/stop-all")
    expect(stop.body).toEqual({
      paused: ["team:a", "team:b"],
      interrupted: ["ses_a", "ses_b", "ses_c"],
    })
    const sent = await drain()
    expect(
      sent.filter((i) => i.type === "interrupt").map((i) => i.payload),
    ).toEqual([
      { session: "ses_a" },
      { session: "ses_b" },
      { session: "ses_c" },
    ])
    expect((await status("team:b")).paused).toBe("stop-all")
    const resume = await owner("POST", "/v1/resume-all")
    expect(resume.body).toEqual({ resumed: ["team:a", "team:b"] })
    // the owner's own pause stays
    expect((await status("team:c")).paused).toBe("owner")
  })

  test("only the owner may pause or stop", async () => {
    const token = await registered(t, HOST, "ses_a", "team:a")
    expect(
      (await call(t.url, token, "POST", "/v1/agents/team:a/pause")).status,
    ).toBe(403)
    expect((await call(t.url, token, "POST", "/v1/stop-all")).status).toBe(403)
  })
})

describe("registration notices for the plugin", () => {
  test("register, unregister and a forced move each tell the host", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    expect(
      (await drain())
        .filter((i) => i.type === "registration")
        .map((i) => i.payload),
    ).toEqual([{ session: "ses_a", agent: "team:a" }])
    const { sessionToken } = await import("../helpers/server.ts")
    await sessionToken(t, HOST, "ses_b")
    await owner("POST", "/v1/agents", {
      id: "team:a",
      session: "ses_b",
      force: true,
    })
    expect(
      (await drain())
        .filter((i) => i.type === "registration")
        .map((i) => i.payload),
    ).toEqual([
      { session: "ses_a", agent: null },
      { session: "ses_b", agent: "team:a" },
    ])
    await owner("DELETE", "/v1/agents/team:a")
    expect(
      (await drain())
        .filter((i) => i.type === "registration")
        .map((i) => i.payload),
    ).toEqual([{ session: "ses_b", agent: null }])
  })

  test("the hello reply lists the host's registered sessions", async () => {
    await registered(t, HOST, "ses_a", "team:a")
    const res = await hello(t, HOST)
    expect(res.body.registered).toEqual({ ses_a: "team:a" })
  })
})
