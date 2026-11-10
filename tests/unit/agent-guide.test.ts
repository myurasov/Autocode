/*
 * What agents are told (tier 0b2): the tools' descriptions name every action
 * and trigger and say to use the tools; status, set, list and show say when
 * things happen, in the server's zone and relative to now; help returns the
 * guide or a part of it; the guide answers how wakes, checks, delivery,
 * messages and scripts work exactly; the line for registered sessions points
 * to the tools.
 */
import { describe, expect, test } from "bun:test"
import {
  agentLine,
  guideText,
  helpText,
  TOPICS,
} from "../../packages/plugin/src/guide.ts"
import {
  APPROVAL_TOOL,
  ME_TOOL,
  MESSAGE_TOOL,
  runMe,
  runMessage,
  runWake,
  TOOLS,
  WAKE_TOOL,
} from "../../packages/plugin/src/tools.ts"

const FACTS = {
  serverId: "api-test",
  url: "http://server:4848",
  shellValues: true,
  tools: TOOLS,
}

// 12:00 UTC is 05:00 PDT
const ME = {
  registered: true,
  session: "ses_a",
  agent: {
    id: "team:a",
    description: "Lead",
    status: "idle",
    paused: "",
    machine: "m1",
  },
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
  next: null,
  due: null,
  set_by: "team:a",
  created_at: "2026-10-28T12:00:00.000Z",
  updated_at: "2026-10-28T12:00:00.000Z",
  last_fired_at: null,
  check_failures: 0,
  ...over,
})

// A fake server: answers by "METHOD path", and records the calls.
function server(answers: Record<string, unknown>) {
  const calls: string[] = []
  const call = async (method: string, path: string) => {
    const key = `${method} ${path.split("?")[0]}`
    calls.push(key)
    if (!(key in answers)) throw new Error(`unexpected ${key}`)
    return answers[key]
  }
  return { call, calls }
}

describe("the tools' descriptions", () => {
  test("say to use the tools, name every action, and every trigger", () => {
    expect(ME_TOOL.description).toContain("not the autocode CLI")
    // as a word: "set" in "settings" or "run" in "running" is not it (the
    // review of 0b2)
    for (const tool of TOOLS) {
      const actions = (tool.input.properties.action as any).enum as string[]
      for (const action of actions)
        expect(tool.description, `${tool.name} ${action}`).toMatch(
          new RegExp(`\\b${action}\\b`),
        )
    }
    for (const trigger of [
      "every 30m",
      "in 45m",
      "at 09:00",
      "cron",
      "idle 30m",
      "repeat",
      "fire-only",
    ])
      expect(WAKE_TOOL.description).toContain(trigger)
    expect(WAKE_TOOL.description).toContain("only while the session is idle")
    // how a job of yours wakes you (Haiku 5.5 and GLM 5.3 missed it,
    // 2026-11-03)
    expect(WAKE_TOOL.description).toContain(
      "a job you start fires it by ending with: autocode fire me NAME",
    )
    expect(MESSAGE_TOOL.description).toContain("owner")
  })

  test("every parameter says what it is for", () => {
    for (const tool of TOOLS)
      for (const [name, prop] of Object.entries(tool.input.properties))
        if (name !== "action")
          expect((prop as any).description, `${tool.name}.${name}`).toBeTruthy()
    const trigger = (WAKE_TOOL.input.properties as any).trigger.description
    expect(trigger).toContain("in 45m")
    // the owner, 2026-11-07: no end date, no files
    expect(WAKE_TOOL.input.properties).not.toHaveProperty("end")
    expect(WAKE_TOOL.description).not.toContain("check, end")
    expect(MESSAGE_TOOL.input.properties).not.toHaveProperty("file")
    expect(MESSAGE_TOOL.input.properties).not.toHaveProperty("path")
  })

  // The owner, 2026-11-09: list, read and wait back; messages steer into a
  // running turn.
  test("autocode_message: send, list, read, wait, answer and escalate", () => {
    expect((MESSAGE_TOOL.input.properties.action as any).enum).toEqual([
      "send",
      "list",
      "read",
      "wait",
      "answer",
      "escalate",
    ])
    for (const key of ["id", "from", "reply_to", "seconds"])
      expect(MESSAGE_TOOL.input.properties).toHaveProperty(key)
    expect(MESSAGE_TOOL.description).toContain(
      "Messages to you come whole, in your turn's next step while it runs",
    )
    expect(MESSAGE_TOOL.description).toContain("list (")
    expect(MESSAGE_TOOL.description).toContain("read (")
    expect(MESSAGE_TOOL.description).toContain("wait (")
  })
})

