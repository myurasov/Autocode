/*
 * An end on a periodic wake (spec, Wakes; 1.1.0-rc5; asked for by
 * a project, whose owner grants a wake for a period: "daily until the
 * permit is issued, March 1 at the latest"). `until <time>` as the last
 * words of every, cron and idle: the wake runs while its time is before the
 * end; at the end it is removed and its agent told by a notice. A date
 * alone means through that day. No end on a one-time wake, and none on a
 * job.
 */
import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
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
let a: string // team:a on ses_a
const HOST = "m:1"
const MIN = 60_000
const HOUR = 60 * MIN

const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)
const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)

// Ticks the scheduler and returns the prompts it handed to the plugin.
async function tick(): Promise<string[]> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out.filter((i) => i.type !== "check"))
    await ack(t, HOST, i.id, { ok: true })
  return out.filter((i) => i.type === "inject").map((i) => i.payload.text)
}

// The injected turn runs and ends, as the plugin reports it.
async function turn(session = "ses_a") {
  await report(t, HOST, [{ type: "turn.started", session }])
  await report(t, HOST, [{ type: "turn.ended", session, outcome: "succeeded" }])
}

const set = (name: string, trigger: string, more: object = {}) =>
  as(a, "PUT", `/v1/me/wakes/${name}`, { text: "Go.", trigger, ...more })
const wakes = async () => (await as(a, "GET", "/v1/me/wakes")).body.wakes
const history = async (kind: string) =>
  (await owner("GET", `/v1/history?kind=${kind}&agent=team:a`)).body.history

