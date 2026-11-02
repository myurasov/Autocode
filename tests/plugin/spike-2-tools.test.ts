/*
 * Spike check 2: a tool call knows its session and that session's parent; how
 * long a tool may wait; tools per session.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { nodes } from "../helpers/env.ts"
import { FakeModel, toolResults } from "../helpers/fake.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { probe } from "../helpers/probe.ts"
import { until } from "../helpers/wait.ts"

const oc = new OpenCode(nodes[0]!)
const fake = new FakeModel(nodes[0]!)

beforeAll(async () => {
  await oc.loadLocation()
  await until(async () => (await probe.info()).length > 0, {
    what: "the probe plugin",
  })
})

describe("spike check 2: plugin tools", () => {
  test("a plugin tool registered with codemode off is offered to the model directly", async () => {
    const s = await oc.createSession({})
    await oc.run(s.id, "list your tools")
    const req = (await fake.requests()).find(
      (r) => r.session === s.id && r.kind === "primary",
    )
    expect(req?.tools).toContain("probe_whoami")
    expect(req?.tools).toContain("probe_wait")
  })

  test("a tool call knows its session; a top-level session has no parent", async () => {
    const s = await oc.createSession({})
    await fake.script(
      [
        {
          session: s.id,
          tool_calls: [{ name: "probe_whoami", arguments: {} }],
        },
        { session: s.id, reply: "done" },
      ],
      true,
    )
    const since = await probe.lastSeq()
    await oc.run(s.id, "who am i")
    const rec = await probe.waitFor(
      "whoami",
      (r) => r.data.sessionID === s.id,
      since,
    )
    expect(rec.data.parentID).toBeNull()
    expect(rec.data.agent).toBe("build")
  })

  test("a Subagent's tool call knows its own session, whose parent is the calling session", async () => {
    const s = await oc.createSession({})
    const marker = `SUBAGENT-${crypto.randomUUID().slice(0, 8)}`
    await fake.script(
      [
        {
          session: s.id,
          tool_calls: [
            {
              name: "subagent",
              arguments: {
                agent: "general",
                description: "probe",
                prompt: `${marker} whoami`,
              },
            },
          ],
        },
        {
          match: marker,
          tool_calls: [{ name: "probe_whoami", arguments: {} }],
        },
        { match: marker, reply: "child done" },
        { session: s.id, reply: "parent done" },
      ],
      true,
    )
    const since = await probe.lastSeq()
    await oc.run(s.id, "use a subagent", 60_000)
    const rec = await probe.waitFor(
      "whoami",
      (r) => r.data.parentID === s.id,
      since,
    )
    expect(rec.data.sessionID).not.toBe(s.id)
    expect(rec.data.sessionID).toMatch(/^ses_/)
  })

  test("tools can differ per session: the context hook removes a tool for one session only", async () => {
    const hidden = await oc.createSession({})
    const shown = await oc.createSession({})
    await probe.hideTool(hidden.id, true)
    await oc.run(hidden.id, "hidden")
    await oc.run(shown.id, "shown")
    const reqs = await fake.requests()
    expect(
      reqs.find((r) => r.session === hidden.id && r.kind === "primary")?.tools,
    ).not.toContain("probe_whoami")
    expect(
      reqs.find((r) => r.session === shown.id && r.kind === "primary")?.tools,
    ).toContain("probe_whoami")
    await probe.hideTool(hidden.id, false)
  })

  test(
    "a tool may wait more than 5 minutes; " +
      "the turn then continues with its result",
    async () => {
      const s = await oc.createSession({})
      const seconds = 330
      await fake.script(
        [
          {
            session: s.id,
            tool_calls: [{ name: "probe_wait", arguments: { seconds } }],
          },
          { session: s.id, reply: "waited" },
        ],
        true,
      )
      const since = await probe.lastSeq()
      const done = await oc.run(s.id, "wait in a tool", (seconds + 60) * 1000)
      expect(done.outcome).toBe("succeeded")
      const end = await probe.waitFor(
        "wait.end",
        (r) => r.data.sessionID === s.id,
        since,
      )
      expect(end.data.waited).toBeGreaterThanOrEqual(seconds * 1000)
      expect(
        (await probe.records("wait.abort", since)).filter(
          (r) => r.data.sessionID === s.id,
        ),
      ).toEqual([])
      expect(toolResults(await fake.requests(), s.id).join("")).toContain(
        `waited ${seconds} s`,
      )
    },
    { timeout: 480_000 },
  )
})
