/*
 * Setup for the spike checks: OpenCode 2.2.0 runs and loads the spike probe
 * plugin with the workspace folder.
 */
import { expect, test } from "bun:test"
import { nodes, probeUrl } from "../helpers/env.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { fetchJson, until } from "../helpers/wait.ts"

test("OpenCode 2.2.0 runs and loads the spike probe plugin with the workspace folder", async () => {
  const oc = new OpenCode(nodes[0]!)
  const info = await oc.info()
  expect(info.version).toBe("2.2.0")
  await oc.loadLocation()
  const instances = await until(
    async () => {
      const list = await fetchJson(`${probeUrl}/info`, { timeoutMs: 2000 })
      return list.length > 0 ? list : undefined
    },
    { what: "the probe plugin to start" },
  )
  expect(instances[0].info.app.version).toBe("2.2.0")
  expect(instances[0].dir).toBe("/home/dev/work")
})
