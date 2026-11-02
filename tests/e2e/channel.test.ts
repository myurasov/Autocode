/*
 * Spike check 9 (the channel part): the plugin inside each OpenCode machine
 * reaches the server across the Docker network, says hello and keeps
 * long-polling.
 */
import { expect, test } from "bun:test"
import { admin, hostOf } from "../helpers/autocode.ts"
import { nodes } from "../helpers/env.ts"
import { OpenCode } from "../helpers/opencode.ts"

test.each(nodes)(
  "the plugin on %s connects to the server " +
    "and stays online through its long polls",
  async (node) => {
    await new OpenCode(node).loadLocation()
    const host = await hostOf(node)
    expect(host.directory).toBe("/home/dev/work")
    expect(host.opencode_version).toBe("2.2.0")
    expect(host.id.startsWith(`${node}:work:`)).toBe(true)
    // The machines run `opencode serve` with --port and a password: the plugin
    // reports that, its PID, and that it can set its shells' values.
    expect(host.process_kind).toBe("serve")
    expect(host.process_pid).toBeGreaterThan(0)
    expect(host.shell_values).toBe(true)
    // Longer than the server's offline time (6 s): only the plugin's polls keep
    // the host online.
    await Bun.sleep(9000)
    const again = (await admin("GET", "/v1/hosts")).hosts.find(
      (h: any) => h.id === host.id,
    )
    expect(again.online).toBe(true)
  },
)

test("every machine is its own host", async () => {
  for (const node of nodes) await new OpenCode(node).loadLocation()
  for (const node of nodes) await hostOf(node)
  const hosts = (await admin("GET", "/v1/hosts")).hosts.filter(
    (h: any) => h.online,
  )
  expect(new Set(hosts.map((h: any) => h.machine))).toEqual(new Set(nodes))
})
