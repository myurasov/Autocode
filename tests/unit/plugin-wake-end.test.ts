/*
 * The plugin's words for a periodic wake with an end (spec, Wakes;
 * 1.1.0-rc5: `every 1d until 2027-03-01`): the tool names it, and set, list
 * and show tell the end in the server's zone.
 */
import { describe, expect, test } from "bun:test"
import { runWake, WAKE_TOOL } from "../../plugin/src/tools.ts"

// 12:00 UTC is 05:00 PDT
const ME = {
  registered: true,
  session: "ses_a",
  agent: { id: "team:a", status: "idle", paused: "", machine: "m1" },
  server: {
    id: "api-test",
    time: "2026-10-28T12:00:00.000Z",
    timezone: "America/Los_Angeles",
  },
  settings: { min_interval: "1m", max_tool_wait: "5m" },
  wakes: { count: 0, next: null },
  waiting: 0,
}

const wake = (over: Record<string, unknown>) => ({
  agent: "team:a",
  name: "w",
  text: "Go.",
  trigger: "every 1d until 2027-03-02T08:00:00.000Z",
  check: null,
  next: null,
  due: null,
  set_by: "team:a",
  created_at: "2026-10-28T12:00:00.000Z",
  updated_at: "2026-10-28T12:00:00.000Z",
  last_fired_at: null,
  check_failures: 0,
  ...over,
})

function server(answers: Record<string, unknown>) {
  const call = async (method: string, path: string) => {
    const key = `${method} ${path.split("?")[0]}`
    if (!(key in answers)) throw new Error(`unexpected ${key}`)
    return answers[key]
  }
  return { call }
}

