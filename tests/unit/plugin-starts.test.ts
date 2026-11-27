/*
 * What started a session's turn, as the plugin tells the server (1.1.0-rc2;
 * the owner, 2026-11-20: a wake's cost must count the turns that OpenCode's
 * own notices start). OpenCode announces each input of a session
 * (session.inbox.enqueued) before the turn it starts and says when it was
 * delivered or cancelled; the oldest input that still waits when a turn
 * starts is what started it: a typed prompt is `user`, OpenCode's own
 * (a Subagent's result, a background shell's end) a `notice`, which names
 * its work: the command or the Subagent. And the work that outlives its
 * turn (exact attribution; the owner, 2026-11-21: "ok, lets build it!"):
 * the commands of a session that still run when its turn ends.
 */
import { describe, expect, test } from "bun:test"
import { Inputs, inputKind, inputRef, Shells } from "../../plugin/src/starts.ts"

// The items of OpenCode 2.3.0's session.inbox.enqueued, as seen live.
const USER = {
  type: "user",
  payload: { text: '[autocode] wake "hourly"' },
  delivery: "queue",
}
const SHELL = {
  type: "synthetic",
  payload: {
    text: '<shell id="sh_1" state="completed">',
    metadata: {
      source: "shell",
      shellID: "sh_1",
      jobID: "sh_1",
      state: "completed",
      exit: 0,
    },
  },
  delivery: "steer",
}
const SUBAGENT = {
  type: "synthetic",
  payload: {
    text: '<subagent sessionID="ses_c" state="completed">',
    metadata: { source: "subagent", childID: "ses_c", agent: "general" },
  },
  delivery: "steer",
}

describe("what an input is", () => {
  test("a typed prompt is user, OpenCode's own a notice, a compaction itself; anything else by its name, or nothing", () => {
    expect(inputKind(USER)).toBe("user")
    expect(inputKind(SHELL)).toBe("notice")
    expect(inputKind(SUBAGENT)).toBe("notice")
    expect(inputKind({ type: "compaction", payload: {} })).toBe("compaction")
    expect(inputKind({ type: "move" })).toBe("move")
    for (const bad of [null, undefined, "user", {}, { type: 7 }, { type: "" }])
      expect(inputKind(bad)).toBeUndefined()
    // a name is a short word: nothing else reaches the server
    expect(inputKind({ type: "x".repeat(40) })).toBeUndefined()
    expect(inputKind({ type: "not a word" })).toBeUndefined()
  })

  test("a notice names its work: a command by its ID, a Subagent by its session; a prompt names none", () => {
    expect(inputRef(SHELL)).toBe("sh_1")
    expect(inputRef(SUBAGENT)).toBe("ses_c")
    expect(inputRef(USER)).toBeUndefined()
    for (const bad of [
      null,
      { type: "synthetic" },
      { type: "synthetic", payload: { metadata: { shellID: 7 } } },
      { type: "synthetic", payload: { metadata: { shellID: "" } } },
      {
        type: "synthetic",
        payload: { metadata: { childID: "x".repeat(300) } },
      },
    ])
      expect(inputRef(bad)).toBeUndefined()
  })
})

