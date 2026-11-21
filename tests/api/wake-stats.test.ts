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
const started = (session = "ses_a") => ({ type: "turn.started", session })
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
  return mine?.week
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

  test("a turn the owner or OpenCode started is nobody's; a prompt into a running turn starts none", async () => {
    await as(a, "PUT", "/v1/me/wakes/hourly", {
      text: "The hourly pass.",
      trigger: "every 1h",
    })
    t.clock.advance(60 * MIN)
    await tick()
    await report(t, HOST, [started(), step(1), ended()])
    // the owner writes in the TUI: a turn with no prompt of Autocode's
    await report(t, HOST, [started(), step(2)])
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
