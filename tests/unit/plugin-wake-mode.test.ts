/*
 * The plugin's words for wake_mode (spec, Wakes; 1.1.0-rc5): a periodic
 * wake that the owner approves first (ask), what `list` shows of it, the
 * status line, and closing such a proposal.
 */
import { describe, expect, test } from "bun:test"
import {
  runApproval,
  runMe,
  runWake,
  WAKE_TOOL,
} from "../../plugin/src/tools.ts"

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
  trigger: "every 30m",
  check: null,
  next: "2026-10-28T12:30:00.000Z",
  due: "2026-10-28T12:30:00.000Z",
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

describe("wake_mode", () => {
  /*
   * The owner, 2026-11-22: "agent seem to be confused about wake_mode set
   * to approval. make sure it is explained in the instructions and docs
   * that with that setting agent doesnt have to ask for setting up wakes."
   * `approve` reads as "needs approval": it means approved at once.
   */
  test("the tool says that a wake is set at once, with nobody asked, unless status says otherwise", () => {
    expect(WAKE_TOOL.description).toContain(
      "the same name replaces the wake; it is set at once and you ask " +
        "nobody, unless autocode_me status says that the owner approves " +
        "periodic wakes first",
    )
  })

  test("set, asked: the answer says that the wake waits for the owner, and what to do meanwhile", async () => {
    const { call } = server({
      "GET /v1/me": ME,
      "PUT /v1/me/wakes/digest": {
        state: "asked",
        name: "digest",
        approval: "ask_1",
      },
    })
    expect(
      await runWake(
        { action: "set", name: "digest", trigger: "every 1d", text: "Go." },
        call,
      ),
    ).toBe(
      'Wake "digest" is not set yet: a periodic wake needs the owner\'s ' +
        "approval here (ask_1). It is set once approved, counted from " +
        'then, and a notice tells you (approval "Wake digest" approved or ' +
        "rejected). Until then a wake of that name stays as it is. Go on " +
        "with your work, and do not rebuild it from one-time wakes.",
    )
  })

  test("list names the wakes that wait for the owner, also when there is no wake", async () => {
    const proposed = [
      {
        name: "digest",
        trigger: "every 1d from 09:00 until 2026-11-30T08:00:00.000Z",
        approval: "ask_1",
      },
      { name: "poll", trigger: "idle 1h repeat", approval: "ask_2" },
    ]
    const some = server({
      "GET /v1/me": ME,
      "GET /v1/me/wakes": { wakes: [wake({ name: "tick" })], proposed },
    })
    const lines = (await runWake({ action: "list" }, some.call)).split("\n")
    expect(lines.slice(3)).toEqual([
      "Waiting for the owner's approval: digest (every 1d from 09:00 until " +
        "2026-11-30 00:00 PST; approval ask_1); poll (idle 1h repeat; " +
        "approval ask_2). Each is set once approved.",
    ])
    const none = server({
      "GET /v1/me": ME,
      "GET /v1/me/wakes": { wakes: [], proposed: [proposed[1]] },
    })
    expect(await runWake({ action: "list" }, none.call)).toBe(
      "No wakes. Waiting for the owner's approval: poll (idle 1h repeat; " +
        "approval ask_2). Each is set once approved.",
    )
    // an older server names none
    const old = server({ "GET /v1/me": ME, "GET /v1/me/wakes": { wakes: [] } })
    expect(await runWake({ action: "list" }, old.call)).toBe(
      "No wakes. Set one with autocode_wake action=set.",
    )
    // show: a wake that only waits is not there yet
    expect(await runWake({ action: "show", name: "poll" }, none.call)).toBe(
      'error: you have no wake "poll" yet: it waits for the owner\'s ' +
        "approval (ask_2)",
    )
    // show: a wake with a change that waits says so (the review before
    // 1.1.0-rc5)
    const change = server({
      "GET /v1/me": ME,
      "GET /v1/me/wakes": {
        wakes: [wake({ name: "tick", trigger: "every 1h" })],
        proposed: [{ name: "tick", trigger: "every 1m", approval: "ask_9" }],
      },
    })
    const shown = await runWake({ action: "show", name: "tick" }, change.call)
    expect(shown.split("\n")[2]).toBe(
      "A change waits for the owner's approval (ask_9): every 1m. Until " +
        "then the wake stays as it is.",
    )
  })

  test("status says how periodic wakes are gated, unless they are free", async () => {
    const status = async (wake_mode?: string) =>
      runMe(
        { action: "status" },
        server({
          "GET /v1/me": {
            ...ME,
            settings: { ...ME.settings, ...(wake_mode ? { wake_mode } : {}) },
          },
        }).call,
      )
    expect(await status("ask")).toContain(
      "Periodic wakes (every, cron, idle): the owner approves each one " +
        "first (wake_mode ask).",
    )
    expect(await status("off")).toContain(
      "Periodic wakes (every, cron, idle): you cannot set them " +
        "(wake_mode off).",
    )
    // the default says plainly that nobody is asked (the owner,
    // 2026-11-22: agents read `approve` as "needs approval")
    expect(await status("approve")).toContain(
      "Wakes: you set them yourself, at once; no approval is needed " +
        "(wake_mode approve).",
    )
    expect(await status("approve")).not.toContain("Periodic wakes")
    // an older server says nothing of it
    expect(await status()).not.toContain("wake_mode")
  })

  test("closing a wake that waits for the owner says that it is not set", async () => {
    const call = async () => ({
      item: { id: "ask_1", kind: "approval", state: "gone", wake: "digest" },
    })
    expect(
      await runApproval(
        { action: "close", id: "ask_1", text: "not needed" },
        call,
      ),
    ).toBe(
      "Closed approval ask_1: the wake digest is not set. Closed is not " +
        "approved.",
    )
  })
})
