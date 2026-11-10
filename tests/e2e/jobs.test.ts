/*
 * Tier 0f end to end, with real OpenCode sessions: the owner defines a job on
 * the last machine; an agent on the first starts a run; the plugin spawns a
 * fresh session there with the job's model, which is registered under the
 * run's ID and prompted, finishes with autocode_me finish, and its result
 * comes to the starter as a notice; the session is removed. The owner starts
 * a run, which ends with its last reply. A run past its time limit fails, and
 * its session is kept until the owner deletes it. Asks routed to job:<name>
 * (the owner, 2026-11-09: "make sure our ci covers jobs functionality,
 * including approving/answering/permitting with jobs"): a question, a
 * permission prompt and an approval of the starter are each answered by a run
 * of the job, with autocode_message, and the answer reaches the starter.
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
  for (const name of [job, `${job}-owner`, `${job}-slow`, `${job}-asks`])
    await admin("DELETE", `/v1/jobs/${name}`).catch(() => {})
  await admin("PATCH", "/v1/settings", {
    server: { min_interval: null },
    agents: { [starter.id]: null },
  })
})

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p: any) => p?.text ?? "").join("")
      : JSON.stringify(content ?? "")

// Every text a session's model was sent on a node (tool results too).
async function seen(node: string, session: string): Promise<string> {
  const out: string[] = []
  for (const r of await new FakeModel(node).requests())
    if (r.session === session)
      for (const m of r.messages as any[]) out.push(textOf(m?.content))
  return out.join("\n")
}

const runOf = (name: string, state: string) =>
  until(
    async () => {
      const r = (await admin("GET", `/v1/runs?job=${name}`)).runs.find(
        (x: any) => x.state === state,
      )
      return r?.session ? r : undefined
    },
    { timeoutMs: 120_000, intervalMs: 1000, what: `a ${state} run of ${name}` },
  )

const idle = (oc: OpenCode, session: string) =>
  until(
    async () => {
      const s = await oc.getSession(session)
      return s?.time?.idle && s.outcome ? s : undefined
    },
    { timeoutMs: 90_000, intervalMs: 500, what: `${session} idle` },
  )

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

  test("the owner starts a run; it ends with its last reply, which goes to the owner", async () => {
    const name = `${job}-owner`
    await admin("PUT", `/v1/jobs/${name}`, {
      host: jobHost,
      model: "fake/main",
      prompt: `Report ${run}.`,
      trigger: "fire-only",
      to: "owner",
    })
    await new FakeModel(nodes.at(-1)!).script(
      [{ match: `Report ${run}.`, reply: `report ${run} done` }],
      true,
    )
    await admin("POST", `/v1/jobs/${name}/run`)
    const done = await until(
      async () => {
        const r = (await admin("GET", `/v1/runs?job=${name}`)).runs[0]
        return r?.state === "succeeded" ? r : undefined
      },
      { timeoutMs: 120_000, intervalMs: 1000, what: "the run to end" },
    )
    expect(done).toMatchObject({ by: "owner", result: `report ${run} done` })
    // the owner's result: an inbox item of its own
    const item = (await admin("GET", "/v1/inbox?all=1")).items.find(
      (i: any) => i.title === `Result of run ${done.id}`,
    )
    expect(item?.body).toBe(`report ${run} done`)
  }, 240_000)

  test("a run past its time limit fails; its session is kept until the owner deletes it", async () => {
    const name = `${job}-slow`
    await admin("PUT", `/v1/jobs/${name}`, {
      host: jobHost,
      model: "fake/main",
      prompt: `Take forever ${run}.`,
      trigger: "fire-only",
      timeout: "1m",
    })
    await new FakeModel(nodes.at(-1)!).script(
      [{ match: `Take forever ${run}.`, hang: true }],
      true,
    )
    await admin("POST", `/v1/jobs/${name}/run`)
    await runOf(name, "running")
    const failed = await until(
      async () => {
        const r = (await admin("GET", `/v1/runs?job=${name}`)).runs[0]
        return r?.state === "failed" ? r : undefined
      },
      { timeoutMs: 150_000, intervalMs: 2000, what: "the run to fail" },
    )
    expect(failed.reason).toContain("time limit")
    const oc = new OpenCode(nodes.at(-1)!)
    // kept for the owner to look at
    expect(await oc.getSession(failed.session)).toBeDefined()
    await admin("DELETE", `/v1/runs/${enc(failed.id)}/session`)
    await until(
      async () => !(await oc.getSession(failed.session).catch(() => undefined)),
      { timeoutMs: 60_000, intervalMs: 1000, what: "the session deleted" },
    )
  }, 300_000)

  test("job:<name>: a run answers the starter's question, permission and approval", async () => {
    const name = `${job}-asks`
    await admin("PUT", `/v1/jobs/${name}`, {
      host: jobHost,
      model: "fake/main",
      prompt: `Answer for ${run}.`,
      trigger: "fire-only",
    })
    await admin("PATCH", "/v1/settings", {
      agents: {
        [starter.id]: {
          question_mode: `job:${name}`,
          permission_mode: `job:${name}`,
          approval_mode: `job:${name}`,
        },
      },
    })
    const jobNode = nodes.at(-1)!
    const runFake = new FakeModel(jobNode)
    const starterFake = new FakeModel(starter.node)
    /*
     * The next run's model, before its ask opens (the run starts at once): it
     * waits in a shell while the test reads the ask's ID, then answers it with
     * autocode_message and finishes.
     */
    async function prepare(n: number) {
      // a run's ID is its minute: one run of a job a minute (else the ask
      // would be the owner's), so the next ask waits for a new minute
      if (n > 1) {
        const minute = new Date().toISOString().slice(0, 16)
        await until(
          async () => new Date().toISOString().slice(0, 16) !== minute,
          { timeoutMs: 61_000, intervalMs: 500, what: "the next minute" },
        )
      }
      await runFake.script(
        [
          {
            match: `Answer for ${run}.`,
            tool_calls: [
              {
                name: "shell",
                arguments: { command: "sleep 15", description: `wait ${n}` },
              },
            ],
          },
        ],
        true,
      )
    }
    async function answeredBy(ask: string, text: string) {
      const r = await runOf(name, "running")
      expect(r.ask).toBe(ask)
      await runFake.script(
        [
          {
            session: r.session,
            tool_calls: [
              {
                name: "autocode_message",
                arguments: { action: "answer", id: ask, text },
              },
            ],
          },
          {
            session: r.session,
            tool_calls: [
              {
                name: "autocode_me",
                arguments: { action: "finish", result: `answered ${text}` },
              },
            ],
          },
          { session: r.session, reply: "done" },
        ],
        true,
      )
      const done = await until(
        async () => {
          const x = (await admin("GET", `/v1/runs?job=${name}`)).runs.find(
            (y: any) => y.id === r.id,
          )
          return x?.state === "succeeded" ? x : undefined
        },
        { timeoutMs: 120_000, intervalMs: 1000, what: `the run for ${ask}` },
      )
      expect(done.result).toBe(`answered ${text}`)
      return r.id as string
    }
    const askOf = (kind: string) =>
      until(
        async () =>
          (await admin("GET", "/v1/inbox")).items.find(
            (i: any) => i.agent === starter.id && i.kind === kind,
          ),
        { timeoutMs: 60_000, intervalMs: 500, what: `a ${kind}` },
      )

    // a question
    await prepare(1)
    await starterFake.script(
      [
        {
          session: starter.session,
          tool_calls: [
            {
              name: "question",
              arguments: {
                questions: [
                  {
                    header: "Fold",
                    question: `Which fold for ${run}?`,
                    options: [{ label: "v3", description: "" }],
                  },
                ],
              },
            },
          ],
        },
        { session: starter.session, reply: "noted" },
      ],
      true,
    )
    await starter.oc.prompt(starter.session, "ask the job")
    const question = await askOf("question")
    await answeredBy(question.id, "v3")
    await until(
      async () =>
        (await seen(starter.node, starter.session)).includes(
          `"Which fold for ${run}?"="v3"`,
        ),
      { timeoutMs: 90_000, intervalMs: 500, what: "the answer in the turn" },
    )
    await idle(starter.oc, starter.session)

    // a permission prompt (shell asks, by the session's own rules)
    await starter.oc.api("PATCH", `/api/session/${starter.session}`, {
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    })
    await starterFake.script(
      [
        {
          session: starter.session,
          tool_calls: [
            {
              name: "shell",
              arguments: {
                command: `echo permitted-${run}`,
                description: "say",
              },
            },
          ],
        },
        { session: starter.session, reply: "ran it" },
      ],
      true,
    )
    await prepare(2)
    await starter.oc.prompt(starter.session, "run it")
    const permission = await askOf("permission")
    await answeredBy(permission.id, "once")
    await until(
      async () =>
        (await seen(starter.node, starter.session)).includes(
          `permitted-${run}`,
        ),
      { timeoutMs: 90_000, intervalMs: 500, what: "the shell ran" },
    )
    await idle(starter.oc, starter.session)

    // an approval
    await prepare(3)
    const asked = await callTool(
      starter.oc,
      starter.session,
      "autocode_approval",
      { action: "ask", text: `Deploy ${run}?`, options: "now, tonight" },
    )
    const approval = /Approval (ask_\w+)/.exec(asked)![1]!
    const approver = await answeredBy(approval, "approve tonight")
    expect(
      await callTool(starter.oc, starter.session, "autocode_approval", {
        action: "wait",
        id: approval,
        seconds: 30,
      }),
    ).toBe(
      `Approval ${approval}: approved by agent ${approver}. Option: tonight.`,
    )
  }, 600_000)
})
