/*
 * Stop All end to end, with a real OpenCode session (the review before
 * 1.0.0: no test stopped a real turn, and OpenCode 2.3 runs Subagents in the
 * background). A turn that hangs is interrupted and its agent paused; Resume
 * All resumes it. A Subagent that still works after its agent's turn ended
 * stops too: its shell ends, and its result starts no turn in the paused
 * agent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  admin,
  agentStatus,
  callTool,
  readySession,
} from "../helpers/autocode.ts"
import { dockerExec } from "../helpers/docker.ts"
import { nodes } from "../helpers/env.ts"
import { FakeModel } from "../helpers/fake.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { until } from "../helpers/wait.ts"

const run = crypto.randomUUID().slice(0, 6)
const enc = encodeURIComponent
const node = nodes[0]!
const id = `e2e:${run}:stopped`
let oc: OpenCode
let session: string

// The agent's history entries of a kind, oldest first.
async function entries(kind: string): Promise<any[]> {
  const list = (await admin("GET", `/v1/history?kind=${kind}&match=${enc(id)}`))
    .history as any[]
  return list.reverse()
}

const exists = async (file: string) =>
  (await dockerExec(node, ["test", "-e", file])).code === 0

// Whether OpenCode says a session's turn runs.
const busy = (s: any) => !!s?.time?.busy && !(s.time.idle >= s.time.busy)

beforeAll(async () => {
  await admin("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
  oc = new OpenCode(node)
  session = (await readySession(oc)).id
  await callTool(oc, session, "autocode_me", { action: "register", id })
})

afterAll(async () => {
  await admin("POST", "/v1/resume-all").catch(() => {})
  await admin("DELETE", `/v1/agents/${enc(id)}`).catch(() => {})
  await admin("PATCH", "/v1/settings", { server: { min_interval: null } })
})

describe("Stop All", () => {
  test("interrupts a turn that runs and pauses its agent; Resume All resumes it", async () => {
    await new FakeModel(node).script(
      [{ match: `Hang ${run}.`, hang: true }],
      true,
    )
    await oc.prompt(session, `Hang ${run}.`)
    await agentStatus(id, "working")
    const ended = (await entries("turn.ended")).length
    const stopped = await admin("POST", "/v1/stop-all")
    expect(stopped.paused).toContain(id)
    expect(stopped.interrupted).toContain(session)
    const last = await until(
      async () => {
        const list = await entries("turn.ended")
        return list.length > ended ? list.at(-1) : undefined
      },
      { timeoutMs: 60_000, intervalMs: 500, what: "the turn to end" },
    )
    expect(last.data.outcome).toBe("interrupted")
    expect((await agentStatus(id, "paused")).paused).toBe("stop-all")
    expect((await admin("POST", "/v1/resume-all")).resumed).toContain(id)
    await agentStatus(id, "idle")
  }, 180_000)

  /*
   * Proven here on OpenCode 2.3.0 before the fix: the interrupt of the
   * agent's session left its Subagent at work (its shell wrote its file),
   * and the Subagent's result then ran a turn in the paused agent. With the
   * Subagent's session interrupted too, OpenCode tells the agent's session
   * so, which starts a turn there: that one is interrupted as it starts.
   */
  test("stops a Subagent that works in the background, and the turn its end starts in the paused agent", async () => {
    const marker = `STOPSUB-${run}`
    const file = `/tmp/stop-all-${run}`
    await new FakeModel(node).script(
      [
        // the turn the Subagent's end starts: it would run on
        { match: "<subagent sessionID", hang: true },
        { match: "is working in the background", reply: `launched ${run}` },
        {
          match: `${marker} helper work`,
          tool_calls: [
            {
              name: "shell",
              arguments: {
                command: `touch ${file}-started; sleep 20; touch ${file}-done`,
                description: "w",
              },
            },
          ],
        },
        { match: `${marker} helper work`, reply: "helper done" },
        {
          match: `Delegate ${run}.`,
          tool_calls: [
            {
              name: "subagent",
              arguments: {
                agent: "general",
                description: "helper",
                prompt: `${marker} helper work`,
              },
            },
          ],
        },
      ],
      true,
    )
    await oc.run(session, `Delegate ${run}.`)
    // the agent's turn ended; its Subagent works on, in its shell
    await until(
      async () =>
        (await entries("turn.ended")).some((e) => e.data.background === 1),
      { timeoutMs: 60_000, intervalMs: 500, what: "the turn with a Subagent" },
    )
    await until(() => exists(`${file}-started`), {
      timeoutMs: 60_000,
      intervalMs: 500,
      what: "the Subagent's shell to start",
    })
    const sub = (await oc.api("GET", `/api/session?parentID=${session}`))[0]
    expect(busy(await oc.getSession(sub.id))).toBe(true)
    const turns = (await entries("turn.ended")).length
    const stopped = await admin("POST", "/v1/stop-all")
    expect(stopped.paused).toContain(id)
    // past the shell's 20 s: it was stopped before it wrote
    await Bun.sleep(30_000)
    expect(await exists(`${file}-done`)).toBe(false)
    // nothing runs: not the Subagent, not its agent
    expect(busy(await oc.getSession(sub.id))).toBe(false)
    expect(busy(await oc.getSession(session))).toBe(false)
    // and no turn ran in the paused agent, but one cut as it began
    const since = (await entries("turn.ended"))
      .slice(turns)
      .map((e) => e.data.outcome)
    expect(since.filter((o) => o !== "interrupted")).toEqual([])
    expect((await agentStatus(id, "paused")).paused).toBe("stop-all")
    // after Resume All a turn runs to its end again
    await admin("POST", "/v1/resume-all")
    await agentStatus(id, "idle")
    const fake = new FakeModel(node)
    await fake.reset()
    await fake.script([{ match: `After ${run}.`, reply: "fine" }], true)
    const ended = (await entries("turn.ended")).length
    await oc.run(session, `After ${run}.`)
    const last = await until(
      async () => {
        const list = await entries("turn.ended")
        return list.length > ended ? list.at(-1) : undefined
      },
      { timeoutMs: 60_000, intervalMs: 500, what: "the next turn to end" },
    )
    expect(last.data.outcome).toBe("succeeded")
  }, 240_000)
})
