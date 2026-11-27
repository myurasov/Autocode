/*
 * What each wake costs (1.1.0; the owner, 2026-11-20, from the review of
 * real sessions: one hourly wake cost $225 in a week and nothing showed it).
 * The server ties a session's turn to the prompt that started it, and counts
 * per wake and day: how often it fell due, how often its check skipped it,
 * the turns its prompts started and those turns' steps and dollars. A wake's
 * view has the last 7 days.
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
let a: string // team:a on ses_a
const HOST = "m:1"
const MIN = 60_000
const DAY = 86_400_000

const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)
const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)

// The scheduler ticks; the checks are answered, the prompts handed over.
async function tick(check?: unknown): Promise<any[]> {
  t.server.tick()
  let out = await instructions(t, HOST)
  for (const i of out.filter((i) => i.type === "check")) {
    await ack(t, HOST, i.id, check ?? { exit: 0, output: "" })
    t.server.tick()
  }
  out = [...out, ...(await instructions(t, HOST))]
  const prompts = out.filter((i) => i.type === "inject")
  for (const i of prompts) await ack(t, HOST, i.id, { ok: true })
  return prompts
}

let steps = 0
const step = (usd: number, session = "ses_a") => ({
  type: "cost",
  session,
  usd,
  context: 1000,
  limit: 200_000,
  model: "fake/main",
  step: `st_${++steps}`,
})
// `by`: what started the turn, as the plugin says it (1.1.0-rc2): "user" (a
// typed prompt: the owner's or Autocode's), "notice" (OpenCode's own: a
// Subagent's result, a background shell's end), "compaction"; an older
// plugin says nothing.
// `ref`: the work a notice belongs to (a command's or a Subagent's ID).
const started = (session = "ses_a", by?: string, ref?: string) => ({
  type: "turn.started",
  session,
  ...(by ? { by } : {}),
  ...(ref ? { ref } : {}),
})
// Work that outlives its turn: a background command, or a Subagent (whose
// own Subagent names it as its parent).
const work = (ref: string, parent?: string, session = "ses_a") => ({
  type: "work.started",
  session,
  ref,
  ...(parent ? { parent } : {}),
})
// A Subagent's step: the top-level session's, with the Subagent's own.
const subStep = (usd: number, sub: string) => ({ ...step(usd), sub })
const ended = (session = "ses_a") => ({
  type: "turn.ended",
  session,
  outcome: "succeeded",
})

// A wake's last 7 days, as its owner and the agent see them.
async function week(name: string) {
  const mine = (await as(a, "GET", "/v1/me/wakes")).body.wakes.find(
    (w: any) => w.name === name,
  )
  const all = (await owner("GET", "/v1/wakes")).body.wakes.find(
    (w: any) => w.agent === "team:a" && w.name === name,
  )
  expect(all?.week).toEqual(mine?.week)
  if (!mine?.week) return mine?.week
  // the reload (1.1.0-rc7) has its own tests: tests/api/cost-parts.test.ts
  const { reload_usd, ...rest } = mine.week
  expect(reload_usd).toBe(0)
  return rest
}

beforeEach(async () => {
  t = await testServer()
  await owner("PATCH", "/v1/settings", {
    server: { timezone: "UTC", min_interval: "1s" },
  })
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("what each wake costs", () => {
  test("a wake's turns, their steps' dollars, and how often it fell due", async () => {
    await as(a, "PUT", "/v1/me/wakes/hourly", {
      text: "The hourly pass.",
      trigger: "every 1h",
    })
    expect(await week("hourly")).toEqual({
      due: 0,
      skipped: 0,
      turns: 0,
      usd: 0,
    })
    t.clock.advance(60 * MIN)
    expect((await tick()).length).toBe(1)
    // the turn that prompt starts: three steps, one of them a Subagent's
    await report(t, HOST, [
      started(),
      step(0.5),
      step(0.25),
      { ...step(0.1), context: undefined },
    ])
    expect(await week("hourly")).toEqual({
      due: 1,
      skipped: 0,
      turns: 1,
      usd: 0.85,
    })
    // a step that comes after the turn's end is still that turn's; a step
    // sent twice counts once
    const last = step(0.15)
    await report(t, HOST, [ended(), last, last])
    expect((await week("hourly")).usd).toBe(1)
    // the same numbers are the agent's own spend
    expect((await as(a, "GET", "/v1/me")).body.cost.today_usd).toBe(1)
  })

  test("a turn the owner started is nobody's; a prompt into a running turn starts none", async () => {
    await as(a, "PUT", "/v1/me/wakes/hourly", {
      text: "The hourly pass.",
      trigger: "every 1h",
    })
    t.clock.advance(60 * MIN)
    await tick()
    await report(t, HOST, [started(), step(1), ended()])
    // the owner writes in the TUI: a turn with no prompt of Autocode's
    await report(t, HOST, [started("ses_a", "user"), step(2)])
    // a message goes into that running turn: it starts no turn
    await owner("POST", "/v1/messages", { to: "team:a", text: "Hello." })
    t.server.tick()
    const [steer] = (await instructions(t, HOST)).filter(
      (i) => i.type === "inject",
    )
    expect(steer.payload.delivery).toBe("steer")
    await ack(t, HOST, steer.id, { ok: true })
    await report(t, HOST, [step(4), ended()])
    expect(await week("hourly")).toEqual({
      due: 1,
      skipped: 0,
      turns: 1,
      usd: 1,
    })
    expect((await as(a, "GET", "/v1/me")).body.cost.today_usd).toBe(7)
  })

  /*
   * 1.1.0-rc2 (the owner, 2026-11-20, on being told that a wake's cost left
   * out the turns that OpenCode's own notices start: "can we fix that?").
   * Such a turn is work that the turn before it began: a Subagent's result,
   * a background shell that ended.
   */
  test("a turn that OpenCode's own notice starts is a turn of the wake before it: its dollars, and the turn; a notice after it too", async () => {
    await as(a, "PUT", "/v1/me/wakes/hourly", {
      text: "The hourly pass.",
      trigger: "every 1h",
    })
    t.clock.advance(60 * MIN)
    await tick()
    // the wake's turn starts a Subagent and ends; the Subagent's steps
    await report(t, HOST, [
      started("ses_a", "user"),
      step(1),
      ended(),
      step(0.25),
    ])
    // its result starts a turn; that turn starts a shell, whose end starts
    // one more
    await report(t, HOST, [started("ses_a", "notice"), step(0.5), ended()])
    expect(await week("hourly")).toEqual({
      due: 1,
      skipped: 0,
      turns: 2,
      usd: 1.75,
    })
    await report(t, HOST, [started("ses_a", "notice"), step(0.125), ended()])
    expect(await week("hourly")).toEqual({
      due: 1,
      skipped: 0,
      turns: 3,
      usd: 1.875,
    })
    expect((await as(a, "GET", "/v1/me")).body.cost.today_usd).toBe(1.875)
  })

  test("the owner's turn ends that: a notice after it is nobody's; so is a compaction, and a turn whose start the plugin does not explain", async () => {
    await as(a, "PUT", "/v1/me/wakes/hourly", {
      text: "The hourly pass.",
      trigger: "every 1h",
    })
    t.clock.advance(60 * MIN)
    await tick()
    await report(t, HOST, [started("ses_a", "user"), step(1), ended()])
    // the owner writes; the shell that turn started ends later
    await report(t, HOST, [started("ses_a", "user"), step(2), ended()])
    await report(t, HOST, [started("ses_a", "notice"), step(4), ended()])
    expect(await week("hourly")).toEqual({
      due: 1,
      skipped: 0,
      turns: 1,
      usd: 1,
    })
    // the wake again, then OpenCode's own compaction: not the wake's, and a
    // notice after it neither
    t.clock.advance(60 * MIN)
    await tick()
    await report(t, HOST, [started("ses_a", "user"), step(1), ended()])
    await report(t, HOST, [started("ses_a", "compaction"), step(8), ended()])
    await report(t, HOST, [started("ses_a", "notice"), step(16), ended()])
    // the wake once more, then a turn that an older plugin reports: no word
    // on what started it
    t.clock.advance(60 * MIN)
    await tick()
    await report(t, HOST, [started("ses_a", "user"), step(1), ended()])
    await report(t, HOST, [started(), step(32), ended()])
    expect(await week("hourly")).toEqual({
      due: 3,
      skipped: 0,
      turns: 3,
      usd: 3,
    })
  })

  test("a notice's turn after a prompt with two wakes divides its cost between them as that prompt's turn did", async () => {
    await owner("PATCH", "/v1/settings", { server: { min_interval: "1h" } })
    for (const name of ["one", "two"])
      await as(a, "PUT", `/v1/me/wakes/${name}`, {
        text: name,
        trigger: "fire-only",
      })
    await owner("POST", "/v1/agents/team:a/wakes/one/fire")
    await owner("POST", "/v1/agents/team:a/wakes/two/fire")
    t.clock.advance(60 * MIN)
    expect((await tick()).length).toBe(1)
    await report(t, HOST, [started("ses_a", "user"), step(1), ended()])
    await report(t, HOST, [started("ses_a", "notice"), step(0.5), ended()])
    for (const name of ["one", "two"])
      expect(await week(name)).toEqual({
        due: 0,
        skipped: 0,
        turns: 2,
        usd: 0.75,
      })
  })

  test("a notice's turn while a prompt of Autocode's is on its way is that prompt's", async () => {
    for (const name of ["one", "two"])
      await as(a, "PUT", `/v1/me/wakes/${name}`, {
        text: name,
        trigger: "fire-only",
      })
    await owner("POST", "/v1/agents/team:a/wakes/one/fire")
    await tick()
    await report(t, HOST, [started("ses_a", "user"), step(1), ended()])
    // the second wake's prompt is handed over; a shell's end starts the turn
    // first, and the prompt joins it
    await owner("POST", "/v1/agents/team:a/wakes/two/fire")
    t.clock.advance(MIN)
    expect((await tick()).length).toBe(1)
    await report(t, HOST, [started("ses_a", "notice"), step(0.5), ended()])
    expect((await week("one")).usd).toBe(1)
    expect(await week("two")).toEqual({
      due: 0,
      skipped: 0,
      turns: 1,
      usd: 0.5,
    })
  })

  /*
   * 1.1.0-rc2, exact attribution (the owner, 2026-11-21: "ok, lets build
   * it!", after a measurement: over a week, $527 of $1,806 wake dollars on
   * one machine were filed under another wake than the one that began the
   * work). A background command or a Subagent is work of the turn that
   * started it, however many other turns run before it ends.
   */
  describe("work that outlives its turn", () => {
    // Two wakes, each fired alone: the prompt of `name` starts a turn.
    async function wakeTurn(name: string, events: unknown[]) {
      await owner("POST", `/v1/agents/team:a/wakes/${name}/fire`)
      t.clock.advance(MIN)
      expect((await tick()).length).toBe(1)
      await report(t, HOST, [started("ses_a", "user"), ...events, ended()])
    }
    const usd = async (name: string) => (await week(name)).usd
    const turns = async (name: string) => (await week(name)).turns

    beforeEach(async () => {
      for (const name of ["one", "two"])
        await as(a, "PUT", `/v1/me/wakes/${name}`, {
          text: name,
          trigger: "fire-only",
        })
    })

    test("a command's notice is a turn of the wake whose turn started the command, not of the wake before it", async () => {
      // one's turn starts a command that still runs when the turn ends
      await wakeTurn("one", [step(1), work("sh_1")])
      // two's turn runs meanwhile
      await wakeTurn("two", [step(2)])
      // the command ends: its notice starts a turn
      await report(t, HOST, [
        started("ses_a", "notice", "sh_1"),
        step(0.5),
        ended(),
      ])
      expect([await usd("one"), await turns("one")]).toEqual([1.5, 2])
      expect([await usd("two"), await turns("two")]).toEqual([2, 1])
      // that turn started a command of its own: one's too, after two's turn
      await report(t, HOST, [
        started("ses_a", "notice", "sh_1"),
        work("sh_2"),
        ended(),
      ])
      await wakeTurn("two", [step(2)])
      await report(t, HOST, [
        started("ses_a", "notice", "sh_2"),
        step(0.25),
        ended(),
      ])
      expect([await usd("one"), await turns("one")]).toEqual([1.75, 4])
      expect([await usd("two"), await turns("two")]).toEqual([4, 2])
    })

    test("a Subagent's steps and its result's turn are its wake's, however long it works; its own Subagent's too", async () => {
      await wakeTurn("one", [
        step(1),
        work("ses_child"),
        subStep(0.5, "ses_child"),
      ])
      // two's turn starts while the Subagent works on; the Subagent starts
      // one of its own
      await owner("POST", "/v1/agents/team:a/wakes/two/fire")
      t.clock.advance(MIN)
      await tick()
      await report(t, HOST, [
        started("ses_a", "user"),
        step(2),
        subStep(0.25, "ses_child"),
        work("ses_grandchild", "ses_child"),
        subStep(0.125, "ses_grandchild"),
        ended(),
        subStep(0.0625, "ses_child"),
      ])
      expect(await usd("one")).toBe(1.9375)
      expect(await usd("two")).toBe(2)
      // its result starts a turn: one's
      await report(t, HOST, [
        started("ses_a", "notice", "ses_child"),
        step(0.5),
        ended(),
      ])
      expect([await usd("one"), await turns("one")]).toEqual([2.4375, 2])
      expect([await usd("two"), await turns("two")]).toEqual([2, 1])
      // every dollar once
      expect((await as(a, "GET", "/v1/me")).body.cost.today_usd).toBe(4.4375)
    })

    test("work that the owner's turn started is nobody's, also after a wake's turn; work that is not known goes by the turn before", async () => {
      // the owner writes; that turn starts a command and a Subagent
      await report(t, HOST, [
        started("ses_a", "user"),
        step(8),
        work("sh_own"),
        work("ses_own"),
        ended(),
      ])
      await wakeTurn("two", [step(2), subStep(16, "ses_own")])
      await report(t, HOST, [
        started("ses_a", "notice", "sh_own"),
        step(32),
        ended(),
      ])
      expect([await usd("two"), await turns("two")]).toEqual([2, 1])
      // a notice and a step whose work was never reported (the plugin was
      // loaded later): as without name tags, the wake of the turn before
      await wakeTurn("two", [step(1)])
      await report(t, HOST, [
        started("ses_a", "notice", "sh_unknown"),
        step(0.5),
        subStep(0.25, "ses_unknown"),
        ended(),
      ])
      expect([await usd("two"), await turns("two")]).toEqual([3.75, 3])
      expect(await usd("one")).toBe(0)
    })

    test("the first report of a work stands; unregistering forgets the agent's; old ones go with the history", async () => {
      const rows = () =>
        t.server.db
          .query(
            "SELECT ref, cause IS NOT NULL AS caused FROM turn_work ORDER BY ref",
          )
          .all() as { ref: string; caused: number }[]
      await wakeTurn("one", [step(1), work("sh_1")])
      // reported again in the owner's turn (a batch sent twice): still one's
      await report(t, HOST, [
        started("ses_a", "user"),
        work("sh_1"),
        work("sh_o"),
        ended(),
      ])
      expect(rows()).toEqual([
        { ref: "sh_1", caused: 1 },
        { ref: "sh_o", caused: 0 },
      ])
      // bad reports are not kept
      await report(t, HOST, [
        { type: "work.started", session: "ses_a" },
        { type: "work.started", session: "ses_a", ref: 7 },
        { type: "work.started", session: "ses_a", ref: "x".repeat(300) },
        { type: "work.started", session: "ses_none", ref: "sh_2" },
      ])
      expect(rows().length).toBe(2)
      // one from long ago goes with the wakes' numbers (history_days, 31
      // days at least); the others stay
      t.server.db
        .query(
          "INSERT INTO turn_work (session_id, ref, cause, at) " +
            "VALUES ('ses_a', 'sh_old', NULL, 0)",
        )
        .run()
      expect(rows().length).toBe(3)
      t.server.maintenance()
      expect(rows().map((r) => r.ref)).toEqual(["sh_1", "sh_o"])
      // unregistering: the agent's records go, and its session's last turn
      // is nobody's
      await as(a, "DELETE", "/v1/me")
      expect(rows()).toEqual([])
      expect(
        t.server.db
          .query("SELECT turn_cause FROM sessions WHERE id = 'ses_a'")
          .get(),
      ).toEqual({ turn_cause: null })
    })
  })

  test("a check's skips are counted, and cost nothing", async () => {
    await as(a, "PUT", "/v1/me/wakes/poll", {
      text: "New files.",
      trigger: "every 10m",
      check: "./new-files.sh",
    })
    for (let i = 0; i < 3; i++) {
      t.clock.advance(10 * MIN)
      expect(await tick({ exit: 1, output: "" })).toEqual([])
    }
    t.clock.advance(10 * MIN)
    expect((await tick({ exit: 0, output: "2 files" })).length).toBe(1)
    await report(t, HOST, [started(), step(0.4), ended()])
    expect(await week("poll")).toEqual({
      due: 4,
      skipped: 3,
      turns: 1,
      usd: 0.4,
    })
  })

  test("one prompt with two wakes divides its cost; a message in it takes no share; a fired wake counts", async () => {
    await owner("PATCH", "/v1/settings", { server: { min_interval: "1h" } })
    for (const name of ["one", "two"])
      await as(a, "PUT", `/v1/me/wakes/${name}`, {
        text: name,
        trigger: "fire-only",
      })
    // a first prompt, so that the two fires wait for min_interval together
    await owner("POST", "/v1/agents/team:a/wakes/one/fire")
    await tick()
    await report(t, HOST, [started(), step(0.2), ended()])
    await owner("POST", "/v1/agents/team:a/wakes/one/fire")
    await owner("POST", "/v1/agents/team:a/wakes/two/fire")
    await owner("POST", "/v1/messages", { to: "team:a", text: "Hello." })
    t.clock.advance(60 * MIN)
    const [prompt] = await tick()
    expect(prompt.payload.text).toStartWith(
      '[autocode] wake "one" fired by the owner, wake "two" fired by the ' +
        "owner, 1 message\n",
    )
    await report(t, HOST, [started(), step(0.5), step(0.5), ended()])
    // fired, not fallen due
    expect(await week("one")).toEqual({
      due: 0,
      skipped: 0,
      turns: 2,
      usd: 0.7,
    })
    expect(await week("two")).toEqual({
      due: 0,
      skipped: 0,
      turns: 1,
      usd: 0.5,
    })
  })

  test("the last 7 days: today and the six days before; set again keeps them; a new wake of a cancelled name starts over only in what it shows", async () => {
    await as(a, "PUT", "/v1/me/wakes/daily", {
      text: "The day's pass.",
      trigger: "every 1d",
    })
    for (let day = 0; day < 9; day++) {
      t.clock.advance(DAY)
      expect((await tick()).length).toBe(1)
      await report(t, HOST, [started(), step(1), ended()])
    }
    // nine runs, one a day: the last seven count
    expect(await week("daily")).toEqual({
      due: 7,
      skipped: 0,
      turns: 7,
      usd: 7,
    })
    // set again (a new text): the same wake, by its name
    await as(a, "PUT", "/v1/me/wakes/daily", {
      text: "The day's pass, v2.",
      trigger: "every 1d",
    })
    expect((await week("daily")).turns).toBe(7)
    // unregistering removes them with the wakes
    await as(a, "DELETE", "/v1/me")
    const again = await registered(t, HOST, "ses_a", "team:a")
    await call(t.url, again, "PUT", "/v1/me/wakes/daily", {
      text: "New.",
      trigger: "every 1d",
    })
    a = again
    expect(await week("daily")).toEqual({
      due: 0,
      skipped: 0,
      turns: 0,
      usd: 0,
    })
  })

  test("a job's run is not a wake's turn", async () => {
    await as(a, "PUT", "/v1/me/wakes/hourly", {
      text: "The hourly pass.",
      trigger: "every 1h",
    })
    t.clock.advance(60 * MIN)
    await tick()
    await report(t, HOST, [started(), step(1), ended()])
    // another session of the host, not the agent's: nothing of the wake's
    await report(t, HOST, [
      started("ses_other"),
      step(5, "ses_other"),
      ended("ses_other"),
    ])
    expect((await week("hourly")).usd).toBe(1)
  })
})
