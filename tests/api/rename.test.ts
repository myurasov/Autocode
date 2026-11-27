/*
 * Renaming an agent in place (1.1.0; the owner, 2026-11-20, from the review
 * of real sessions: two renames done as unregister and register restarted
 * the spend count, lost the agent's own settings and wakes, closed an unread
 * report and left a message to the old ID refused). The agent stays what it
 * is; everything that names it moves in one step; History keeps the old ID
 * and says agent.renamed; the old ID forwards.
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
let a: string // team:a on ses_a
let b: string // team:b on ses_b
const HOST = "m:1"
const MIN = 60_000

const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)
const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const rename = (from: string, to: unknown) =>
  owner("POST", `/v1/agents/${from}/rename`, { id: to })

// The scheduler ticks; the prompts it handed over, acknowledged.
async function tick(): Promise<any[]> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out) await ack(t, HOST, i.id, { ok: true })
  return out.filter((i) => i.type === "inject")
}

const JOB = {
  name: "digest",
  description: "Writes the morning digest",
  model: "fake/main",
  prompt: "Write the digest of incoming/ into digest.md.",
  trigger: 'cron "0 9 * * 1-5"',
  run_usd: 2,
}

beforeEach(async () => {
  t = await testServer()
  await owner("PATCH", "/v1/settings", {
    server: { timezone: "UTC", min_interval: "1s" },
    rules: [{ match: "team:*", settings: { job_mode: "allow" } }],
  })
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  b = await registered(t, HOST, "ses_b", "team:b")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("renaming an agent in place", () => {
  test("everything that names it moves; its session, spend, settings and what waits for it stay its own", async () => {
    // what team:a has: a wake, a lock, spend, its own settings, a job, an
    // unread message to the owner, and a message that waits for it
    await as(a, "PUT", "/v1/me/wakes/hourly", {
      text: "The hourly pass.",
      trigger: "every 1h",
    })
    await as(a, "POST", "/v1/locks/gpu-0/acquire", { ttl: "10m" })
    await owner("PATCH", "/v1/settings", {
      agents: {
        "team:a": { daily_usd: 50 },
        // team:b's questions go to team:a
        "team:b": { question_mode: "agent:team:a" },
      },
    })
    expect((await as(a, "POST", "/v1/me/jobs", JOB)).status).toBe(201)
    await as(a, "POST", "/v1/messages", {
      to: "owner",
      subject: "Report",
      text: "Done.",
    })
    await report(t, HOST, [
      { type: "turn.started", session: "ses_a" },
      {
        type: "cost",
        session: "ses_a",
        usd: 3.5,
        context: 1000,
        limit: 200_000,
      },
    ])
    // its turn runs: a message from team:b waits... as a steer; make it
    // wait for the turn's end instead: a wake fired for it
    await owner("POST", "/v1/agents/team:a/wakes/hourly/fire", {
      text: "now",
    })

    const res = await rename("team:a", "team:lead")
    expect(res.status).toBe(200)
    expect(res.body.agent).toMatchObject({
      id: "team:lead",
      session: "ses_a",
      cost: { today_usd: 3.5, total_usd: 3.5, daily_usd: 50 },
    })
    const ids = (await owner("GET", "/v1/agents")).body.agents.map(
      (x: any) => x.id,
    )
    expect(ids).toEqual(["team:b", "team:lead"])
    // the session is the same agent under its new ID, and is told so
    expect((await as(a, "GET", "/v1/me")).body.agent.id).toBe("team:lead")
    const told = (await instructions(t, HOST)).filter(
      (i) => i.type === "registration",
    )
    expect(told.at(-1).payload).toEqual({
      session: "ses_a",
      agent: "team:lead",
    })
    for (const i of told) await ack(t, HOST, i.id)
    // its wake, its lock, its Inbox item, its settings, its job
    expect(
      (await as(a, "GET", "/v1/me/wakes")).body.wakes.map((w: any) => [
        w.agent,
        w.name,
        w.set_by,
      ]),
    ).toEqual([["team:lead", "hourly", "team:lead"]])
    expect((await owner("GET", "/v1/locks")).body.locks[0].holders).toEqual([
      expect.objectContaining({ agent: "team:lead" }),
    ])
    expect((await owner("GET", "/v1/inbox")).body.items).toEqual([
      expect.objectContaining({ kind: "message", agent: "team:lead" }),
    ])
    const settings = (await owner("GET", "/v1/settings")).body.agents
    expect(settings).toEqual({
      "team:lead": { daily_usd: 50 },
      "team:b": { question_mode: "agent:team:lead" },
    })
    expect(
      (await owner("GET", "/v1/jobs")).body.jobs.map((j: any) => [
        j.name,
        j.created_by,
        j.to,
      ]),
    ).toEqual([["team:lead:digest", "team:lead", "team:lead"]])
    // the agent finds its job by its short name, as before
    expect((await as(a, "DELETE", "/v1/me/jobs/digest")).status).toBe(200)
    // History: the old ID in what was, and that it was renamed
    const renamed = (await owner("GET", "/v1/history?kind=agent.renamed")).body
      .history
    expect(renamed.map((h: any) => [h.agent, h.data])).toEqual([
      ["team:lead", { from: "team:a", to: "team:lead", by: "owner" }],
    ])
    expect(
      (await owner("GET", "/v1/history?kind=wake.set&agent=team:a")).body
        .history.length,
    ).toBe(1)
    // what waited for it comes to it when its turn ends
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    t.clock.advance(MIN)
    const [prompt] = await tick()
    expect(prompt.payload).toMatchObject({ session: "ses_a" })
    expect(prompt.payload.text).toStartWith(
      '[autocode] wake "hourly" fired by the owner\n',
    )
    // its spend goes on under the new ID, and its wake's numbers
    await report(t, HOST, [
      { type: "turn.started", session: "ses_a" },
      { type: "cost", session: "ses_a", usd: 0.5, context: 1000 },
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    expect((await as(a, "GET", "/v1/me")).body.cost.today_usd).toBe(4)
    expect((await as(a, "GET", "/v1/me/wakes")).body.wakes[0].week).toEqual({
      due: 0,
      skipped: 0,
      turns: 1,
      usd: 0.5,
      reload_usd: 0,
    })
    expect(
      (await owner("GET", "/v1/costs")).body.agents.map((x: any) => x.agent),
    ).toEqual(["team:b", "team:lead"])

    /*
     * Nothing still names the old ID, in any column of any table, but what
     * records the past: History, the alias that forwards, and the texts and
     * IDs of messages and prompts that went out before.
     */
    const kept = new Set([
      "history.agent",
      "agent_aliases.old_id",
      "messages.from_id",
    ])
    const left: string[] = []
    for (const { name } of t.server.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[])
      for (const col of t.server.db
        .query(`PRAGMA table_info("${name}")`)
        .all() as { name: string }[]) {
        const n = (
          t.server.db
            .query(
              `SELECT COUNT(*) AS n FROM "${name}" WHERE "${col.name}" = ?`,
            )
            .get("team:a") as { n: number }
        ).n
        if (n && !kept.has(`${name}.${col.name}`))
          left.push(`${name}.${col.name}`)
      }
    expect(left).toEqual([])
  })

  test("the old ID forwards: a message to it, and firing its wake, reach the new ID; until the old ID is registered again", async () => {
    await as(a, "PUT", "/v1/me/wakes/go", { text: "Go.", trigger: "fire-only" })
    expect((await rename("team:a", "team:lead")).status).toBe(200)
    const sent = await as(b, "POST", "/v1/messages", {
      to: "team:a",
      text: "Are you there?",
    })
    expect(sent.status).toBe(201)
    expect(sent.body).toMatchObject({
      recipients: ["team:lead"],
      renamed: { "team:a": "team:lead" },
    })
    const fired = await as(b, "POST", "/v1/agents/team:a/wakes/go/fire")
    expect([fired.status, fired.body]).toEqual([
      200,
      { fired: "go", agent: "team:lead" },
    ])
    const [prompt] = await tick()
    expect(prompt.payload.session).toBe("ses_a")
    expect(prompt.payload.text).toContain("> Are you there?")
    // a pattern matches the registered IDs only
    expect(
      (await as(b, "POST", "/v1/messages", { to: "team:a*", text: "x" }))
        .status,
    ).toBe(404)
    // renamed again: the first ID follows
    expect((await rename("team:lead", "team:chief")).status).toBe(200)
    expect(
      (await as(b, "POST", "/v1/messages", { to: "team:a", text: "Still?" }))
        .body.recipients,
    ).toEqual(["team:chief"])
    // another session registers the old ID: it is that agent's from now on
    await registered(t, HOST, "ses_c", "team:a")
    const anew = await as(b, "POST", "/v1/messages", {
      to: "team:a",
      text: "Hello, new one.",
    })
    expect(anew.body.recipients).toEqual(["team:a"])
    expect(anew.body.renamed).toBeUndefined()
  })

  test("refused: a taken, reserved, bad or same ID; an unknown agent; not the consumer token", async () => {
    const refused = async (from: string, to: unknown) => {
      const res = await rename(from, to)
      return [res.status, res.body.error?.code]
    }
    expect(await refused("team:a", "team:b")).toEqual([409, "id_taken"])
    expect(await refused("team:a", "owner")).toEqual([400, "reserved_id"])
    expect(await refused("team:a", "job:x")).toEqual([400, "reserved_id"])
    expect(await refused("team:a", "no spaces")).toEqual([400, "bad_id"])
    expect(await refused("team:a", "")).toEqual([400, "bad_id"])
    expect(await refused("team:a", "team:a")).toEqual([400, "bad_request"])
    expect(await refused("team:zz", "team:y")).toEqual([404, "not_registered"])
    expect(
      (
        await call(t.url, t.consumer, "POST", "/v1/agents/team:a/rename", {
          id: "team:x",
        })
      ).status,
    ).toBe(403)
    // nothing changed
    expect(
      (await owner("GET", "/v1/agents")).body.agents.map((x: any) => x.id),
    ).toEqual(["team:a", "team:b"])
  })

  test("a job of the agent's whose new name exists already is refused; nothing is half done", async () => {
    expect((await as(a, "POST", "/v1/me/jobs", JOB)).status).toBe(201)
    expect(
      (
        await owner("PUT", "/v1/jobs/team:lead:digest", {
          ...JOB,
          name: undefined,
          host: HOST,
          to: "owner",
        })
      ).status,
    ).toBe(201)
    const res = await rename("team:a", "team:lead")
    expect([res.status, res.body.error.code]).toEqual([409, "job_exists"])
    expect((await as(a, "GET", "/v1/me")).body.agent.id).toBe("team:a")
    expect(
      (await owner("GET", "/v1/jobs")).body.jobs.map((j: any) => j.name),
    ).toEqual(["team:a:digest", "team:lead:digest"])
  })

  test("an agent renames itself; its own settings come along, and a value the new ID already has stays", async () => {
    await owner("PATCH", "/v1/settings", {
      agents: {
        "team:a": { daily_usd: 50, min_interval: "5m" },
        "team:lead": { daily_usd: 100 },
      },
    })
    const res = await as(a, "POST", "/v1/me/rename", { id: "team:lead" })
    expect([res.status, res.body.agent.id]).toEqual([200, "team:lead"])
    expect((await owner("GET", "/v1/settings")).body.agents).toEqual({
      "team:lead": { daily_usd: 100, min_interval: "5m" },
    })
    const renamed = (await owner("GET", "/v1/history?kind=agent.renamed")).body
      .history
    expect(renamed[0].data).toEqual({
      from: "team:a",
      to: "team:lead",
      by: "self",
    })
    // an unregistered session has nothing to rename
    const none = await sessionToken(t, HOST, "ses_none")
    expect(
      (await as(none, "POST", "/v1/me/rename", { id: "x:y" })).status,
    ).toBe(403)
  })

  test("spend the new ID had before is added to: an ID that was used before", async () => {
    // team:old spends and unregisters; its spend stays with its ID
    const old = await registered(t, HOST, "ses_old", "team:old")
    const step = (session: string, usd: number) =>
      report(t, HOST, [
        { type: "cost", session, usd, context: 1000, limit: 200_000 },
      ])
    await step("ses_old", 2)
    await as(old, "DELETE", "/v1/me")
    await step("ses_a", 3)
    expect((await rename("team:a", "team:old")).status).toBe(200)
    expect((await as(a, "GET", "/v1/me")).body.cost).toMatchObject({
      today_usd: 5,
      total_usd: 5,
    })
  })
})