// The clock starts at 2026-10-28 12:00 UTC, a Wednesday.
beforeEach(async () => {
  t = await testServer()
  await owner("PATCH", "/v1/settings", { server: { timezone: "UTC" } })
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("a periodic wake with an end", () => {
  test("runs while its time is before the end; at the end it is removed, with a notice", async () => {
    const res = await set("w", "every 10m until 2026-10-28T12:30:00Z")
    expect(res.status).toBe(201)
    expect(res.body.wake).toMatchObject({
      trigger: "every 10m until 2026-10-28T12:30:00.000Z",
      next: "2026-10-28T12:10:00.000Z",
    })
    t.clock.advance(10 * MIN)
    const [first, ...more] = await tick()
    expect(more).toEqual([])
    // the prompt names the end in the server's zone
    expect(first).toContain(
      'Wake "w" (every 10m until 2026-10-28 12:30 UTC; next 2026-10-28 ' +
        "12:20 UTC):",
    )
    await turn()
    t.clock.advance(10 * MIN)
    const [second] = await tick()
    // 12:30 is the end: the run of 12:20 was the last
    expect(second).toContain(
      'Wake "w" (every 10m until 2026-10-28 12:30 UTC; no run left before ' +
        "its end):",
    )
    expect((await wakes())[0]).toMatchObject({ next: null, due: null })
    await turn()
    // one minute before the end it is still there
    t.clock.advance(9 * MIN)
    expect(await tick()).toEqual([])
    expect((await wakes()).length).toBe(1)
    t.clock.advance(MIN)
    const [told, ...rest] = await tick()
    expect(rest).toEqual([])
    expect(told).toStartWith(
      '[autocode] wake "w" ended\n\nYour wake "w" (every 10m until ' +
        "2026-10-28 12:30 UTC) reached its end and was removed. If it is " +
        "still needed, set it again (autocode_wake action=set).\n",
    )
    expect(await wakes()).toEqual([])
    expect((await history("wake.due")).length).toBe(2)
    const [ended] = await history("wake.ended")
    expect(ended).toMatchObject({
      agent: "team:a",
      data: { name: "w", trigger: "every 10m until 2026-10-28T12:30:00.000Z" },
    })
    // nothing more, ever
    await turn()
    t.clock.advance(HOUR)
    expect(await tick()).toEqual([])
    expect((await history("wake.ended")).length).toBe(1)
  })

  test("a date alone means through that day, in the server's zone", async () => {
    await owner("PATCH", "/v1/settings", {
      server: { timezone: "America/Los_Angeles" },
    })
    // 05:00 PDT on 28 October; through the 29th: until 30 October 00:00 PDT
    const res = await set("daily", "every 1d until 2026-10-29")
    expect(res.body.wake).toMatchObject({
      trigger: "every 1d until 2026-10-30T07:00:00.000Z",
      next: "2026-10-29T12:00:00.000Z",
    })
    t.clock.advance(24 * HOUR)
    expect((await tick()).length).toBe(1)
    await turn()
    // the 30th at 05:00 would be after the end
    expect((await wakes())[0].next).toBeNull()
    t.clock.advance(18 * HOUR + 59 * MIN)
    expect(await tick()).toEqual([])
    expect((await wakes()).length).toBe(1)
    t.clock.advance(MIN)
    expect((await tick())[0]).toStartWith(
      '[autocode] wake "daily" ended\n\nYour wake "daily" (every 1d until ' +
        "2026-10-30 00:00 PDT) reached its end",
    )
    expect(await wakes()).toEqual([])
  })

  test("cron and idle ... repeat take one too", async () => {
    const cron = await set("c", 'cron "*/15 * * * *" until 2026-10-28 12:40')
    expect(cron.body.wake).toMatchObject({
      trigger: 'cron "*/15 * * * *" UTC until 2026-10-28T12:40:00.000Z',
      next: "2026-10-28T12:15:00.000Z",
    })
    const idle = await set("i", "idle 10m repeat until 12:25")
    expect(idle.body.wake.trigger).toBe(
      "idle 10m repeat until 2026-10-28T12:25:00.000Z",
    )
    // paused, so that no injected turn starts a new idle stretch
    await owner("POST", "/v1/agents/team:a/pause")
    await turn() // idle since 12:00
    const due = async (name: string) =>
      (await history("wake.due")).filter((h: any) => h.data.name === name)
        .length
    expect((await wakes()).find((w: any) => w.name === "i").due).toBe(
      "2026-10-28T12:10:00.000Z",
    )
    t.clock.advance(10 * MIN)
    t.server.tick()
    expect(await due("i")).toBe(1)
    // its next (12:20) is before the end; the one after (12:30) is not
    t.clock.advance(10 * MIN)
    t.server.tick()
    expect(await due("i")).toBe(2)
    expect((await wakes()).find((w: any) => w.name === "i").due).toBeNull()
    expect(await due("c")).toBe(1)
    t.clock.advance(5 * MIN) // 12:25: the idle wake's end
    t.server.tick()
    expect((await wakes()).map((w: any) => w.name)).toEqual(["c"])
    t.clock.advance(5 * MIN) // 12:30: the cron wake's last run
    t.server.tick()
    expect(await due("c")).toBe(2)
    t.clock.advance(10 * MIN) // 12:40: its end
    t.server.tick()
    expect(await due("c")).toBe(2)
    expect(await due("i")).toBe(2)
    expect(await wakes()).toEqual([])
    expect((await history("wake.ended")).map((h: any) => h.data.name)).toEqual([
      "c",
      "i",
    ])
  })

  test("a run that fell due before the end and still waits is delivered; the notice comes at once", async () => {
    await set("w", "every 10m until 2026-10-28T12:15:00Z")
    // a turn runs from 12:05 to 12:20: the run of 12:10 waits
    t.clock.advance(5 * MIN)
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    t.clock.advance(5 * MIN)
    expect(await tick()).toEqual([])
    t.clock.advance(10 * MIN)
    // the end came during the turn: the notice goes into it, like a message
    const [told, ...more] = await tick()
    expect(more).toEqual([])
    expect(told).toStartWith('[autocode] wake "w" ended, during your turn\n')
    expect(told).toContain("reached its end and was removed")
    expect(await wakes()).toEqual([])
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    // the run of 12:10 was in time
    const [prompt, ...rest] = await tick()
    expect(rest).toEqual([])
    expect(prompt).toStartWith(
      '[autocode] wake "w"\n\nWake "w" (every 10m until 2026-10-28 12:15 ' +
        "UTC; no run left before its end):\nGo.\n",
    )
  })

  test("a server that was down across the end delivers no late run", async () => {
    await set("w", "every 10m until 2026-10-28T12:30:00Z")
    t.clock.advance(3 * HOUR)
    const [told, ...more] = await tick()
    expect(more).toEqual([])
    expect(told).toStartWith('[autocode] wake "w" ended\n')
    expect(await history("wake.due")).toEqual([])
    expect(await wakes()).toEqual([])
  })

  test("setting it again without an end takes the end away; with a later one moves it", async () => {
    await set("w", "every 10m until 2026-10-28T12:30:00Z")
    expect((await set("w", "every 10m")).status).toBe(200)
    t.clock.advance(HOUR)
    await tick()
    expect((await wakes()).map((w: any) => w.trigger)).toEqual(["every 10m"])
    expect(await history("wake.ended")).toEqual([])
    await set("w", "every 10m until 2026-10-28T13:30:00Z")
    await set("w", "every 10m until 2026-10-28T14:30:00Z")
    await turn()
    t.clock.advance(HOUR)
    await tick()
    expect((await wakes()).length).toBe(1)
    expect(await history("wake.ended")).toEqual([])
  })

  /*
   * The review before 1.1.0-rc5: an idle wake without repeat runs once in
   * every idle stretch, so again and again; it may end too. And the prompt
   * of an idle wake said "again after 30m more idle" when no such run could
   * come before the end.
   */
  test("an idle wake without repeat takes an end; its prompt says when no run is left", async () => {
    const res = await set("i", "idle 10m until 2026-10-28T12:30:00Z")
    expect(res.status).toBe(201)
    expect(res.body.wake.trigger).toBe(
      "idle 10m until 2026-10-28T12:30:00.000Z",
    )
    await turn() // idle since 12:00
    t.clock.advance(10 * MIN)
    const [first] = await tick()
    expect(first).toContain(
      'Wake "i" (idle 10m until 2026-10-28 12:30 UTC; once per idle stretch):',
    )
    // its own turn starts a new stretch: due again at 12:21, before the end
    t.clock.advance(MIN)
    await turn()
    t.clock.advance(10 * MIN)
    const [second] = await tick()
    // a third (10 minutes after this turn) would not come before 12:30
    expect(second).toContain(
      'Wake "i" (idle 10m until 2026-10-28 12:30 UTC; no run left before ' +
        "its end):",
    )
    t.clock.advance(5 * MIN)
    await turn()
    expect((await wakes())[0]).toMatchObject({ due: null })
    t.clock.advance(9 * MIN)
    const [told] = await tick()
    expect(told).toStartWith('[autocode] wake "i" ended\n')
    expect((await history("wake.due")).length).toBe(2)
  })

  test("an idle ... repeat wake's prompt does not promise a run that cannot come", async () => {
    await set("i", "idle 10m repeat until 2026-10-28T12:25:00Z")
    await turn()
    t.clock.advance(10 * MIN)
    const [first] = await tick()
    expect(first).toContain(
      'Wake "i" (idle 10m repeat until 2026-10-28 12:25 UTC; again after ' +
        "10m more idle):",
    )
    await turn()
    t.clock.advance(10 * MIN)
    const [second] = await tick()
    expect(second).toContain(
      'Wake "i" (idle 10m repeat until 2026-10-28 12:25 UTC; no run left ' +
        "before its end):",
    )
  })

  /*
   * The review before 1.1.0-rc5: the column that holds a wake's end is an
   * old one. A value in it without an end in the trigger (left by a wake's
   * own `end` of the first versions) ends nothing.
   */
  test("a wake whose trigger has no end is never ended, whatever its row says", async () => {
    await set("old", "every 10m")
    const db = new Database(join(t.dataDir, "autocode.db"))
    db.run("UPDATE wakes SET end_at = 5 WHERE name = 'old'")
    db.close()
    t.clock.advance(10 * MIN)
    const [prompt] = await tick()
    expect(prompt).toStartWith('[autocode] wake "old"\n')
    expect((await wakes()).length).toBe(1)
    expect(await history("wake.ended")).toEqual([])
  })

  test("the owner sets one for an agent, and the lists show it", async () => {
    const res = await owner("PUT", "/v1/agents/team:a/wakes/o", {
      text: "Go.",
      trigger: "every 1h until 2026-11-30",
    })
    expect(res.status).toBe(201)
    const all = (await owner("GET", "/v1/wakes")).body.wakes
    expect(all[0]).toMatchObject({
      name: "o",
      set_by: "owner",
      trigger: "every 1h until 2026-12-01T00:00:00.000Z",
    })
  })
})

describe("what is refused", () => {
  const refused = async (trigger: string, why: string) => {
    const res = await set("w", trigger)
    expect(res.status, trigger).toBe(400)
    expect(res.body.error.code, trigger).toBe("bad_trigger")
    expect(res.body.error.message, trigger).toContain(why)
  }

  test("an end on a one-time or fire-only wake", async () => {
    for (const trigger of [
      "in 45m until 2026-11-30",
      "at 2026-10-29 09:00 until 2026-11-30",
      "fire-only until 2026-11-30",
      "fire-only once until 2026-11-30",
    ])
      await refused(
        trigger,
        "only a periodic trigger takes an end (until): every, cron or idle;",
      )
    expect(await wakes()).toEqual([])
  })

  test("an end past the year 9999", async () => {
    await refused(
      "every 1d until 9999-12-31",
      "the end (until) must be before the year 10000",
    )
    expect((await set("far", "every 1d until 9999-12-30")).status).toBe(201)
  })

  test("an end that has passed, or one that cannot be read", async () => {
    await refused("every 10m until 2026-10-27", "has passed already")
    await refused("every 10m until 2026-10-28T12:00:00Z", "has passed already")
    await refused("every 10m until next week", "cannot read the end (until)")
    await refused("every 10m until", "until needs a time")
    expect(await wakes()).toEqual([])
  })

  test("a wake whose first run would not come before its end", async () => {
    const why = "the wake would never run: its first run would not come "
    await refused(
      "every 1h until 2026-10-28T12:30:00Z",
      `${why}before its end (2026-10-28 12:30 UTC)`,
    )
    // a run at the end itself does not happen
    await refused("every 30m until 2026-10-28T12:30:00Z", why)
    await refused('cron "0 9 * * *" until 2026-10-28 18:00', why)
    await refused("idle 30m repeat until 2026-10-28T12:30:00Z", why)
    expect(await wakes()).toEqual([])
    expect(
      (await set("w", "every 29m until 2026-10-28T12:30:00Z")).status,
    ).toBe(201)
  })

  test("the wake's end is part of its trigger, not a field of its own", async () => {
    const res = await set("w", "every 10m", { end: "2026-10-28T12:05:00Z" })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain("unknown field end")
  })

  test("an end on a job's trigger: a job has none", async () => {
    const res = await owner("PUT", "/v1/jobs/digest", {
      host: HOST,
      model: "fake/main",
      prompt: "Write the digest.",
      trigger: "every 1d until 2026-11-30",
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain(
      "a job's trigger takes no end (until)",
    )
  })
})
