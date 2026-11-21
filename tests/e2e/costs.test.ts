/*
 * Tier 0e end to end, with real OpenCode sessions and the fake model's
 * usage: each step's cost reaches the agent's day; a daily cap pauses the
 * agent after the turn that passed it; a session whose context passed
 * compact_at is told first (tier 0g: "[autocode] compaction next" reaches the
 * model as a prompt of its own), then compacted (OpenCode's own compaction)
 * when that turn ends, before the next wake; the owner's view of its spend
 * and context (GET /v1/costs).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  admin,
  agentStatus,
  callTool,
  readySession,
} from "../helpers/autocode.ts"
import { nodes } from "../helpers/env.ts"
import { FakeModel } from "../helpers/fake.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { until } from "../helpers/wait.ts"

const run = crypto.randomUUID().slice(0, 6)
const node = nodes.at(-1)!
let oc: OpenCode
let session: string
const id = `e2e:${run}:cost`
const enc = encodeURIComponent

const agent = async () => (await admin("GET", `/v1/agents/${enc(id)}`)).agent

beforeAll(async () => {
  await admin("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
  oc = new OpenCode(node)
  session = (await readySession(oc)).id
  await callTool(oc, session, "autocode_me", { action: "register", id })
})

afterAll(async () => {
  await admin("DELETE", `/v1/agents/${enc(id)}`).catch(() => {})
  await admin("PATCH", "/v1/settings", {
    server: { min_interval: null },
    agents: { [id]: null },
  })
})

/*
 * The owner, 2026-11-10: "verify that when agents use opencode subagents (not
 * jobs), the cost is accounted for". A Subagent's steps (OpenCode's own
 * subagent tool, its own child session) count for the agent: its spend today
 * and in total, once each; no row of its own; its context is not the agent's.
 */