describe("what started a turn", () => {
  test("the input that waits when the turn starts; none once it was delivered or cancelled", () => {
    const inputs = new Inputs()
    expect(inputs.starter("ses_a")).toBeUndefined()
    // idle: the notice is announced, the turn starts, then it is delivered
    inputs.enqueued("ses_a", "in_1", SHELL)
    expect(inputs.starter("ses_a")).toEqual({ by: "notice", ref: "sh_1" })
    expect(inputs.starter("ses_b")).toBeUndefined()
    inputs.settled("ses_a", "in_1")
    expect(inputs.starter("ses_a")).toBeUndefined()
    // a prompt, typed or Autocode's: with its ID, which is the ID that
    // Autocode's server gave its own prompt (1.1.0-rc7: the server then
    // knows which prompt started the turn, a steer prompt's too)
    inputs.enqueued("ses_a", "msg_019ac5d1f2e0a1b2c3d4e5f6", USER)
    expect(inputs.starter("ses_a")).toEqual({
      by: "user",
      prompt: "msg_019ac5d1f2e0a1b2c3d4e5f6",
    })
    inputs.settled("ses_a", "msg_019ac5d1f2e0a1b2c3d4e5f6")
    // an ID that is none is left out
    for (const odd of ["", "a b", "x".repeat(201)]) {
      inputs.enqueued("ses_a", odd, USER)
      expect(inputs.starter("ses_a")).toEqual({ by: "user" })
      inputs.settled("ses_a", odd)
    }
    // one that was cancelled starts nothing
    inputs.enqueued("ses_a", "in_3", SUBAGENT)
    inputs.settled("ses_a", "in_3")
    expect(inputs.starter("ses_a")).toBeUndefined()
    expect(inputs.size).toBe(0)
  })

  test("of several that wait, the oldest: a prompt queued during a turn starts the next one, whatever came into the turn meanwhile", () => {
    const inputs = new Inputs()
    // during a turn: the owner queues a prompt; a shell's end joins the turn
    inputs.enqueued("ses_a", "in_1", USER)
    inputs.enqueued("ses_a", "in_2", SHELL)
    inputs.settled("ses_a", "in_2")
    // the turn ends, the next starts
    expect(inputs.starter("ses_a")).toEqual({ by: "user", prompt: "in_1" })
    inputs.settled("ses_a", "in_1")
    // two notices at once
    inputs.enqueued("ses_a", "in_3", SUBAGENT)
    inputs.enqueued("ses_a", "in_4", USER)
    expect(inputs.starter("ses_a")).toEqual({ by: "notice", ref: "ses_c" })
    // an input that is no known kind is not kept
    inputs.enqueued("ses_b", "in_5", {})
    expect(inputs.starter("ses_b")).toBeUndefined()
  })

  test("a deleted session is forgotten; a lost event stream forgets all; a session's list stays short", () => {
    const inputs = new Inputs()
    inputs.enqueued("ses_a", "in_1", USER)
    inputs.enqueued("ses_b", "in_2", SHELL)
    inputs.forget("ses_a")
    expect(inputs.starter("ses_a")).toBeUndefined()
    expect(inputs.starter("ses_b")?.by).toBe("notice")
    // events were missed: what waits is not known any more
    inputs.clear()
    expect(inputs.starter("ses_b")).toBeUndefined()
    // deliveries never seen: only the newest 50 are kept
    for (let i = 0; i < 80; i++)
      inputs.enqueued("ses_c", `in_${i}`, i < 30 ? USER : SHELL)
    expect(inputs.size).toBe(50)
    expect(inputs.starter("ses_c")?.by).toBe("notice")
  })
})

/*
 * Exact attribution: OpenCode says when a command starts (shell.created:
 * its ID and its session) and ends (shell.exited: its ID), for every
 * command, in the foreground too. Only one that still runs when its
 * session's turn ends outlives the turn: that one is reported, once.
 */
describe("the commands that outlive their turn", () => {
  test("those of the session that still run when its turn ends, once; one that ended in the turn is none", () => {
    const shells = new Shells()
    shells.created("sh_fg", "ses_a")
    shells.exited("sh_fg")
    shells.created("sh_bg", "ses_a")
    shells.created("sh_other", "ses_b")
    expect(shells.take("ses_a")).toEqual(["sh_bg"])
    // reported: not again at the next turn's end, though it still runs
    expect(shells.take("ses_a")).toEqual([])
    expect(shells.take("ses_b")).toEqual(["sh_other"])
    // an end that was never seen started (the plugin was loaded later)
    shells.exited("sh_unknown")
    expect(shells.size).toBe(0)
  })

  test("a deleted session's are forgotten; a lost event stream forgets all; at most 500 are kept", () => {
    const shells = new Shells()
    shells.created("sh_1", "ses_a")
    shells.created("sh_2", "ses_b")
    shells.forget("ses_a")
    expect(shells.take("ses_a")).toEqual([])
    shells.clear()
    expect(shells.take("ses_b")).toEqual([])
    for (let i = 0; i < 600; i++) shells.created(`sh_${i}`, "ses_c")
    expect(shells.size).toBe(500)
    expect(shells.take("ses_c")[0]).toBe("sh_100")
    // what is no ID or no session is not kept
    shells.created("", "ses_a")
    shells.created("sh_x", "")
    shells.created(7 as any, "ses_a")
    expect(shells.size).toBe(0)
  })
})
