/*
 * wake_mode (spec, Wakes; 1.1.0-rc5; asked for by a project: "the owner
 * approves every periodic wake with its exact terms. A wake re-reads the
 * whole context, so an unapproved hourly wake gets costly"). Per agent and
 * pattern, like job_mode, for the periodic wakes an agent sets for itself
 * (every, cron, idle ... repeat): approve (the default: set at once), ask
 * (an approval in the owner's Inbox with the wake's exact terms; the wake
 * is set once the owner approves it) or off (refused). One-time wakes,
 * cancelling, firing and the owner's own setting stay free.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ack,
  call,
  hello,
  instructions,
  registered,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

let t: TestServer
let lead: string
const HOST = "m:1"
const MIN = 60_000
const HOUR = 60 * MIN

const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)

const set = (name: string, trigger: string, more: object = {}) =>
  as(lead, "PUT", `/v1/me/wakes/${name}`, { text: "Go.", trigger, ...more })
const mine = async () => (await as(lead, "GET", "/v1/me/wakes")).body
const wakeOf = async (name: string) =>
  (await mine()).wakes.find((w: any) => w.name === name)
const approvals = async () =>
  (await owner("GET", "/v1/inbox")).body.items.filter(
    (i: any) => i.kind === "approval",
  )
const answer = (id: string, text: string) =>
  owner("POST", `/v1/asks/${id}/answer`, { text })
const mode = (value: string) =>
  owner("PATCH", "/v1/settings", {
    agents: { "team:lead": { wake_mode: value } },
  })
// One tick; the prompts it sent to the agent's session (acked).
async function prompts(): Promise<string[]> {
  t.server.tick()
  const out = await instructions(t, HOST)
  for (const i of out) await ack(t, HOST, i.id, { ok: true })
  return out
    .filter((i) => i.type === "inject" && i.payload.session === "ses_lead")
    .map((i) => i.payload.text as string)
}

// The clock starts at 2026-10-28 12:00 UTC.
beforeEach(async () => {
  t = await testServer()
  await owner("PATCH", "/v1/settings", {
    server: { min_interval: "1s", timezone: "UTC" },
  })
  await hello(t, HOST)
  lead = await registered(t, HOST, "ses_lead", "team:lead")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("wake_mode approve (the default)", () => {
  test("a periodic wake is set at once, as before, and nothing is asked", async () => {
    const res = await set("tick", "every 1h")
    expect(res.status).toBe(201)
    expect(res.body.wake).toMatchObject({ name: "tick", trigger: "every 1h" })
    expect(await approvals()).toEqual([])
    expect((await mine()).proposed).toEqual([])
  })
})

describe("wake_mode ask", () => {
  beforeEach(async () => {
    await owner("PATCH", "/v1/settings", {
      rules: [{ match: "team:*", settings: { wake_mode: "ask" } }],
    })
  })

  test("a periodic wake goes to the owner with its exact terms; it is set once approved", async () => {
    const res = await set("digest", "every 1d from 09:00 until 2026-11-29", {
      text: "Write the digest.\nThen mail it.",
      check: "./has-mail.sh",
      check_timeout: "5m",
    })
    expect(res.status).toBe(202)
    const [item, ...more] = await approvals()
    expect(more).toEqual([])
    expect(res.body).toEqual({
      state: "asked",
      name: "digest",
      approval: item.id,
    })
    expect(item).toMatchObject({
      agent: "team:lead",
      title: "Wake digest, set by team:lead",
      routed: "owner",
      expires: null,
    })
    expect(item.text).toBe(
      [
        "team:lead asks to set the wake digest:",
        "- trigger: every 1d from 09:00 until 2026-11-30 00:00 UTC",
        "- check: ./has-mail.sh (up to 5m)",
        "",
        "Its text:",
        "> Write the digest.",
        "> Then mail it.",
      ].join("\n"),
    )
    // no wake yet; the agent sees what waits, and does not wait itself
    expect(await mine()).toEqual({
      wakes: [],
      proposed: [
        {
          name: "digest",
          trigger: "every 1d from 09:00 until 2026-11-30T00:00:00.000Z",
          approval: item.id,
        },
      ],
    })
    const me = (await as(lead, "GET", "/v1/me")).body
    expect(me.asks).toEqual([])
    expect((await owner("GET", "/v1/agents/team:lead")).body.agent.status).toBe(
      "idle",
    )
    expect(await prompts()).toEqual([])
    // approved an hour later: set then, with what was shown
    t.clock.advance(HOUR)
    expect((await answer(item.id, "approve")).status).toBe(200)
    expect(await wakeOf("digest")).toMatchObject({
      trigger: "every 1d from 09:00 until 2026-11-30T00:00:00.000Z",
      text: "Write the digest.\nThen mail it.",
      check: "./has-mail.sh",
      check_timeout: "5m",
      set_by: "team:lead",
      updated_at: "2026-10-28T13:00:00.000Z",
      next: "2026-10-29T09:00:00.000Z",
    })
    expect((await mine()).proposed).toEqual([])
    const [notice] = await prompts()
    expect(notice).toStartWith(
      '[autocode] approval "Wake digest" approved\n\nYour approval "Wake ' +
        'digest" was approved by the owner. The wake digest is set.\n',
    )
    const h = (await owner("GET", "/v1/history?kind=wake.set")).body.history
    expect(h[0]).toMatchObject({
      agent: "team:lead",
      data: { name: "digest", by: "team:lead", replaced: false },
    })
    const opened = (await owner("GET", "/v1/history?kind=ask.opened")).body
      .history
    expect(opened[0].data).toMatchObject({
      id: item.id,
      kind: "approval",
      routed: "owner",
      wake: "digest",
    })
  })

  test("the owner rejects it: no wake; the agent is told, with the reason", async () => {
    await set("tick", "every 1h")
    const [item] = await approvals()
    await answer(item.id, "reject: too often")
    expect((await mine()).wakes).toEqual([])
    expect((await mine()).proposed).toEqual([])
    const [notice] = await prompts()
    expect(notice).toContain('approval "Wake tick" rejected')
    expect(notice).toContain("too often")
    expect(notice).not.toContain("is set")
  })

  test("every, cron and idle ... repeat ask; one-time wakes, cancelling and firing stay free", async () => {
    for (const trigger of ["every 30m", 'cron "0 9 * * 1-5"', "idle 1h repeat"])
      expect((await set("p", trigger)).status, trigger).toBe(202)
    // each proposal of the same wake replaced the one before
    expect((await approvals()).length).toBe(1)
    let n = 0
    for (const trigger of [
      "in 45m",
      "at 2026-10-29 09:00",
      "at 18:00",
      "idle 30m",
      "fire-only",
      "fire-only once",
    ]) {
      n += 1
      expect((await set(`one${n}`, trigger)).status, trigger).toBe(201)
    }
    expect((await mine()).wakes.length).toBe(6)
    expect((await approvals()).length).toBe(1)
    expect((await as(lead, "DELETE", "/v1/me/wakes/one1")).status).toBe(200)
    const fired = await as(
      lead,
      "POST",
      "/v1/agents/team:lead/wakes/one5/fire",
      {},
    )
    expect(fired.status).toBe(200)
  })

  test("the owner's own setting of an agent's wake is not asked for", async () => {
    const res = await owner("PUT", "/v1/agents/team:lead/wakes/tick", {
      text: "Go.",
      trigger: "every 1h",
    })
    expect(res.status).toBe(201)
    expect(await approvals()).toEqual([])
  })

  test("a change asks again, and the wake stays as it was until approved", async () => {
    await mode("approve")
    await set("tick", "every 2h")
    await mode("ask")
    const res = await set("tick", "every 30m", { text: "Go faster." })
    expect(res.status).toBe(202)
    expect(await wakeOf("tick")).toMatchObject({
      trigger: "every 2h",
      text: "Go.",
    })
    const [item] = await approvals()
    expect(item.text).toBe(
      [
        "team:lead asks to change the wake tick:",
        "- trigger: every 30m",
        "- now: every 2h",
        "",
        "Its text:",
        "> Go faster.",
      ].join("\n"),
    )
    await answer(item.id, "approve")
    expect(await wakeOf("tick")).toMatchObject({
      trigger: "every 30m",
      text: "Go faster.",
    })
    const h = (await owner("GET", "/v1/history?kind=wake.set")).body.history
    expect(h[0].data).toMatchObject({ name: "tick", replaced: true })
  })

  test("setting a wake again with the terms it has asks nothing", async () => {
    await mode("approve")
    await set("tick", "every 2h", { check: "./c.sh", check_timeout: "2m" })
    await mode("ask")
    t.clock.advance(HOUR)
    // the same trigger, written another way
    const same = await set("tick", "every 120m", {
      check: "./c.sh",
      check_timeout: "120s",
    })
    expect(same.status).toBe(200)
    expect(same.body.wake).toMatchObject({
      trigger: "every 2h",
      updated_at: "2026-10-28T13:00:00.000Z",
    })
    expect(await approvals()).toEqual([])
    // any other term asks: the text, the check, its time limit, the trigger
    for (const more of [
      { text: "Go on.", check: "./c.sh", check_timeout: "2m" },
      { check: "./other.sh", check_timeout: "2m" },
      { check: "./c.sh", check_timeout: "3m" },
      { check: "./c.sh" },
      {},
    ])
      expect(
        (await set("tick", "every 2h", more)).status,
        JSON.stringify(more),
      ).toBe(202)
    const moved = await set("tick", "every 2h from 09:00", {
      check: "./c.sh",
      check_timeout: "2m",
    })
    expect(moved.status).toBe(202)
    // the wake itself is as it was
    expect(await wakeOf("tick")).toMatchObject({
      trigger: "every 2h",
      check: "./c.sh",
      check_timeout: "2m",
    })
  })

  test("the terms are checked before anything is asked", async () => {
    for (const [trigger, more] of [
      ["sometimes", {}],
      ["every 1h until 2026-10-27", {}],
      ["every 1h", { text: "" }],
      ["every 1h", { check_timeout: "5m" }],
      ["every 1h", { check: "./c.sh", check_timeout: "3h" }],
      ["every 1h", { end: "2026-11-30" }],
    ] as [string, object][]) {
      const res = await set("w", trigger, more)
      expect(res.status, trigger).toBe(400)
    }
    expect((await set("bad name", "every 1h")).status).toBe(400)
    expect(await approvals()).toEqual([])
    expect((await mine()).proposed).toEqual([])
  })

  test("an end that passed before the owner approved: no wake, and the notice says why", async () => {
    await set("w", "every 10m until 2026-10-28T12:30:00Z")
    const [item] = await approvals()
    t.clock.advance(HOUR)
    await answer(item.id, "approve")
    expect((await mine()).wakes).toEqual([])
    const [notice] = await prompts()
    expect(notice).toContain('approval "Wake w" approved')
    expect(notice).toContain("The wake w could not be set: ")
    expect(notice).toContain("has passed already")
  })

  test("the agent takes its proposal back; it goes with the agent too", async () => {
    await set("tick", "every 1h")
    const [item] = await approvals()
    const closed = await as(lead, "POST", "/v1/me/inbox/close", {
      id: item.id,
      text: "not needed after all",
    })
    expect(closed.status).toBe(200)
    expect(closed.body.item).toMatchObject({
      id: item.id,
      state: "gone",
      wake: "tick",
    })
    expect(await approvals()).toEqual([])
    expect(await mine()).toEqual({ wakes: [], proposed: [] })
    // a new one, then the agent unregisters
    await set("tick", "every 1h")
    expect((await approvals()).length).toBe(1)
    await as(lead, "DELETE", "/v1/me")
    expect(await approvals()).toEqual([])
  })

  test("a proposal follows a rename, and never keeps the agent from its other wakes", async () => {
    await set("tick", "every 1h")
    // a one-time wake of the agent's still comes while the proposal is open
    await set("soon", "in 1m")
    t.clock.advance(MIN)
    const [prompt] = await prompts()
    expect(prompt).toStartWith('[autocode] wake "soon"\n')
    await as(lead, "POST", "/v1/me/rename", { id: "team:chief" })
    const [item] = await approvals()
    expect(item.agent).toBe("team:chief")
    await answer(item.id, "approve")
    const all = (await owner("GET", "/v1/wakes")).body.wakes
    expect(all.map((w: any) => [w.agent, w.name])).toEqual([
      ["team:chief", "tick"],
    ])
  })
})

describe("wake_mode off", () => {
  test("a periodic wake is refused, with the reason; one-time wakes are set", async () => {
    await mode("off")
    for (const trigger of [
      "every 30m",
      'cron "0 9 * * 1-5"',
      "idle 1h repeat",
    ]) {
      const res = await set("p", trigger)
      expect(res.status, trigger).toBe(403)
      expect(res.body.error).toEqual({
        code: "forbidden",
        message:
          "you cannot set periodic wakes (every, cron, idle ... repeat): " +
          "wake_mode is off (the owner's setting); one-time wakes (in, at, " +
          "idle without repeat, fire-only) stay free",
      })
    }
    expect((await set("once", "in 45m")).status).toBe(201)
    expect(await approvals()).toEqual([])
    // the owner still sets one for it
    const res = await owner("PUT", "/v1/agents/team:lead/wakes/tick", {
      text: "Go.",
      trigger: "every 1h",
    })
    expect(res.status).toBe(201)
    // which the agent cannot set again, and may cancel
    expect((await set("tick", "every 1h")).status).toBe(403)
    expect((await as(lead, "DELETE", "/v1/me/wakes/tick")).status).toBe(200)
  })
})
