/*
 * Tier 0c end to end, on every machine of the topology: two agents (on two
 * machines when there are two) share a lock through autocode_lock in real
 * sessions. The first holds it; the second waits in the queue and gets the
 * grant as an injected notice when the first releases; a semaphore takes as
 * many as it has places, and the next by a notice; a hold that runs past its
 * ttl is freed, its holder told by a notice and the next in the queue
 * granted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { admin, callTool, readySession } from "../helpers/autocode.ts"
import { nodes } from "../helpers/env.ts"
import { FakeModel } from "../helpers/fake.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { until } from "../helpers/wait.ts"

const run = crypto.randomUUID().slice(0, 6)
const agents: { node: string; oc: OpenCode; session: string; id: string }[] = []

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p: any) => p?.text ?? "").join("")
      : JSON.stringify(content ?? "")

// The last user text of each model request of a session, oldest first.
async function prompts(node: string, session: string): Promise<string[]> {
  const out: string[] = []
  for (const r of await new FakeModel(node).requests()) {
    if (r.session !== session || r.kind !== "primary") continue
    const users = (r.messages as any[]).filter((m) => m?.role === "user")
    const last = users.at(-1)
    if (last) out.push(textOf(last.content))
  }
  return out
}

async function promptWith(a: (typeof agents)[number], text: string) {
  return until(
    async () =>
      (await prompts(a.node, a.session)).find((p) => p.includes(text)),
    { timeoutMs: 60_000, intervalMs: 500, what: `${text} on ${a.node}` },
  )
}

const lock = (a: (typeof agents)[number], args: Record<string, unknown>) =>
  callTool(a.oc, a.session, "autocode_lock", args)

const state = async (name: string) =>
  (await admin("GET", `/v1/locks?match=${encodeURIComponent(name)}`)).locks[0]

beforeAll(async () => {
  await admin("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
  // three agents: the first on the first machine, the others on the last
  for (const [n, node] of [nodes[0]!, nodes.at(-1)!, nodes.at(-1)!].entries()) {
    const oc = new OpenCode(node)
    const s = await readySession(oc)
    const id = `e2e:${run}:lock:${n}`
    await callTool(oc, s.id, "autocode_me", { action: "register", id })
    agents.push({ node, oc, session: s.id, id })
  }
})

afterAll(async () => {
  for (const a of agents)
    await admin("DELETE", `/v1/agents/${encodeURIComponent(a.id)}`).catch(
      () => {},
    )
  await admin("PATCH", "/v1/settings", { server: { min_interval: null } })
})

describe("locks across machines", () => {
  test("a mutex in arrival order: the second agent is granted by a notice when the first releases", async () => {
    const [first, second] = agents as [any, any]
    const name = `e2e:${run}:mutex`
    expect(
      await lock(first, { action: "acquire", name, ttl: "10m" }),
    ).toContain(`You hold lock "${name}" until`)
    expect(
      await lock(second, { action: "acquire", name, ttl: "10m", mode: "try" }),
    ).toContain(`error (lock_busy): lock ${name} is held by ${first.id}`)
    expect(
      await lock(second, { action: "acquire", name, ttl: "10m" }),
    ).toContain("you are number 1 in the queue")
    expect(await lock(second, { action: "list", pattern: name })).toContain(
      `held by ${first.id} until`,
    )
    expect(await lock(first, { action: "release", name })).toBe(
      `Released lock "${name}".`,
    )
    const notice = await promptWith(second, `[autocode] lock "${name}" granted`)
    expect(notice).toContain(`You hold lock "${name}" now, until`)
    expect((await state(name)).holders.map((h: any) => h.agent)).toEqual([
      second.id,
    ])
    expect(await lock(second, { action: "release", name })).toBe(
      `Released lock "${name}".`,
    )
    expect(await state(name)).toBeUndefined()
  }, 180_000)

  test("a semaphore of 2: two hold it, the third is granted by a notice when the owner releases one", async () => {
    const [first, second, third] = agents as [any, any, any]
    const name = `e2e:${run}:sem`
    await lock(first, { action: "acquire", name, ttl: "10m", max: 2 })
    await lock(second, { action: "acquire", name, ttl: "10m" })
    expect((await state(name)).holders.length).toBe(2)
    expect(
      await lock(third, { action: "acquire", name, ttl: "10m" }),
    ).toContain("you are number 1 in the queue")
    await admin("POST", `/v1/locks/${encodeURIComponent(name)}/release`, {
      agent: first.id,
    })
    await promptWith(third, `[autocode] lock "${name}" granted`)
    // the first is told the owner released it
    await promptWith(first, `[autocode] lock "${name}" released by the owner`)
    for (const a of [second, third]) await lock(a, { action: "release", name })
  }, 240_000)

  test("an expired hold is freed, its holder told, the next granted", async () => {
    const [first, second] = agents as [any, any]
    const name = `e2e:${run}:ttl`
    await lock(first, { action: "acquire", name, ttl: "5s" })
    await lock(second, { action: "acquire", name, ttl: "10m" })
    const expired = await promptWith(first, `[autocode] lock "${name}" expired`)
    expect(expired).toContain("(its ttl was 5s) and was freed")
    await promptWith(second, `[autocode] lock "${name}" granted`)
    expect((await state(name)).holders.map((h: any) => h.agent)).toEqual([
      second.id,
    ])
    // unregistering releases it
    await callTool(second.oc, second.session, "autocode_me", {
      action: "unregister",
    })
    expect(await state(name)).toBeUndefined()
  }, 180_000)
})
