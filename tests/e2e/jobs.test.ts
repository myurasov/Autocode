/*
 * Tier 0f end to end, with real OpenCode sessions: the owner defines a job on
 * the last machine; an agent on the first starts a run; the plugin spawns a
 * fresh session there with the job's model, which is registered under the
 * run's ID and prompted, finishes with autocode_me finish, and its result
 * comes to the starter as a notice; the session is removed. A run past its
 * time limit fails, and its session is kept.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { admin, callTool, hostOf, readySession } from "../helpers/autocode.ts"
import { nodes } from "../helpers/env.ts"
import { FakeModel } from "../helpers/fake.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { until } from "../helpers/wait.ts"

const run = crypto.randomUUID().slice(0, 6)
const enc = encodeURIComponent
const job = `e2e-${run}-job`
let starter: { oc: OpenCode; session: string; id: string; node: string }
let jobHost: string

beforeAll(async () => {
  await admin("PATCH", "/v1/settings", { server: { min_interval: "1s" } })
  const node = nodes[0]!
  const oc = new OpenCode(node)
  const s = await readySession(oc)
  const id = `e2e:${run}:starter`
  await callTool(oc, s.id, "autocode_me", { action: "register", id })
  starter = { oc, session: s.id, id, node }
  // the job's host: the last machine's folder
  const last = new OpenCode(nodes.at(-1)!)
  await last.loadLocation()
  jobHost = (await hostOf(nodes.at(-1)!)).id
})

afterAll(async () => {
  await admin("DELETE", `/v1/agents/${enc(starter.id)}`).catch(() => {})
  await admin("DELETE", `/v1/jobs/${job}`).catch(() => {})
  await admin("PATCH", "/v1/settings", { server: { min_interval: null } })
})

describe("jobs across machines", () => {
  test("an agent starts a run; it spawns, finishes, its result comes back; the session goes", async () => {
    const set = await admin("PUT", `/v1/jobs/${job}`, {
      host: jobHost,
      description: "Says a word",
      model: "fake/main",
      prompt: `Say the word ${run}.`,
      trigger: "fire-only",
    })
    expect(set.job.online).toBe(true)
    // the run's model calls finish, then replies
    const fake = new FakeModel(nodes.at(-1)!)
    await fake.script(
      [
        {
          match: `Say the word ${run}.`,
          tool_calls: [
            {
              name: "autocode_me",
              arguments: { action: "finish", result: `word ${run}` },
            },
          ],
        },
        { match: `Finished run`, reply: "done" },
      ],
      true,
    )
    expect(
      await callTool(starter.oc, starter.session, "autocode_me", {
        action: "jobs",
      }),
    ).toContain(`${job}: Says a word`)
    const started = await callTool(starter.oc, starter.session, "autocode_me", {
      action: "run",
      job,
      text: "please",
    })
    const id = /Started run (\S+);/.exec(started)![1]!
    const done = await until(
      async () => {
        const r = (await admin("GET", `/v1/runs?job=${job}`)).runs[0]
        return r?.state === "succeeded" ? r : undefined
      },
      { timeoutMs: 120_000, intervalMs: 1000, what: "the run to finish" },
    )
    expect(done).toMatchObject({ id, result: `word ${run}`, by: starter.id })
    // the result came to the starter as a notice
    await until(
      async () =>
        (await new FakeModel(starter.node).requests()).some(
          (r: any) =>
            r.session === starter.session &&
            JSON.stringify(r.messages).includes(
              `[autocode] result of run ${id}`,
            ),
        ),
      { timeoutMs: 60_000, intervalMs: 1000, what: "the result notice" },
    )
    // the session was removed
    const oc = new OpenCode(nodes.at(-1)!)
    await until(
      async () => !(await oc.getSession(done.session).catch(() => undefined)),
      { timeoutMs: 60_000, intervalMs: 1000, what: "the session removed" },
    )
  }, 300_000)
})