describe("a Subagent's cost", () => {
  // a session and agent of its own: the other tests' context and steps stay
  test("a Subagent's steps count for the agent, once each; it has no row of its own", async () => {
    const own = await readySession(oc)
    const sub = `e2e:${run}:subcost`
    await callTool(oc, own.id, "autocode_me", { action: "register", id: sub })
    try {
      const marker = `SUBCOST-${run}`
      const fake = new FakeModel(node)
      const before = (await admin("GET", `/v1/costs/${enc(sub)}`)).cost
      // the fake model's price: input $1, output $2 per million tokens; five
      // scripted steps (the parent's call and its "launched", the Subagent's
      // two, the parent's last), whichever session takes each
      /*
       * OpenCode 2.3 runs a Subagent in the background: the tool returns at
       * once ("The subagent is working in the background"), the agent's turn
       * ends, and the Subagent's result comes to it later as a message
       * (<subagent sessionID="..." state="completed" ...>), a turn of its own.
       * OpenCode sends the Subagent's requests with its top-level session's
       * header, so the steps go by their text (the fake model takes, for each
       * request, the first step whose text it holds, in this order): the
       * agent's last request alone holds the Subagent's result; its second
       * the tool's answer; the Subagent's hold its prompt; the agent's first
       * holds the user prompt. Small prompts (a big one starts OpenCode's own
       * compaction).
       */
      await fake.script(
        [
          {
            match: "<subagent sessionID",
            usage: { prompt_tokens: 1_000, completion_tokens: 12_000 },
            reply: "parent done",
          },
          {
            match: "is working in the background",
            usage: { prompt_tokens: 1_000, completion_tokens: 5_000 },
            reply: "launched",
          },
          {
            match: `${marker} child work`,
            usage: { prompt_tokens: 1_000, completion_tokens: 150_000 },
            tool_calls: [
              {
                name: "shell",
                arguments: { command: "echo child", description: "say" },
              },
            ],
          },
          {
            match: `${marker} child work`,
            usage: { prompt_tokens: 1_000, completion_tokens: 175_000 },
            reply: "child done",
          },
          {
            match: `use a subagent ${run}`,
            usage: { prompt_tokens: 1_000, completion_tokens: 10_000 },
            tool_calls: [
              {
                name: "subagent",
                arguments: {
                  agent: "general",
                  description: "costly child",
                  prompt: `${marker} child work`,
                },
              },
            ],
          },
        ],
        true,
      )
      await oc.run(own.id, `use a subagent ${run}`, 120_000)
      // the Subagent ran in a session of its own, in the background: its
      // result, which names it, reaches the agent in a later turn
      const texts = async () =>
        (await fake.requests()).flatMap((r: any) =>
          (r.messages as any[]).map((m) =>
            typeof m?.content === "string"
              ? m.content
              : JSON.stringify(m?.content ?? ""),
          ),
        )
      const tag = await until(
        async () =>
          (await texts())
            .map((t) =>
              /<subagent sessionID=\\?"([^"\\]+)\\?" state=\\?"completed\\?"/.exec(
                t,
              ),
            )
            .find(Boolean),
        {
          timeoutMs: 60_000,
          intervalMs: 300,
          what: "the Subagent's result in the agent's session",
        },
      )
      const child = tag![1]!
      expect(child).not.toBe(own.id)
      // its shell ran: it took its own scripted steps
      expect(await texts()).toContain("child\n")
      // the steps' cost ($1 a million input, $2 a million output): the
      // agent's $0.021, $0.011 and $0.025, the Subagent's $0.301 and $0.351
      const expected = 0.021 + 0.011 + 0.301 + 0.351 + 0.025
      const after = await until(
        async () => {
          const c = (await admin("GET", `/v1/costs/${enc(sub)}`)).cost
          return c.total_usd - before.total_usd >= expected - 1e-6
            ? c
            : undefined
        },
        {
          timeoutMs: 60_000,
          intervalMs: 500,
          what: `the Subagent's cost (served: ${JSON.stringify(
            (await fake.requests())
              .filter((r: any) => JSON.stringify(r.messages).includes(marker))
              .map((r: any) => ({
                s: r.session === own.id ? "agent" : r.session,
                step: r.step,
                kind: r.kind,
              })),
          )})`,
        },
      )
      // each step once (a session title's request costs a little more)
      expect(after.total_usd - before.total_usd).toBeLessThan(expected + 0.01)
      expect(after.today_usd - before.today_usd).toBeCloseTo(
        after.total_usd - before.total_usd,
        6,
      )
      // no row of the Subagent's own session
      const rows = (await admin("GET", "/v1/costs")).agents.map(
        (a: any) => a.agent,
      )
      expect(rows).not.toContain(child)
    } finally {
      await admin("DELETE", `/v1/agents/${enc(sub)}`).catch(() => {})
    }
  }, 180_000)
})

/*
 * 1.1.0-rc2 (the owner, 2026-11-20, on being told that a wake's cost left
 * out the turns that OpenCode's own notices start: "can we fix that?"). On
 * real OpenCode: a fired wake's turn starts a Subagent and ends; the
 * Subagent's result starts a second turn by itself (OpenCode's own notice,
 * no prompt of Autocode's). Both turns are the wake's, with every step's
 * dollars: the plugin said what started the second turn.
 */
