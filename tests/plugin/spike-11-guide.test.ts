/*
 * Spike check 11 (tier 0b): the agent guide on real OpenCode. The skill the
 * Autocode plugin adds is listed in every session's skill guidance (OpenCode 2
 * puts it in the system text; the skill tool loads it) and its body loads,
 * though its path names no file; the context hook's line reaches the model in
 * each request of a registered session and its Subagents, the same line each
 * time (so the prompt cache holds), and never an unregistered one.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { callTool } from "../helpers/autocode.ts"
import { nodes } from "../helpers/env.ts"
import { FakeModel, toolResults } from "../helpers/fake.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { until } from "../helpers/wait.ts"

const oc = new OpenCode(nodes[0]!)
const fake = new FakeModel(nodes[0]!)
const run = crypto.randomUUID().slice(0, 6)
const LINE = /This session is Autocode agent `([^`]+)` on server `[^`]+`/

const defName = (d: any) => d?.function?.name ?? d?.name
const defOf = (defs: unknown[], name: string): any =>
  defs.find((d) => defName(d) === name)
const text = (content: unknown) =>
  typeof content === "string" ? content : JSON.stringify(content ?? "")
// The system text of a recorded request.
const systemOf = (r: any) =>
  (r.messages as any[])
    .filter((m) => m?.role === "system")
    .map((m) => text(m.content))
    .join("\n")

async function primary(session: string) {
  return (await fake.requests()).filter(
    (r) => r.session === session && r.kind === "primary",
  )
}

beforeAll(async () => {
  await oc.loadLocation()
})

describe("spike check 11: the agent guide", () => {
  test("the autocode skill is listed in the skill guidance, and its body loads", async () => {
    const s = await oc.createSession({})
    await oc.run(s.id, "hello")
    const [first] = await primary(s.id)
    const skill = defOf(first!.toolDefs, "skill")
    expect(skill).toBeDefined()
    const system = systemOf(first)
    expect(system).toContain("autocode")
    expect(system).toContain("what it is and how to use it")
    // load it the way the model would: the tool's one required argument
    const params = skill.function?.parameters ?? skill.parameters ?? {}
    const key: string = params.required?.[0] ?? "name"
    const loaded = await callTool(oc, s.id, "skill", { [key]: "autocode" })
    expect(loaded).toContain("# Autocode")
    expect(loaded).toContain("autocode_wake")
    // written for this server, once the plugin has said hello
    expect(loaded).toMatch(/Autocode server \(here `[^`]+` at http/)
  })

  test("a registered session's requests carry the line; an unregistered one's never do", async () => {
    const free = await oc.createSession({})
    await oc.run(free.id, "hello")
    for (const r of await primary(free.id))
      expect(systemOf(r)).not.toMatch(LINE)

    const s = await oc.createSession({})
    const id = `guide:${run}:lead`
    expect(
      await callTool(oc, s.id, "autocode_me", { action: "register", id }),
    ).toContain(`Registered as ${id}`)
    await until(
      async () => {
        await oc.run(s.id, "again")
        return LINE.exec(systemOf((await primary(s.id)).at(-1)))?.[1] === id
      },
      {
        timeoutMs: 30_000,
        intervalMs: 500,
        what: "the line to reach the model",
      },
    )
    await oc.run(s.id, "once more")
    const [a, b] = (await primary(s.id)).slice(-2)
    // the same system text request after request
    expect(systemOf(a)).toBe(systemOf(b))
  })

  // The spec (Agent Tools): compaction calls get no line (the review of 0b2,
  // 2026-11-08: nothing checked it).
  test("a registered session's compaction call carries no line", async () => {
    const s = await oc.createSession({})
    const id = `guide:${run}:compacted`
    expect(
      await callTool(oc, s.id, "autocode_me", { action: "register", id }),
    ).toContain(`Registered as ${id}`)
    await oc.run(s.id, "a turn before the compaction")
    await oc.api("POST", `/api/session/${s.id}/compact`, {})
    const compaction = await until(
      async () =>
        (await fake.requests()).find(
          (r) => r.session === s.id && r.kind === "compaction",
        ),
      { timeoutMs: 60_000, intervalMs: 500, what: "the compaction's request" },
    )
    expect(systemOf(compaction)).not.toMatch(LINE)
  })

  test("a Subagent of a registered session gets the same line", async () => {
    const s = await oc.createSession({})
    const id = `guide:${run}:parent`
    await callTool(oc, s.id, "autocode_me", { action: "register", id })
    // the registration has reached the plugin once the parent's requests say so
    await until(
      async () => {
        await oc.run(s.id, "ping")
        return LINE.exec(systemOf((await primary(s.id)).at(-1)))?.[1] === id
      },
      { timeoutMs: 30_000, intervalMs: 500, what: "the parent's line" },
    )
    const marker = `GUIDE-CHILD-${crypto.randomUUID().slice(0, 8)}`
    await fake.script(
      [
        {
          session: s.id,
          tool_calls: [
            {
              name: "subagent",
              arguments: {
                agent: "general",
                description: "guide",
                prompt: `${marker} say hi`,
              },
            },
          ],
        },
        // before the Subagent's step: the parent's next request carries the
        // marker too (in its tool call), and the Subagent may run after it
        { session: s.id, reply: "parent done" },
        { match: marker, reply: "child done" },
      ],
      true,
    )
    await oc.run(s.id, "start a subagent", 120_000)
    // the Subagent's own request: its prompt is a user message there (the
    // parent has it only in a tool call); OpenCode's session header may name
    // the parent
    const child = await until(
      async () =>
        (await fake.requests()).find(
          (r) =>
            r.kind === "primary" &&
            (r.messages as any[]).some(
              (m) =>
                m?.role === "user" &&
                text(m.content).includes(`${marker} say hi`),
            ),
        ),
      { timeoutMs: 60_000, intervalMs: 500, what: "the Subagent's request" },
    )
    console.log(
      `spike 11: the Subagent's request names session ${child.session}`,
    )
    expect(LINE.exec(systemOf(child))?.[1]).toBe(id)
    expect(toolResults(await fake.requests(), s.id).length).toBeGreaterThan(0)
  })
})
