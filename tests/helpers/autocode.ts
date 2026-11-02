/*
 * The Autocode server in a test topology, called with the owner's admin token.
 */
import { adminToken, autocodeUrl } from "./env.ts"
import { FakeModel, toolResults } from "./fake.ts"
import type { OpenCode } from "./opencode.ts"
import { fetchJson, until } from "./wait.ts"

export function admin(
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  return fetchJson(`${autocodeUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// The machines' own workspace folder (other tests start OpenCode in others).
export const WORK = "/home/dev/work"

export async function hostOf(
  machine: string,
  online = true,
  timeoutMs = 30_000,
): Promise<any> {
  return until(
    async () =>
      (await admin("GET", "/v1/hosts")).hosts.find(
        (h: any) =>
          h.machine === machine && h.directory === WORK && h.online === online,
      ),
    {
      timeoutMs,
      intervalMs: 250,
      what: `host on ${machine} to be ${online ? "online" : "offline"}`,
    },
  )
}

// A host that polled after the given time (a reconnection, not a stale online
// flag).
export async function hostSeenAfter(
  machine: string,
  after: number,
  timeoutMs = 60_000,
): Promise<any> {
  return until(
    async () =>
      (await admin("GET", "/v1/hosts")).hosts.find(
        (h: any) =>
          h.machine === machine &&
          h.directory === WORK &&
          h.online &&
          Date.parse(h.last_seen) > after,
      ),
    { timeoutMs, intervalMs: 250, what: `host on ${machine} to poll again` },
  )
}

export async function agentStatus(
  id: string,
  status: string,
  timeoutMs = 30_000,
): Promise<any> {
  return until(
    async () => {
      const agent = (await admin("GET", "/v1/agents")).agents.find(
        (a: any) => a.id === id,
      )
      return agent?.status === status ? agent : undefined
    },
    { timeoutMs, intervalMs: 250, what: `agent ${id} to be ${status}` },
  )
}

// Makes the session's model call one tool, then end its turn; returns the
// tool's result text.
export async function callTool(
  oc: OpenCode,
  sessionID: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<string> {
  const fake = new FakeModel(oc.node)
  await fake.script(
    [
      { session: sessionID, tool_calls: [{ name: tool, arguments: args }] },
      { session: sessionID, reply: "done" },
    ],
    true,
  )
  await oc.run(sessionID, `call ${tool}`, timeoutMs)
  return toolResults(await fake.requests(), sessionID).at(-1) ?? ""
}

// Starts a session whose workspace folder has the plugin loaded.
export async function readySession(oc: OpenCode): Promise<{ id: string }> {
  await oc.loadLocation()
  return oc.createSession({})
}