describe("a wake's cost with a turn that OpenCode's own notice starts", () => {
  test("the turn a Subagent's result starts is the wake's too: two turns, every step's dollars", async () => {
    const own = await readySession(oc)
    const sub = `e2e:${run}:notice`
    await callTool(oc, own.id, "autocode_me", { action: "register", id: sub })
    try {
      const marker = `NOTICE-${run}`
      const fake = new FakeModel(node)
      // the same five scripted steps as above (the agent's call, its
      // "launched", the Subagent's two, the agent's last), by their text
      await fake.script(
        [
          {
            match: "<subagent sessionID",
            usage: { prompt_tokens: 1_000, completion_tokens: 12_000 },
            reply: "parent done",
          },
          {
            match: "is working in the background",
            usage: { prompt_tokens: 1_000, completion_tokens: 5_000 },
            reply: "launched",
          },
          {
            match: `${marker} child work`,
            usage: { prompt_tokens: 1_000, completion_tokens: 150_000 },
            tool_calls: [
              {
                name: "shell",
                arguments: { command: "echo child", description: "say" },
              },
            ],
          },
          {
            match: `${marker} child work`,
            usage: { prompt_tokens: 1_000, completion_tokens: 175_000 },
            reply: "child done",
          },
          {
            match: `wake work ${marker}`,
            usage: { prompt_tokens: 1_000, completion_tokens: 10_000 },
            tool_calls: [
              {
                name: "subagent",
                arguments: {
                  agent: "general",
                  description: "costly child",
                  prompt: `${marker} child work`,
                },
              },
            ],
          },
        ],
        true,
      )
      // the wake: its prompt starts the first turn
      await admin("PUT", `/v1/agents/${enc(sub)}/wakes/pass`, {
        text: `wake work ${marker}`,
        trigger: "fire-only",
      })
      const week = async () =>
        (await admin("GET", "/v1/wakes")).wakes.find(
          (w: any) => w.agent === sub && w.name === "pass",
        )?.week
      expect(await week()).toEqual({ due: 0, skipped: 0, turns: 0, usd: 0 })
      await admin("POST", `/v1/agents/${enc(sub)}/wakes/pass/fire`)
      // the agent's $0.021 and $0.011, the Subagent's $0.301 and $0.351 in
      // the background, then, in the turn its result starts, $0.025
      const expected = 0.021 + 0.011 + 0.301 + 0.351 + 0.025
      const after = await until(
        async () => {
          const k = await week()
          return k && k.usd >= expected - 1e-6 ? k : undefined
        },
        {
          timeoutMs: 120_000,
          intervalMs: 500,
          what: `the wake's two turns and their cost (now: ${JSON.stringify(
            await week(),
          )})`,
        },
      )
      // two turns: the wake's own, and the one the Subagent's result
      // started; a session title's request costs a little more
      expect(after.turns).toBe(2)
      expect(after.usd).toBeLessThan(expected + 0.01)
      expect(after.due).toBe(0)
    } finally {
      await admin("DELETE", `/v1/agents/${enc(sub)}`).catch(() => {})
    }
  }, 240_000)
})

/*
 * 1.1.0-rc2, exact attribution (the owner, 2026-11-21: "ok, lets build
 * it!", after a measurement: over a week, $527 of $1,806 wake dollars on one
 * machine were filed under another wake than the one that began the work).
 * On real OpenCode: one wake's turn starts a Subagent that works for 20
 * seconds; another wake's turn runs meanwhile. The Subagent's later step and
 * the turn its result starts are the first wake's, not the second's: the
 * plugin reported the Subagent as that turn's work, said which session each
 * step ran in, and named the Subagent in the notice's turn.
 */
