/*
 * Tier 0b end to end, on every machine of the topology: wakes reach real
 * sessions with the [autocode] header, fired or on a schedule; a check that
 * exits 1 skips its wake without a model call, and one that exits 0 puts its
 * output in the prompt; waiting wakes merge; messages go between agents on
 * different machines and to and from the owner; turn status follows real turns.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { admin, callTool, readySession } from "../helpers/autocode.ts"
import { nodes } from "../helpers/env.ts"
import { FakeModel } from "../helpers/fake.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { until } from "../helpers/wait.ts"

const run = crypto.randomUUID().slice(0, 6)
const agents: { node: string; oc: OpenCode; session: string; id: string }[] = []

// A message's text: a string, or the text of its parts.
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p: any) => p?.text ?? "").join("")
      : JSON.stringify(content ?? "")

// The user text of the session's model requests, oldest first.
async function prompts(node: string, session: string): Promise<string[]> {
  const out: string[] = []
  for (const r of await new FakeModel(node).requests()) {
    if (r.session !== session || r.kind !== "primary") continue
    const users = (r.messages as any[]).filter((m) => m?.role === "user")
    const last = users.at(-1)
    if (!last) continue
    out.push(textOf(last.content))
  }
  return out
}

async function promptWith(
  a: (typeof agents)[number],
  text: string,
  timeoutMs = 60_000,
) {
  return until(
    async () =>
      (await prompts(a.node, a.session)).find((p) => p.includes(text)),
    { timeoutMs, intervalMs: 500, what: `a prompt with ${text} on ${a.node}` },
  )
}

const wake = (a: (typeof agents)[number], args: Record<string, unknown>) =>
  callTool(a.oc, a.session, "autocode_wake", args)

beforeAll(async () => {
  await admin("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
  // two agents on every machine: on one machine they message each other, on
  // two the first of each machine messages the other machine's
  for (const node of nodes)
    for (const n of [1, 2]) {
      const oc = new OpenCode(node)
      const s = await readySession(oc)
      const id = `e2e:${run}:${node}:${n}`
      await callTool(oc, s.id, "autocode_me", { action: "register", id })
      agents.push({ node, oc, session: s.id, id })
    }
})

afterAll(async () => {
  await admin("PATCH", "/v1/settings", { server: { min_interval: null } })
})

describe("wakes on real sessions", () => {
  test("a fired wake arrives with the [autocode] header and the firer's text", async () => {
    for (const a of agents.filter((_, i) => i % 2 === 0)) {
      expect(
        await wake(a, {
          action: "set",
          name: "go",
          trigger: "fire-only",
          text: `Fired wake for ${a.id}.`,
        }),
      ).toContain('Wake "go" set: fire-only')
      await admin("POST", `/v1/agents/${a.id}/wakes/go/fire`, {
        text: "from the test",
      })
      const prompt = await promptWith(a, `Fired wake for ${a.id}.`)
      expect(prompt).toContain('[autocode] wake "go" fired by the owner')
      expect(prompt).toContain("Added by the owner:\n> from the test")
    }
  })

  test("a scheduled wake arrives on its own", async () => {
    const a = agents[1]!
    await wake(a, {
      action: "set",
      name: "tick",
      trigger: "every 3s",
      text: `Tick for ${a.id}.`,
    })
    await promptWith(a, `Tick for ${a.id}.`, 30_000)
    await wake(a, { action: "cancel", name: "tick" })
  })

  test("a check that exits 1 skips the wake without a model call; exit 0 brings its output", async () => {
    const a = agents[0]!
    const calls = async () => (await prompts(a.node, a.session)).length
    const before = await calls()
    await wake(a, {
      action: "set",
      name: "skipper",
      trigger: "every 2s",
      text: `Should never arrive ${run}.`,
      check: "exit 1",
    })
    await until(
      async () =>
        (await admin("GET", `/v1/history?kind=wake.skipped&agent=${a.id}`))
          .history.length >= 2,
      { timeoutMs: 30_000, intervalMs: 500, what: "two skipped runs" },
    )
    await wake(a, { action: "cancel", name: "skipper" })
    // the set and cancel calls are the only model calls: none for the wake
    expect(await calls()).toBe(before + 4)
    expect(
      (await prompts(a.node, a.session)).some((p) =>
        p.includes(`Should never arrive ${run}.`),
      ),
    ).toBe(false)
    await wake(a, {
      action: "set",
      name: "checked",
      trigger: "every 2s",
      text: `Checked wake ${run}.`,
      check: `echo "work-${run}"; test -d /home`,
    })
    const prompt = await promptWith(a, `Checked wake ${run}.`, 30_000)
    expect(prompt).toContain(`work-${run}`)
    await wake(a, { action: "cancel", name: "checked" })
  })

  test("wakes fired while paused merge into one prompt after resume", async () => {
    const a = agents[1]!
    await wake(a, {
      action: "set",
      name: "merge",
      trigger: "fire-only",
      text: `Merged ${run}.`,
    })
    await admin("POST", `/v1/agents/${a.id}/pause`)
    for (let i = 0; i < 3; i++)
      await admin("POST", `/v1/agents/${a.id}/wakes/merge/fire`)
    await Bun.sleep(1500)
    expect(
      (await prompts(a.node, a.session)).some((p) =>
        p.includes(`Merged ${run}.`),
      ),
    ).toBe(false)
    await admin("POST", `/v1/agents/${a.id}/resume`)
    const prompt = await promptWith(a, `Merged ${run}.`)
    expect(prompt.split(`Merged ${run}.`).length - 1).toBe(1)
  })
})

describe("messages", () => {
  test("an agent's message reaches another agent (on another machine when there is one)", async () => {
    const from = agents[0]!
    const to = nodes.length > 1 ? agents[2]! : agents[1]!
    const out = await callTool(from.oc, from.session, "autocode_message", {
      action: "send",
      to: to.id,
      subject: "hello",
      text: `Hello from ${from.node} ${run}.`,
    })
    expect(out).toContain(`Sent to ${to.id}`)
    const prompt = await promptWith(to, `Hello from ${from.node} ${run}.`)
    expect(prompt).toContain("[autocode] 1 message")
    expect(prompt).toContain(`from agent ${from.id}, subject "hello"`)
  })

  test("a message to the owner reaches the inbox, and the answer comes back", async () => {
    const a = agents.at(-1)!
    await callTool(a.oc, a.session, "autocode_message", {
      action: "send",
      to: "owner",
      text: `Question ${run}?`,
    })
    const item = await until(
      async () =>
        (await admin("GET", "/v1/inbox")).items.find((i: any) =>
          i.body.includes(`Question ${run}?`),
        ),
      { timeoutMs: 15_000, what: "the inbox item" },
    )
    await admin("POST", `/v1/inbox/${item.id}/answer`, {
      text: `Answer ${run}.`,
    })
    const prompt = await promptWith(a, `Answer ${run}.`)
    expect(prompt).toContain("from the owner")
  })

  /*
   * The owner, 2026-11-09: a message to an agent whose turn runs goes into
   * that turn at its next step (OpenCode's steer delivery), not after it.
   */
  test("a message sent while the recipient's turn runs reaches its model in that turn", async () => {
    const from = agents[0]!
    const to = nodes.length > 1 ? agents[2]! : agents[1]!
    const fake = new FakeModel(to.node)
    // a turn with a slow tool call, then a step that sees the steer, then
    // its end
    await fake.script(
      [
        {
          session: to.session,
          tool_calls: [{ name: "shell", arguments: { command: "sleep 6" } }],
        },
        { session: to.session, reply: "saw it" },
      ],
      true,
    )
    const turn = to.oc.run(to.session, `long turn ${run}`, 90_000)
    await until(
      async () =>
        (await admin("GET", `/v1/agents/${to.id}`)).agent.status === "working",
      { timeoutMs: 15_000, intervalMs: 200, what: "the turn to start" },
    )
    await callTool(from.oc, from.session, "autocode_message", {
      action: "send",
      to: to.id,
      text: `Steered ${run}.`,
    })
    await turn
    // one turn: its second model request already carried the message
    const requests = (await fake.requests()).filter(
      (r) => r.session === to.session && r.kind === "primary",
    )
    const i = requests.findIndex((r) =>
      JSON.stringify(r.messages).includes(`long turn ${run}`),
    )
    const later = requests.slice(i + 1)
    expect(
      later.some((r) => JSON.stringify(r.messages).includes(`Steered ${run}.`)),
    ).toBe(true)
    const m = (await admin("GET", `/v1/messages?agent=${to.id}`)).messages.find(
      (x: any) => x.preview.includes(`Steered ${run}.`),
    )
    expect(m).toMatchObject({ state: "read", read_via: "steer" })
  }, 120_000)

  test("an agent reads and waits for a message in its own turn; it is not injected again", async () => {
    const from = agents[0]!
    const to = nodes.length > 1 ? agents[2]! : agents[1]!
    await admin("POST", `/v1/agents/${to.id}/pause`)
    await callTool(from.oc, from.session, "autocode_message", {
      action: "send",
      to: to.id,
      text: `For reading ${run}.`,
    })
    // paused: nothing comes on its own; read takes it in the agent's turn
    const out = await callTool(to.oc, to.session, "autocode_message", {
      action: "read",
    })
    expect(out).toContain(`> For reading ${run}.`)
    await admin("POST", `/v1/agents/${to.id}/resume`)
    await Bun.sleep(2500)
    expect(
      (await prompts(to.node, to.session)).some(
        (p) => p.startsWith("[autocode]") && p.includes(`For reading ${run}.`),
      ),
    ).toBe(false)
  }, 120_000)
})

describe("turn status", () => {
  test("an agent is working during a turn and idle after it", async () => {
    const a = agents[0]!
    await new FakeModel(a.node).script(
      [{ session: a.session, reply: "slow", delay_ms: 4000 }],
      true,
    )
    const turn = a.oc.run(a.session, "take your time", 60_000)
    await until(
      async () =>
        (await admin("GET", `/v1/agents/${a.id}`)).agent.status === "working",
      { timeoutMs: 10_000, intervalMs: 200, what: "the agent to be working" },
    )
    await turn
    await until(
      async () =>
        (await admin("GET", `/v1/agents/${a.id}`)).agent.status === "idle",
      { timeoutMs: 15_000, intervalMs: 200, what: "the agent to be idle" },
    )
  })
})
