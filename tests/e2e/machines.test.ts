/*
 * Across machines only: a lost machine, a returning one and a network cut.
 */
import { describe, expect, test } from "bun:test"
import {
  agentStatus,
  callTool,
  hostOf,
  readySession,
} from "../helpers/autocode.ts"
import { containerName, docker, project } from "../helpers/docker.ts"
import { nodes } from "../helpers/env.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { until } from "../helpers/wait.ts"

const multi = nodes.length >= 2
const run = crypto.randomUUID().slice(0, 6)

async function healthy(node: string) {
  await until(
    async () => {
      const info = await new OpenCode(node).info().catch(() => undefined)
      return info?.version
    },
    {
      timeoutMs: 60_000,
      intervalMs: 500,
      what: `OpenCode on ${node} to answer`,
    },
  )
}

describe.skipIf(!multi)("machines come and go", () => {
  test("a stopped machine's agent goes offline, and comes back with the machine", async () => {
    const node = nodes[1]!
    const oc = new OpenCode(node)
    const s = await readySession(oc)
    const id = `e2e:${run}:lost`
    expect(
      await callTool(oc, s.id, "autocode_me", { action: "register", id }),
    ).toContain("Registered")
    expect((await docker(["stop", "--time=2", containerName(node)])).code).toBe(
      0,
    )
    await agentStatus(id, "offline", 30_000)
    expect((await docker(["start", containerName(node)])).code).toBe(0)
    await healthy(node)
    await oc.loadLocation()
    await hostOf(node, true, 60_000)
    const agent = await agentStatus(id, "idle", 60_000)
    expect(agent.session).toBe(s.id)
  })

  test("a network cut takes a machine offline; it reconnects by itself when the network returns", async () => {
    const node = nodes[0]!
    await new OpenCode(node).loadLocation()
    await hostOf(node)
    const network = `${project}_default`
    expect(
      (await docker(["network", "disconnect", network, containerName(node)]))
        .code,
    ).toBe(0)
    try {
      await hostOf(node, false, 30_000)
    } finally {
      expect(
        (
          await docker([
            "network",
            "connect",
            `--alias=${node}`,
            network,
            containerName(node),
          ])
        ).code,
      ).toBe(0)
    }
    const back = await hostOf(node, true, 60_000)
    expect(back.online).toBe(true)
  })
})