describe("autocode_message list, read and wait", () => {
  const MSG = {
    id: "m_1",
    from: "team:b",
    to: "team:a",
    subject: "plot",
    reply_to: "m_0",
    size: 6,
    state: "queued",
  }
  test("list: one line each, or none; filters go to the server", async () => {
    const calls: string[] = []
    const call = async (method: string, path: string) => {
      calls.push(`${method} ${path}`)
      return { messages: path.includes("from=") ? [] : [MSG] }
    }
    expect(await runMessage({ action: "list" }, call)).toBe(
      'Waiting: m_1 from agent team:b, subject "plot", in reply to m_0, ' +
        "6 characters. Read it with autocode_message read.",
    )
    expect(await runMessage({ action: "list", from: "team:c" }, call)).toBe(
      "No messages wait for you.",
    )
    expect(calls).toEqual([
      "GET /v1/me/messages",
      "GET /v1/me/messages?from=team%3Ac",
    ])
  })

  test("read: each whole, quoted, with what is left; none", async () => {
    const bodies: unknown[] = []
    const answers = [
      {
        messages: [
          { ...MSG, text: "see it\nthere", state: "read" },
          { ...MSG, id: "m_2", from: "autocode", subject: "lock", text: "x" },
        ],
        left: 1,
      },
      { messages: [], left: 0 },
    ]
    const call = async (_m: string, _p: string, body?: unknown) => {
      bodies.push(body)
      return answers.shift()
    }
    expect(await runMessage({ action: "read", reply_to: "m_0" }, call)).toBe(
      [
        'Message m_1 from agent team:b, subject "plot", in reply to m_0:',
        "> see it",
        "> there",
        "",
        'Message m_2 from Autocode, subject "lock", in reply to m_0:',
        "> x",
        "",
        "1 more waits: read again.",
      ].join("\n"),
    )
    expect(await runMessage({ action: "read", id: "m_9" }, call)).toBe(
      "No messages wait for you.",
    )
    expect(bodies).toEqual([{ reply_to: "m_0" }, { id: "m_9" }])
  })

  test("wait: holds the call; nothing within its seconds says so", async () => {
    const seen: number[] = []
    const wait = async (body: Record<string, unknown>) => {
      seen.push(Number(body.wait))
      return { messages: [] as any[], left: 0 }
    }
    const call = async () => {
      throw new Error("wait goes through its own loop")
    }
    expect(
      await runMessage(
        { action: "wait", seconds: 30, from: "team:b" },
        call,
        wait,
      ),
    ).toBe(
      "No message came within 30 seconds; one that comes later is in your " +
        "next prompt or turn.",
    )
    // the default, and the bounds
    await runMessage({ action: "wait" }, call, wait)
    await runMessage({ action: "wait", seconds: 99_999 }, call, wait)
    expect(seen).toEqual([30, 300, 3600])
  })
})

