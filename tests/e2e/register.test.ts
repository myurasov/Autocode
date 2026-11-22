/*
 * Agents register with autocode_me on every machine and see each other; a
 * registered session's title becomes "@<agent ID>" (the owner, 2026-11-17).
 */
import { describe, expect, test } from "bun:test"
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
const idFor = (node: string) => `e2e:${run}:${node}`

describe("registration through autocode_me", () => {
  test.each(nodes)(
    "an agent on %s registers, sees its status, " +
      "and the server knows its machine",
    async (node) => {
      const oc = new OpenCode(node)
      const s = await readySession(oc)
      const out = await callTool(oc, s.id, "autocode_me", {
        action: "register",
        id: idFor(node),
        description: `lead on ${node}`,
      })
      // it registers during its own turn: working (tier 0b turn status)
      expect(out).toStartWith(`Registered as ${idFor(node)} (status working).`)
      const status = await callTool(oc, s.id, "autocode_me", {
        action: "status",
      })
      expect(status).toContain(`Registered as ${idFor(node)}: lead on ${node}.`)
      expect(status).toContain(`machine ${node}`)
      const agent = await agentStatus(idFor(node), "idle")
      expect(agent).toMatchObject({
        machine: node,
        session: s.id,
        status: "idle",
        directory: "/home/dev/work",
      })
      // The owner, 2026-11-17: "i want opencode sessions to set their names
      // to "@<agent-id>" upon registration".
      await until(
        async () => (await oc.getSession(s.id))?.title === `@${idFor(node)}`,
        { timeoutMs: 30_000, what: "the session's title @<agent ID>" },
      )
    },
  )

  /*
   * The review before 1.0.0: OpenCode names a session itself after its first
   * prompt (a side request to the model). That name does not take the place
   * of "@<agent ID>", also when it comes back after the registration, and
   * not after a later turn either.
   */
  test("OpenCode's own title for the session does not replace @<agent ID>", async () => {
    const node = nodes[0]!
    const oc = new OpenCode(node)
    const fake = new FakeModel(node)
    const s = await readySession(oc)
    const id = `e2e:${run}:titled`
    try {
      // the session's title request answers late: after it registered
      await fake.script(
        [
          {
            kind: "title",
            session: s.id,
            delay_ms: 4000,
            reply: "A late title",
          },
        ],
        true,
      )
      await callTool(oc, s.id, "autocode_me", { action: "register", id })
      const title = async () => (await oc.getSession(s.id))?.title
      await until(async () => (await title()) === `@${id}`, {
        timeoutMs: 30_000,
        what: "the session's title @<agent ID>",
      })
      // OpenCode asked for its title, and got the late answer
      const asked = (await fake.requests()).find(
        (r) => r.session === s.id && r.kind === "title",
      )
      expect(typeof asked?.step).toBe("number")
      await Bun.sleep(6000)
      expect(await title()).toBe(`@${id}`)
      await callTool(oc, s.id, "autocode_me", { action: "status" })
      await Bun.sleep(2000)
      expect(await title()).toBe(`@${id}`)
    } finally {
      await admin("DELETE", `/v1/agents/${encodeURIComponent(id)}`).catch(
        () => {},
      )
    }
  }, 120_000)

  test("every agent discovers the agents of every machine", async () => {
    for (const node of nodes) {
      const oc = new OpenCode(node)
      const s = await readySession(oc)
      const out = await callTool(oc, s.id, "autocode_me", {
        action: "discover",
        pattern: `e2e:${run}:*`,
      })
      for (const other of nodes) expect(out).toContain(`${idFor(other)}  idle`)
    }
  })

  test("a second session cannot take a live agent's ID; the tool says why", async () => {
    const oc = new OpenCode(nodes[0]!)
    const s = await readySession(oc)
    const out = await callTool(oc, s.id, "autocode_me", {
      action: "register",
      id: idFor(nodes[0]!),
    })
    expect(out).toStartWith("error (id_taken):")
  })

  test("an agent unregisters through the tool", async () => {
    const oc = new OpenCode(nodes[0]!)
    const s = await readySession(oc)
    const id = `e2e:${run}:temp`
    expect(
      await callTool(oc, s.id, "autocode_me", { action: "register", id }),
    ).toContain("Registered")
    expect(
      await callTool(oc, s.id, "autocode_me", { action: "unregister" }),
    ).toBe(
      `Unregistered ${id}; your wakes are removed and your locks released.`,
    )
    expect(
      await callTool(oc, s.id, "autocode_me", { action: "status" }),
    ).toStartWith("Not registered")
  })

  // The owner, 2026-11-22: an agent never takes an ID that is registered.
  test("a deleted session's ID is not taken by the next session that registers it; the owner moves it", async () => {
    const oc = new OpenCode(nodes[0]!)
    const first = await readySession(oc)
    const id = `e2e:${run}:mover`
    await callTool(oc, first.id, "autocode_me", { action: "register", id })
    await oc.deleteSession(first.id)
    const second = await readySession(oc)
    const { until } = await import("../helpers/wait.ts")
    await until(
      async () =>
        (await admin("GET", `/v1/history?kind=session.deleted`)).history.some(
          (h: any) => h.session === first.id,
        ),
      { timeoutMs: 15_000, what: "the server to hear of the deletion" },
    )
    const out = await callTool(oc, second.id, "autocode_me", {
      action: "register",
      id,
    })
    expect(out).toStartWith("error (id_taken):")
    expect(out).toContain(
      `autocode agents register ${id} --session ${second.id}`,
    )
    expect((await admin("GET", `/v1/agents/${id}`)).agent.session).toBe(
      first.id,
    )
    await admin("POST", "/v1/agents", { id, session: second.id })
    expect((await admin("GET", `/v1/agents/${id}`)).agent.session).toBe(
      second.id,
    )
    expect(
      await callTool(oc, second.id, "autocode_me", { action: "status" }),
    ).toStartWith(`Registered as ${id}`)
  })
})
