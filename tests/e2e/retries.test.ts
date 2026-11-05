/*
 * Tier 0b3 end to end, on every machine of the topology: when the model's
 * provider keeps failing (the fake model answers 500), OpenCode gives up on
 * the turn (2.2.0: after 11 requests, about 85 s) and reports it failed with
 * its error type; the agent is in the error state; once the provider answers
 * again, Autocode's retry prompt continues the work and the agent recovers.
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
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
// OpenCode 2.2.0's requests for one turn before it gives up on a 500
const FAILS = 11

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

beforeAll(async () => {
  await admin("PATCH", "/v1/settings", {
    server: { min_interval: "1s", retry_interval: "2s" },
  })
})

afterAll(async () => {
  await admin("PATCH", "/v1/settings", {
    server: { min_interval: null, retry_interval: null },
  })
})

test("a provider that fails, then answers again: the error state, a retry, recovery", async () => {
  await Promise.all(
    nodes.map(async (node) => {
      const oc = new OpenCode(node)
      const s = await readySession(oc)
      const id = `e2e:${run}:${node}:retry`
      await callTool(oc, s.id, "autocode_me", { action: "register", id })
      await new FakeModel(node).script(
        [
          ...Array.from({ length: FAILS }, () => ({
            session: s.id,
            kind: "primary" as const,
            error: { status: 500 },
          })),
          { session: s.id, reply: `Recovered ${id}.` },
        ],
        true,
      )
      await oc.prompt(s.id, `Work for ${id}.`)
      const failed = await agentStatus(id, "error", 170_000)
      expect(failed.error, node).toMatchObject({
        type: "provider.internal",
        retries: 0,
        retryable: true,
      })
      // the retry reaches the model, which answers again
      const retry = await until(
        async () =>
          (await prompts(node, s.id)).find((p) =>
            p.includes("[autocode] retry 1"),
          ),
        { timeoutMs: 60_000, intervalMs: 500, what: `the retry on ${node}` },
      )
      expect(retry).toContain("Your last turn failed: provider.internal (at ")
      expect(retry).toContain("Continue where you left off.")
      const ok = await agentStatus(id, "idle", 60_000)
      expect(ok.error, node).toBeUndefined()
      const recovered = (
        await admin("GET", `/v1/history?kind=agent.recovered&agent=${id}`)
      ).history
      expect(recovered.length, node).toBe(1)
      expect(recovered[0].data).toMatchObject({
        error: "provider.internal",
        retries: 1,
      })
    }),
  )
}, 300_000)