describe("autocode_me", () => {
  test("status: registration, server time and zone, delivery, wakes, messages waiting", async () => {
    const { call } = server({
      "GET /v1/me": {
        ...ME,
        wakes: {
          count: 2,
          next: { name: "sooner", due: "2026-10-28T12:30:00.000Z" },
        },
        waiting: 1,
      },
    })
    expect(await runMe({ action: "status" }, call)).toBe(
      [
        "Registered as team:a: Lead.",
        "Status idle on machine m1.",
        "Server api-test; its time 2026-10-28 05:00 PDT (America/Los_Angeles).",
        "Delivery: only while this session is idle, at most once per 1m; " +
          "messages come whole, into a running turn at its next step.",
        'Wakes: 2; next "sooner" at 2026-10-28 05:30 PDT (in 30m). ' +
          "See autocode_wake list.",
        "Messages waiting: 1. See autocode_message list or read.",
        "How Autocode works: autocode_me action=help.",
      ].join("\n"),
    )
  })

  test("status: paused, none, and not registered", async () => {
    const paused = server({
      "GET /v1/me": {
        ...ME,
        agent: { ...ME.agent, status: "paused", paused: "stop-all" },
      },
    })
    const text = await runMe({ action: "status" }, paused.call)
    expect(text).toContain(
      "Status paused by Stop All: nothing is delivered until the owner " +
        "resumes you.",
    )
    expect(text).toContain("Wakes: none.")
    expect(text).toContain("Messages waiting: none.")
    const loose = server({
      "GET /v1/me": {
        registered: false,
        session: "ses_x",
        server: ME.server,
        settings: ME.settings,
      },
    })
    expect(await runMe({ action: "status" }, loose.call)).toBe(
      [
        "Not registered. Register with action=register and an id like " +
          "project:role:name.",
        "Server api-test; its time 2026-10-28 05:00 PDT (America/Los_Angeles).",
        "How Autocode works: autocode_me action=help.",
      ].join("\n"),
    )
  })

  // Tier 0b3: a failed turn, and Autocode's retries.
  test("status: an error, retried, not retried, or retries run out", async () => {
    const failing = (error: Record<string, unknown>, attempts = 0) =>
      server({
        "GET /v1/me": {
          ...ME,
          agent: { ...ME.agent, status: "error", error },
          settings: {
            ...ME.settings,
            retry_interval: "1m",
            retry_attempts: attempts,
          },
        },
      }).call
    const since = "2026-10-28T11:50:00.000Z"
    const at = "2026-10-28T11:58:00.000Z"
    const retried = await runMe(
      { action: "status" },
      failing({
        type: "provider.internal",
        since,
        at,
        retries: 3,
        next_retry: "2026-10-28T12:01:00.000Z",
        retryable: true,
      }),
    )
    expect(retried).toContain(
      "Status error: your last turn failed (provider.internal) at " +
        "2026-10-28 04:58 PDT, failing since 2026-10-28 04:50 PDT. " +
        "Autocode sends a retry prompt every 1m (3 sent, no limit); the " +
        "next at 2026-10-28 05:01 PDT (in 1m). Your wakes and messages " +
        "come with it.",
    )
    const auth = await runMe(
      { action: "status" },
      failing({
        type: "provider.auth",
        since: at,
        at,
        retries: 0,
        next_retry: null,
        retryable: false,
      }),
    )
    expect(auth).toContain(
      "Status error: your last turn failed (provider.auth) at " +
        "2026-10-28 04:58 PDT. It is not retried (the owner is told); your " +
        "wakes and messages wait until a turn succeeds.",
    )
    const out = await runMe(
      { action: "status" },
      failing(
        {
          type: "provider.internal",
          since,
          at,
          retries: 5,
          next_retry: null,
          retryable: true,
        },
        5,
      ),
    )
    expect(out).toContain(
      "Autocode stopped after 5 retries (the owner is told); your wakes " +
        "and messages wait until a turn succeeds.",
    )
  })

  test("help: the whole guide, one topic, or the topics there are", async () => {
    const { call } = server({})
    const guide = (topic?: string) => helpText(FACTS, topic)
    expect(await runMe({ action: "help" }, call, { guide })).toBe(
      guideText(FACTS),
    )
    const wakes = await runMe({ action: "help", topic: "wakes" }, call, {
      guide,
    })
    expect(wakes).toStartWith("## Wakes")
    expect(wakes).not.toContain("## Messages")
    const unknown = await runMe({ action: "help", topic: "nope" }, call, {
      guide,
    })
    expect(unknown).toContain(`Topics: ${TOPICS.join(", ")}`)
  })
})