describe("a wake's cost when another wake's turn runs before its Subagent is done", () => {
  test("the Subagent's later step and its result's turn count for the wake that started it", async () => {
    const own = await readySession(oc)
    const sub = `e2e:${run}:tags`
    await callTool(oc, own.id, "autocode_me", { action: "register", id: sub })
    try {
      const marker = `TAGS-${run}`
      const fake = new FakeModel(node)
      // by their text, in this order (a request takes the first step whose
      // text it holds; each step is taken once): the result's turn, the
      // "launched" step, the other wake's turn, the Subagent's two steps
      // (its command sleeps 20 s), the first wake's call
      await fake.script(
        [
          {
            match: "<subagent sessionID",
            usage: { prompt_tokens: 1_000, completion_tokens: 12_000 },
            reply: "parent done",
          },
          {
            match: "is working in the background",
            usage: { prompt_tokens: 1_000, completion_tokens: 5_000 },
            reply: "launched",
          },
          {
            match: `other work ${marker}`,
            usage: { prompt_tokens: 1_000, completion_tokens: 3_000 },
            reply: "other done",
          },
          {
            match: `${marker} child work`,
            usage: { prompt_tokens: 1_000, completion_tokens: 150_000 },
            tool_calls: [
              {
                name: "shell",
                arguments: {
                  command: "sleep 20; echo child",
                  description: "work a while",
                },
              },
            ],
          },
          {
            match: `${marker} child work`,
            usage: { prompt_tokens: 1_000, completion_tokens: 175_000 },
            reply: "child done",
          },
          {
            match: `wake work ${marker}`,
            usage: { prompt_tokens: 1_000, completion_tokens: 10_000 },
            tool_calls: [
              {
                name: "subagent",
                arguments: {
                  agent: "general",
                  description: "long child",
                  prompt: `${marker} child work`,
                },
              },
            ],
          },
        ],
        true,
      )
      for (const [name, text] of [
        ["pass", `wake work ${marker}`],
        ["other", `other work ${marker}`],
      ])
        await admin("PUT", `/v1/agents/${enc(sub)}/wakes/${name}`, {
          text,
          trigger: "fire-only",
        })
      const week = async (name: string) =>
        (await admin("GET", "/v1/wakes")).wakes.find(
          (w: any) => w.agent === sub && w.name === name,
        )?.week
      const reached = (name: string, usd: number, what: string) =>
        until(
          async () => {
            const k = await week(name)
            return k && k.usd >= usd - 1e-6 ? k : undefined
          },
          { timeoutMs: 120_000, intervalMs: 300, what },
        )
      // the first wake: its call ($0.021), "launched" ($0.011), and the
      // Subagent's first step ($0.301), whose command then sleeps
      await admin("POST", `/v1/agents/${enc(sub)}/wakes/pass/fire`)
      await reached("pass", 0.021 + 0.011 + 0.301, "the first wake's turn")
      // the other wake's turn runs while the Subagent still works: $0.007
      await admin("POST", `/v1/agents/${enc(sub)}/wakes/other/fire`)
      await reached("other", 0.007, "the other wake's turn")
      // the Subagent's last step ($0.351) and the turn its result starts
      // ($0.025) are the first wake's
      const expected = 0.021 + 0.011 + 0.301 + 0.351 + 0.025
      const pass = await reached("pass", expected, "the Subagent's end")
      expect(pass.turns).toBe(2)
      expect(pass.usd).toBeLessThan(expected + 0.01)
      // the other wake has its own turn only (a session title's request
      // costs a little more)
      const other = await week("other")
      expect(other.turns).toBe(1)
      expect(other.usd).toBeLessThan(0.007 + 0.01)
    } finally {
      await admin("DELETE", `/v1/agents/${enc(sub)}`).catch(() => {})
    }
  }, 240_000)
})

/*
 * The owner, 2026-11-17: "add col in agents tab for model effort": an agent's
 * effort is its session's model variant, as OpenCode keeps it; an agent
 * whose session has none shows none.
 */
describe("an agent's model effort", () => {
  test("a session's model variant is its agent's effort; none without one", async () => {
    await oc.loadLocation()
    const own = await oc.createSession({
      model: { providerID: "fake", id: "main", variant: "high" },
    })
    const withEffort = `e2e:${run}:effort`
    try {
      // the turn that registers it ends with a step: it says the effort
      await callTool(oc, own.id, "autocode_me", {
        action: "register",
        id: withEffort,
      })
      const seen = await until(
        async () => {
          const a = (await admin("GET", `/v1/agents/${enc(withEffort)}`)).agent
          return a.model ? a : undefined
        },
        { timeoutMs: 30_000, what: "the agent's model and effort" },
      )
      expect(seen.model).toBe("fake/main")
      // its name in OpenCode's model list (the owner, 2026-11-17: "why it
      // doesnt say fable 5.2")
      expect(seen.model_name).toBe("Fake main")
      expect(seen.effort).toBe("high")
      // the suite's agent: OpenCode's default model, no variant
      expect((await agent()).effort).toBe(null)
    } finally {
      await admin("DELETE", `/v1/agents/${enc(withEffort)}`).catch(() => {})
    }
  })
})

