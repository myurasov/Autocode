/*
 * Tier 0d end to end, on every machine of the topology, with real OpenCode
 * sessions: the question tool's form reaches the owner's inbox and the
 * owner's answer goes back into the turn; a permission prompt (shell set to
 * ask by the session's own rules) is answered once by the owner, and with
 * permission_mode approve at once; a question sent to another agent is
 * answered by it with autocode_message; an approval is asked and approved.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { admin, callTool, readySession } from "../helpers/autocode.ts"
import { nodes } from "../helpers/env.ts"
import { FakeModel } from "../helpers/fake.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { until } from "../helpers/wait.ts"

const run = crypto.randomUUID().slice(0, 6)
type Agent = { node: string; oc: OpenCode; session: string; id: string }
const agents: Agent[] = []

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p: any) => p?.text ?? "").join("")
      : JSON.stringify(content ?? "")

// Every text the model was sent in a session's requests (tool results too).
async function seen(a: Agent): Promise<string> {
  const out: string[] = []
  for (const r of await new FakeModel(a.node).requests())
    if (r.session === a.session)
      for (const m of r.messages as any[]) out.push(textOf(m?.content))
  return out.join("\n")
}

const askOf = (agent: string, kind: string) =>
  until(
    async () =>
      (await admin("GET", "/v1/inbox")).items.find(
        (i: any) => i.agent === agent && i.kind === kind,
      ),
    { timeoutMs: 60_000, intervalMs: 500, what: `a ${kind} of ${agent}` },
  )

// Until the model has been sent a request whose text holds `text` (the turn
// went on after the answer).
const reached = (a: Agent, text: string) =>
  until(async () => (await seen(a)).includes(text), {
    timeoutMs: 90_000,
    intervalMs: 500,
    what: `${text} in a request of ${a.id}`,
  })

const idle = (a: Agent) =>
  until(
    async () => {
      const s = await a.oc.getSession(a.session)
      return s?.time?.idle && s.outcome ? s : undefined
    },
    { timeoutMs: 90_000, intervalMs: 500, what: `${a.id} idle` },
  )

beforeAll(async () => {
  await admin("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
  for (const [n, node] of [nodes[0]!, nodes.at(-1)!].entries()) {
    const oc = new OpenCode(node)
    const s = await readySession(oc)
    const id = `e2e:${run}:ask:${n}`
    await callTool(oc, s.id, "autocode_me", { action: "register", id })
    agents.push({ node, oc, session: s.id, id })
  }
})

afterAll(async () => {
  for (const a of agents)
    await admin("DELETE", `/v1/agents/${encodeURIComponent(a.id)}`).catch(
      () => {},
    )
  await admin("PATCH", "/v1/settings", {
    server: { min_interval: null, permission_mode: null },
    agents: Object.fromEntries(agents.map((a) => [a.id, null])),
  })
})

describe("asks across machines", () => {
  test("the question tool: the form is in the inbox; the owner's answer reaches the turn", async () => {
    const [a] = agents as [Agent]
    const fake = new FakeModel(a.node)
    await fake.script(
      [
        {
          session: a.session,
          tool_calls: [
            {
              name: "question",
              arguments: {
                questions: [
                  {
                    header: "Fold",
                    question: "Which fold split should I use?",
                    options: [
                      { label: "v3", description: "new" },
                      { label: "v2", description: "old" },
                    ],
                  },
                ],
              },
            },
          ],
        },
        { session: a.session, reply: "noted" },
      ],
      true,
    )
    await a.oc.prompt(a.session, "ask me")
    const item = await askOf(a.id, "question")
    expect(item.questions[0]).toMatchObject({
      question: "Which fold split should I use?",
      options: ["v3", "v2"],
    })
    expect(
      (await admin("GET", `/v1/agents/${encodeURIComponent(a.id)}`)).agent
        .status,
    ).toBe("waiting")
    await admin("POST", `/v1/asks/${item.id}/answer`, { text: "v3" })
    await reached(a, '"Which fold split should I use?"="v3"')
    await idle(a)
  }, 180_000)

  test("a permission prompt: the owner allows it once; with approve it goes at once", async () => {
    const [, b] = agents as [Agent, Agent]
    await b.oc.api("PATCH", `/api/session/${b.session}`, {
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    })
    const fake = new FakeModel(b.node)
    const shell = (marker: string) => ({
      session: b.session,
      tool_calls: [
        {
          name: "shell",
          arguments: {
            command: `echo ${marker}`,
            description: "say a word",
          },
        },
      ],
    })
    await fake.script(
      [shell(`asked-${run}`), { session: b.session, reply: "ran it" }],
      true,
    )
    await b.oc.prompt(b.session, "run it")
    const item = await askOf(b.id, "permission")
    expect(item.action).toBe("shell")
    await admin("POST", `/v1/asks/${item.id}/answer`, { decision: "once" })
    await reached(b, `asked-${run}`)
    await idle(b)
    // approve: no inbox item at all
    await admin("PATCH", "/v1/settings", {
      agents: { [b.id]: { permission_mode: "approve" } },
    })
    await fake.script(
      [shell(`auto-${run}`), { session: b.session, reply: "ran it too" }],
      true,
    )
    await b.oc.prompt(b.session, "run it again")
    await reached(b, `auto-${run}`)
    await idle(b)
  }, 240_000)

  test("agent:<id>: the other agent gets the question and answers it with autocode_message", async () => {
    const [a, b] = agents as [Agent, Agent]
    await admin("PATCH", "/v1/settings", {
      agents: { [a.id]: { question_mode: `agent:${b.id}` } },
    })
    await new FakeModel(a.node).script(
      [
        {
          session: a.session,
          tool_calls: [
            {
              name: "question",
              arguments: {
                questions: [
                  {
                    header: "Color",
                    question: "Which color?",
                    options: [{ label: "red", description: "" }],
                  },
                ],
              },
            },
          ],
        },
        { session: a.session, reply: "ok" },
      ],
      true,
    )
    await a.oc.prompt(a.session, "ask the lead")
    const item = await askOf(a.id, "question")
    expect(item.routed).toBe(`agent:${b.id}`)
    // the notice reaches the other agent as a prompt of its own
    await until(
      async () => (await seen(b)).includes(`[autocode] question from ${a.id}`),
      { timeoutMs: 60_000, intervalMs: 500, what: "the notice" },
    )
    await idle(b)
    expect(
      await callTool(b.oc, b.session, "autocode_message", {
        action: "answer",
        id: item.id,
        text: "red",
      }),
    ).toContain(`Answered ${item.id}`)
    await reached(a, '"Which color?"="red"')
    await idle(a)
  }, 240_000)

  test("an approval: asked with the tool, approved by the owner, told by a notice", async () => {
    const [a] = agents as [Agent]
    const asked = await callTool(a.oc, a.session, "autocode_approval", {
      action: "ask",
      text: `Deploy ${run}?`,
      options: "now, tonight",
    })
    const id = /Approval (ask_\w+)/.exec(asked)![1]!
    expect(asked).toContain("is with the owner")
    await admin("POST", `/v1/asks/${id}/answer`, {
      decision: "approve",
      option: "tonight",
    })
    await until(
      async () =>
        (await seen(a)).includes(
          `[autocode] approval "Deploy ${run}?" approved`,
        ),
      { timeoutMs: 60_000, intervalMs: 500, what: "the approval notice" },
    )
    expect(
      await callTool(a.oc, a.session, "autocode_approval", {
        action: "wait",
        id,
        seconds: 1,
      }),
    ).toBe(`Approval ${id}: approved by the owner. Option: tonight.`)
  }, 240_000)
})