describe("autocode_wake", () => {
  test("set says when a timed wake runs, in the server's zone and from now", async () => {
    const { call } = server({
      "GET /v1/me": ME,
      "PUT /v1/me/wakes/tick": {
        wake: wake({
          name: "tick",
          next: "2026-10-28T12:30:00.000Z",
          due: "2026-10-28T12:30:00.000Z",
          check: "./has-work.sh",
        }),
      },
    })
    expect(
      await runWake(
        {
          action: "set",
          name: "tick",
          trigger: "every 30m",
          text: "Go.",
          check: "./has-work.sh",
        },
        call,
      ),
    ).toBe(
      'Wake "tick" set: every 30m. Next run 2026-10-28 05:30 PDT (in 30m). ' +
        "Before each run its check runs in your folder: exit 0 wakes you " +
        "with its output, exit 1 skips that run. Delivered only while your " +
        "session is idle, at most once per 1m.",
    )
  })

  test("set explains idle, one-time and fire-only wakes", async () => {
    const answers = (w: Record<string, unknown>, me = ME) =>
      server({ "GET /v1/me": me, "PUT /v1/me/wakes/w": { wake: wake(w) } })
    const working = { ...ME, agent: { ...ME.agent, status: "working" } }
    const idle = await runWake(
      { action: "set", name: "w", trigger: "idle 30m repeat", text: "x" },
      answers({ trigger: "idle 30m repeat" }, working).call,
    )
    expect(idle).toContain(
      "It falls due once your session has been idle 30m (counted from the " +
        "end of this turn), and again every 30m while you stay idle.",
    )
    const soon = await runWake(
      { action: "set", name: "w", trigger: "idle 30m", text: "x" },
      answers({ trigger: "idle 30m", due: "2026-10-28T12:30:00.000Z" }).call,
    )
    expect(soon).toContain(
      "It falls due once per idle stretch: if your session stays idle, at " +
        "2026-10-28 05:30 PDT (in 30m).",
    )
    const once = await runWake(
      { action: "set", name: "w", trigger: "in 45m", text: "x" },
      answers({
        trigger: "at 2026-10-28T12:45:00.000Z",
        next: "2026-10-28T12:45:00.000Z",
        due: "2026-10-28T12:45:00.000Z",
      }).call,
    )
    expect(once).toContain(
      "It runs once, at 2026-10-28 05:45 PDT (in 45m), then it is removed.",
    )
    // the review of 0b2: its trigger in the server's zone, not UTC
    expect(once).toStartWith('Wake "w" set: at 2026-10-28 05:45 PDT.')
    expect(once).not.toContain("T12:45:00.000Z")
    const fire = await runWake(
      { action: "set", name: "w", trigger: "fire-only", text: "x" },
      answers({ trigger: "fire-only" }).call,
    )
    expect(fire).toContain(
      "It runs only when fired: autocode_wake fire, or `autocode fire me w` " +
        "from a script.",
    )
  })

  test("list: the server's time, then each wake with when it falls due and the start of its text", async () => {
    const long = "word ".repeat(40)
    const { call } = server({
      "GET /v1/me": ME,
      "GET /v1/me/wakes": {
        wakes: [
          wake({
            name: "tick",
            next: "2026-10-28T12:30:00.000Z",
            due: "2026-10-28T12:30:00.000Z",
            check: "./has-work.sh",
            last_fired_at: "2026-10-28T11:30:00.000Z",
          }),
          wake({
            name: "nudge",
            trigger: "idle 2h repeat",
            due: "2026-10-28T14:00:00.000Z",
            text: long,
          }),
          wake({ name: "go", trigger: "fire-only", set_by: "owner" }),
        ],
      },
    })
    const text = await runWake({ action: "list" }, call)
    expect(text.split("\n")).toEqual([
      "Server time 2026-10-28 05:00 PDT (America/Los_Angeles).",
      "tick: every 30m; next 2026-10-28 05:30 PDT (in 30m); " +
        "check: ./has-work.sh; last set 2026-10-28 05:00 PDT; " +
        "last ran 2026-10-28 04:30 PDT",
      "  Go.",
      "nudge: idle 2h repeat; due 2026-10-28 07:00 PDT (in 2h) " +
        "if you stay idle; last set 2026-10-28 05:00 PDT",
      `  ${long.slice(0, 100)}…`,
      "go: fire-only; runs only when fired; " +
        "last set 2026-10-28 05:00 PDT by the owner",
      "  Go.",
    ])
  })

  test("show: one wake whole", async () => {
    const { call } = server({
      "GET /v1/me": ME,
      "GET /v1/me/wakes": {
        wakes: [
          wake({
            name: "tick",
            text: "Line one.\nLine two.",
            next: "2026-10-28T12:30:00.000Z",
            due: "2026-10-28T12:30:00.000Z",
          }),
        ],
      },
    })
    expect(await runWake({ action: "show", name: "tick" }, call)).toBe(
      [
        'Wake "tick", set by you at 2026-10-28 05:00 PDT.',
        "Trigger: every 30m; next 2026-10-28 05:30 PDT (in 30m).",
        "Check: none.",
        "Last ran: never.",
        "Text:",
        "Line one.",
        "Line two.",
      ].join("\n"),
    )
    expect(await runWake({ action: "show", name: "nope" }, call)).toBe(
      'error: you have no wake "nope" (autocode_wake list shows them)',
    )
  })
})

