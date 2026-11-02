/*
 * Agents register with autocode_me on every machine and see each other.
 */
import { describe, expect, test } from "bun:test"
import { admin, callTool, readySession } from "../helpers/autocode.ts"
import { nodes } from "../helpers/env.ts"
import { OpenCode } from "../helpers/opencode.ts"

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
      expect(out).toBe(`Registered as ${idFor(node)} (status idle).`)
      const status = await callTool(oc, s.id, "autocode_me", {
        action: "status",
      })
      expect(status).toContain(`Registered as ${idFor(node)}: lead on ${node}.`)
      expect(status).toContain(`machine ${node}`)
      const agent = (await admin("GET", `/v1/agents/${idFor(node)}`)).agent
      expect(agent).toMatchObject({
        machine: node,
        session: s.id,
        status: "idle",
        directory: "/home/dev/work",
      })
    },
  )

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
    ).toBe(`Unregistered ${id}.`)
    expect(
      await callTool(oc, s.id, "autocode_me", { action: "status" }),
    ).toStartWith("Not registered")
  })

  test("a deleted session's ID moves to the next session that registers it", async () => {
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
    expect(
      await callTool(oc, second.id, "autocode_me", { action: "register", id }),
    ).toContain(`Registered as ${id}`)
    expect((await admin("GET", `/v1/agents/${id}`)).agent.session).toBe(
      second.id,
    )
  })
})