describe("costs and compaction", () => {
  test("steps' costs add up; the cap pauses after the turn that passes it", async () => {
    // no compaction notice into this turn (past compact_at, it would come at
    // once since 2026-11-09, and its step is the context then)
    await admin("PATCH", "/v1/settings", {
      agents: { [id]: { compact_at: "off" } },
    })
    const fake = new FakeModel(node)
    // the fake model's price: input $1, output $2 per million tokens
    await fake.script(
      [
        {
          session,
          reply: "a costly answer",
          usage: { prompt_tokens: 400_000, completion_tokens: 100_000 },
        },
      ],
      true,
    )
    await oc.run(session, "spend", 90_000)
    const cost = await until(
      async () => {
        const c = (await agent()).cost
        return c.today_usd > 0 ? c : undefined
      },
      { timeoutMs: 30_000, what: "the cost to arrive" },
    )
    expect(cost.today_usd).toBeGreaterThan(0.5)
    expect(cost.context).toBeGreaterThan(300_000)
    expect(cost.context_limit).toBe(200_000)
    await admin("PATCH", "/v1/settings", {
      agents: { [id]: { daily_usd: 0.5, compact_at: "off" } },
    })
    await fake.script([{ session, reply: "one more" }], true)
    await oc.run(session, "one more turn", 90_000)
    await until(async () => (await agent()).paused === "cap", {
      timeoutMs: 30_000,
      what: "the cap's pause",
    })
    const alert = (await admin("GET", "/v1/inbox")).items.find(
      (i: any) => i.kind === "alert" && i.agent === id,
    )
    expect(alert.title).toContain("reached its daily cap")
    await admin("PATCH", "/v1/settings", {
      agents: { [id]: { daily_usd: null } },
    })
    await until(async () => (await agent()).paused === "", {
      timeoutMs: 30_000,
      what: "the pause lifted",
    })
    await admin("POST", `/v1/inbox/${alert.id}/close`)
  }, 240_000)

  test("past compact_at, the session is told first, then compacted after that turn, before the next wake", async () => {
    await admin("PATCH", "/v1/settings", {
      agents: { [id]: { compact_at: "10%" } },
    })
    const fake = new FakeModel(node)
    await fake.script(
      [
        {
          session,
          reply: "a long context",
          usage: { prompt_tokens: 50_000, completion_tokens: 100 },
        },
        // the notice's turn: the agent writes down its state; the context
        // only grows (a smaller one would mean OpenCode compacted on its own)
        {
          session,
          match: "[autocode] compaction next",
          reply: "Notes written; ready for the compaction.",
          usage: { prompt_tokens: 51_000, completion_tokens: 100 },
        },
      ],
      true,
    )
    await oc.run(session, "grow", 90_000)
    await admin("PUT", `/v1/agents/${enc(id)}/wakes/tick`, {
      text: "Tick after compaction.",
      trigger: "fire-only",
    })
    await admin("POST", `/v1/agents/${enc(id)}/wakes/tick/fire`)
    const compacted = await until(
      async () =>
        (
          await admin(
            "GET",
            `/v1/history?kind=session.compacted&agent=${enc(id)}`,
          )
        ).history[0],
      { timeoutMs: 60_000, what: "the compaction" },
    )
    expect(compacted.data.limit).toBe(20_000)
    // the notice reached the model first, in a turn of its own
    const asked = await fake.requests()
    const notice = asked.findIndex(
      (r: any) =>
        r.session === session &&
        r.kind === "primary" &&
        JSON.stringify(r.messages).includes("[autocode] compaction next"),
    )
    expect(notice).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(asked[notice]!.messages)).not.toContain(
      "Tick after compaction.",
    )
    const kind = "session.compact.noticed"
    const noticed = (
      await admin("GET", `/v1/history?kind=${kind}&agent=${enc(id)}`)
    ).history[0]
    expect(Date.parse(noticed.at)).toBeLessThanOrEqual(Date.parse(compacted.at))
    // OpenCode's compaction request reached the model, then the wake did
    await until(
      async () =>
        (await fake.requests()).some(
          (r: any) =>
            r.session === session &&
            r.kind !== "title" &&
            JSON.stringify(r.messages).includes("Tick after compaction."),
        ),
      { timeoutMs: 90_000, intervalMs: 1000, what: "the wake after it" },
    )
    await agentStatus(id, "idle", 60_000)
    // the owner's view: its spend and context (tier 0g)
    const view = (await admin("GET", `/v1/costs/${enc(id)}`)).cost
    expect(view.total_usd).toBeGreaterThan(0)
    expect(view.compact_at).toBe(20_000)
  }, 240_000)
})