describe("the guide", () => {
  // markdown wraps its lines anywhere: compare with whitespace collapsed
  const flat = (text: string) => text.replace(/\s+/g, " ")
  const guide = flat(guideText(FACTS))

  test("says to use the tools, and what to do when unsure", () => {
    expect(guide).toContain("Use the `autocode_*` tools")
    expect(guide).toContain("the `autocode` CLI is for scripts")
    expect(guide).toContain("Never read the plugin's code")
  })

  // In the guide's own words, outside its Tools list (which holds the
  // descriptions word for word): each action as itself (`fire`, or
  // action=fire), not inside another word.
  test("names every action of every tool", () => {
    const own = flat(guideText(FACTS).replace(/## Tools\n[\s\S]*?\n## /, "## "))
    for (const tool of TOOLS)
      for (const action of (tool.input.properties.action as any).enum)
        expect(own, `${tool.name} ${action}`).toMatch(
          new RegExp(
            `\`${action}\`|action=${action}\\b|${tool.name} ${action}\\b`,
          ),
        )
  })

  // The questions an update-loop agent could not answer (2026-11-02).
  test("answers how idle wakes count, repeat after a skip, merging, and a check's environment", () => {
    for (const answer of [
      // when an idle wake falls due, and what resets it
      "any turn: yours, the owner's or an injected one",
      "never from before the wake was set",
      // repeat, and a skipped check
      "also when its check skipped that run",
      // merging, by name only (the owner, 2026-11-07)
      "runs of the same wake are merged",
      "Different wakes are never merged",
      // a check's environment
      "AUTOCODE_TOKEN",
      // a wake that falls due during a turn
      "right after the turn ends",
      // a loop spaced from the end of each run
      "`in 30m`",
      // a job that wakes you, in the wakes part itself
      "a background job you start can fire it as its last command",
      // time zones
      "the server's zone",
      // a failed turn (tier 0b3)
      "`[autocode] retry 2`",
      "`retry_interval`",
      "Continue where you left off",
      // why a wake did not come: the error state too
      "you are in the error state (`autocode_me status`)",
      // the owner, 2026-11-09: whole; into a running turn at its next step
      // (steer); list, read and wait; read once, never injected again
      "New messages come whole",
      "at its next step",
      "`autocode_message read` takes what waits now",
      "`wait` holds the call until a message comes",
      "what `read` or `wait` returned is never put into a prompt",
      "`from=` and `reply_to=`",
      "Autocode's own notices too",
    ])
      expect(guide).toContain(answer)
    for (const gone of [
      "`inline_limit`",
      "`list` shows your unread messages",
      "There is no reading or waiting",
    ])
      expect(guide, gone).not.toContain(gone)
  })

  // The owner, 2026-11-07: no files, no end dates, no lock waits, and the
  // shell's CLI is me, fire and send.
  test("says nothing of what was taken out", () => {
    for (const gone of [
      "file from",
      "base64",
      "path=",
      "--file",
      "`end`",
      "[--end",
      "the same name or the same text",
      "mode=wait",
      "autocode wakes",
      "autocode wake set",
      "autocode messages",
      "autocode locks",
    ])
      expect(guide, gone).not.toContain(gone)
    for (const kept of [
      "`autocode me`",
      "`autocode fire me NAME [--text TEXT]`",
      "`autocode send TO TEXT...`",
    ])
      expect(guide, kept).toContain(kept)
  })

  test("help topics are the guide's parts", () => {
    for (const topic of TOPICS)
      expect(helpText(FACTS, topic).length).toBeGreaterThan(100)
  })

  test("without shell values, scripts cannot act as the agent; checks still can", () => {
    const off = flat(guideText({ ...FACTS, shellValues: false }))
    expect(off).toContain("shells do not get Autocode values")
    expect(off).toContain("your checks still can")
  })
})

test("the line for registered sessions points to the tools and the guide", () => {
  expect(agentLine("team:a", "api-test")).toBe(
    "This session is Autocode agent `team:a` on server `api-test`. Use " +
      "the `autocode_*` tools (not the `autocode` CLI); `autocode_me " +
      "action=help` or the `autocode` skill explains exactly how wakes " +
      "and messages work. Write to the owner briefly: only what they " +
      "need, the point first, in plain words.",
  )
})

// The owner, 2026-11-09: "why messages/questions to owner are so long. i
// want those to be if possible short (no fixed len, but in general contain
// only necessary) and focused, structured, direct and use plain language."
describe("writing to the owner", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ")
  test("the guide says how: short, only what is needed, the point first, structured, direct, plain", () => {
    const guide = flat(guideText(FACTS))
    for (const part of [
      "## Writing to the Owner",
      "only what the owner needs",
      "no set length",
      "the point first",
      "a short list when there are several items",
      "plain words",
      "no background they did not ask for",
    ])
      expect(guide, part).toContain(part)
    // in the topics and their help
    expect(TOPICS as readonly string[]).toContain("owner")
    expect(flat(helpText(FACTS, "owner"))).toContain("the point first")
  })

  test("the tools that reach the owner say it where the text is written", () => {
    const send = (MESSAGE_TOOL.input.properties.text as any).description
    expect(send).toContain("to the owner: short, the point first")
    const ask = (APPROVAL_TOOL.input.properties.text as any).description
    expect(ask).toContain("what to approve, the point first")
    expect(APPROVAL_TOOL.description).toContain("Write it short and plain")
  })
})

// The adversarial review of 0b2 (2026-11-08).
describe("review of 0b2: the tools' texts", () => {
  test("send names the recipients a list skipped", async () => {
    const { call } = server({
      "POST /v1/messages": {
        recipients: ["team:b"],
        skipped: ["team:typo"],
        messages: [{ id: "m_1", to: "team:b" }],
      },
    })
    const text = await runMessage(
      { action: "send", to: "team:b,team:typo", text: "hi" },
      call,
    )
    expect(text).toBe(
      "Sent to team:b (m_1). Skipped (not registered): team:typo.",
    )
  })

  // An agent waiting on an approval, or paused, in its own turn: the
  // session is busy, so an idle wake has no due time yet and counts from the
  // end of this turn.
  test("list and set during a turn while waiting or paused: from the end of this turn", async () => {
    for (const status of ["waiting", "paused"]) {
      const me = { ...ME, agent: { ...ME.agent, status, busy: true } }
      const idle = wake({ name: "nudge", trigger: "idle 30m", due: null })
      const { call } = server({
        "GET /v1/me": me,
        "GET /v1/me/wakes": { wakes: [idle] },
        "PUT /v1/me/wakes/nudge": { wake: idle },
      })
      expect(await runWake({ action: "list" }, call), status).toContain(
        "due 30m after this turn ends",
      )
      expect(
        await runWake(
          { action: "set", name: "nudge", trigger: "idle 30m", text: "Go." },
          call,
        ),
        status,
      ).toContain("(counted from the end of this turn)")
    }
  })

  test("set says the wake is set when the status call after it fails", async () => {
    const answers: Record<string, unknown> = {
      "PUT /v1/me/wakes/w": { wake: wake({ next: null }) },
    }
    const call = async (method: string, path: string) => {
      const key = `${method} ${path.split("?")[0]}`
      if (key === "GET /v1/me") throw new Error("server busy")
      return answers[key]
    }
    expect(
      await runWake(
        { action: "set", name: "w", trigger: "every 30m", text: "Go." },
        call,
      ),
    ).toStartWith('Wake "w" set: every 30m.')
  })

  test("the check's time limit is the owner's check_timeout, 60 s by default", () => {
    const check = (WAKE_TOOL.input as any).properties.check
      .description as string
    expect(check).toContain("check_timeout, 60 s by default")
    expect(check).not.toContain("; 60 s limit")
  })
})