describe("a wake with an end", () => {
  test("the tool says which triggers may end, how, and what happens then", () => {
    expect(WAKE_TOOL.description).toContain(
      "every, cron and idle may end: add until 2027-03-01 (through that " +
        "day) or until 2027-03-01 18:00; at its end the wake is removed " +
        "and a notice tells you.",
    )
    expect((WAKE_TOOL.input.properties.trigger as any).description).toContain(
      "every 1d until 2027-03-01",
    )
  })

  test("set says when it ends, in the server's zone", async () => {
    const { call } = server({
      "GET /v1/me": ME,
      "PUT /v1/me/wakes/w": {
        wake: wake({
          next: "2026-10-29T12:00:00.000Z",
          due: "2026-10-29T12:00:00.000Z",
        }),
      },
    })
    expect(
      await runWake(
        {
          action: "set",
          name: "w",
          trigger: "every 1d until 2027-03-01",
          text: "Go.",
        },
        call,
      ),
    ).toBe(
      'Wake "w" set: every 1d until 2027-03-02 00:00 PST. Next run ' +
        "2026-10-29 05:00 PDT (in 1d). It ends 2027-03-02 00:00 PST: then " +
        "it is removed, and a notice tells you. Delivered only while your " +
        "session is idle, at most once per 1m.",
    )
  })

  test("set: an idle wake with an end", async () => {
    const { call } = server({
      "GET /v1/me": ME,
      "PUT /v1/me/wakes/w": {
        wake: wake({
          trigger: "idle 2h repeat until 2026-10-29T07:00:00.000Z",
          due: "2026-10-28T14:00:00.000Z",
        }),
      },
    })
    expect(
      await runWake(
        {
          action: "set",
          name: "w",
          trigger: "idle 2h repeat until 2026-10-29",
          text: "Go.",
        },
        call,
      ),
    ).toBe(
      'Wake "w" set: idle 2h repeat until 2026-10-29 00:00 PDT. It falls ' +
        "due if your session stays idle, at 2026-10-28 07:00 PDT (in 2h), " +
        "and again every 2h while you stay idle. It ends 2026-10-29 00:00 " +
        "PDT: then it is removed, and a notice tells you. Delivered only " +
        "while your session is idle, at most once per 1m.",
    )
  })

  // The review before 1.1.0-rc5: an idle wake without repeat may end too.
  test("set: an idle wake without repeat, with an end", async () => {
    const { call } = server({
      "GET /v1/me": ME,
      "PUT /v1/me/wakes/w": {
        wake: wake({
          trigger: "idle 2h until 2026-10-29T07:00:00.000Z",
          due: "2026-10-28T14:00:00.000Z",
        }),
      },
    })
    expect(
      await runWake(
        {
          action: "set",
          name: "w",
          trigger: "idle 2h until 2026-10-29",
          text: "Go.",
        },
        call,
      ),
    ).toBe(
      'Wake "w" set: idle 2h until 2026-10-29 00:00 PDT. It falls due once ' +
        "per idle stretch: if your session stays idle, at 2026-10-28 07:00 " +
        "PDT (in 2h). It ends 2026-10-29 00:00 PDT: then it is removed, " +
        "and a notice tells you. Delivered only while your session is " +
        "idle, at most once per 1m.",
    )
  })

  // The review before 1.1.0-rc5: during a turn, an idle wake said "due 30m
  // after this turn ends" also when that was past its end.
  test("an idle wake whose next run cannot come before its end says so, also during a turn", async () => {
    const wakes = {
      wakes: [
        wake({
          name: "near",
          trigger: "idle 30m repeat until 2026-10-28T12:10:00.000Z",
        }),
        wake({
          name: "far",
          trigger: "idle 30m until 2026-10-28T18:00:00.000Z",
        }),
      ],
    }
    const working = server({
      "GET /v1/me": { ...ME, agent: { ...ME.agent, status: "working" } },
      "GET /v1/me/wakes": wakes,
    })
    expect(
      await runWake({ action: "show", name: "near" }, working.call),
    ).toContain(
      "Trigger: idle 30m repeat until 2026-10-28 05:10 PDT; no run left " +
        "before its end.",
    )
    expect(
      await runWake({ action: "show", name: "far" }, working.call),
    ).toContain(
      "Trigger: idle 30m until 2026-10-28 11:00 PDT; due 30m after this " +
        "turn ends.",
    )
    // idle, and it ran in this stretch
    const idle = server({ "GET /v1/me": ME, "GET /v1/me/wakes": wakes })
    expect(await runWake({ action: "show", name: "far" }, idle.call)).toContain(
      "Trigger: idle 30m until 2026-10-28 11:00 PDT; ran in this idle " +
        "stretch; due again 30m after your next turn ends.",
    )
  })

  test("list and show: the end in the server's zone, and when no run is left before it", async () => {
    const { call } = server({
      "GET /v1/me": ME,
      "GET /v1/me/wakes": {
        wakes: [
          wake({
            name: "daily",
            next: "2026-10-29T12:00:00.000Z",
            due: "2026-10-29T12:00:00.000Z",
          }),
          wake({
            name: "last",
            trigger: 'cron "0 9 * * *" UTC until 2026-10-28T18:00:00.000Z',
          }),
          wake({
            name: "nudge",
            trigger: "idle 2h repeat until 2026-10-28T13:00:00.000Z",
          }),
        ],
      },
    })
    const list = (await runWake({ action: "list" }, call)).split("\n")
    expect(list[1]).toBe(
      "daily: every 1d until 2027-03-02 00:00 PST; next 2026-10-29 05:00 " +
        "PDT (in 1d); last set 2026-10-28 05:00 PDT",
    )
    expect(list[3]).toBe(
      'last: cron "0 9 * * *" UTC until 2026-10-28 11:00 PDT; no run left ' +
        "before its end; last set 2026-10-28 05:00 PDT",
    )
    expect(list[5]).toBe(
      "nudge: idle 2h repeat until 2026-10-28 06:00 PDT; no run left " +
        "before its end; last set 2026-10-28 05:00 PDT",
    )
    expect(await runWake({ action: "show", name: "last" }, call)).toContain(
      'Trigger: cron "0 9 * * *" UTC until 2026-10-28 11:00 PDT; no run ' +
        "left before its end.",
    )
  })
})
