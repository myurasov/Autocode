/*
 * Spike check 10: the OpenCode under test (2.2.0, the minimum) has everything
 * checks 1 to 9 rely on. When a newer release joins the matrix, this file says
 * at once if it dropped a route or a plugin function Autocode uses.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { nodes } from "../helpers/env.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { probe } from "../helpers/probe.ts"
import { until } from "../helpers/wait.ts"

const oc = new OpenCode(nodes[0]!)
const minimum = "2.2.0"

function newer(a: string, b: string) {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++)
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

beforeAll(async () => {
  await oc.loadLocation()
  await until(async () => (await probe.info()).length > 0, {
    what: "the probe plugin",
  })
})

describe("spike check 10: the minimum version has what Autocode uses", () => {
  test("the OpenCode under test is the minimum or newer", async () => {
    const { version } = await oc.info()
    expect(version === minimum || newer(version, minimum)).toBe(true)
  })

  test("the plugin context has every function the plugin relies on", async () => {
    const [instance] = await probe.info()
    const ctx = instance.info.ctx
    const need: Record<string, string[]> = {
      session: [
        "prompt",
        "interrupt",
        "compact",
        "create",
        "remove",
        "get",
        "list",
        "context",
        "wait",
        "hook",
      ],
      permission: ["list", "get", "reply"],
      tool: ["transform", "hook", "list"],
      shell: ["hook"],
      event: ["subscribe"],
      storage: ["get", "set"],
    }
    for (const [domain, names] of Object.entries(need))
      for (const name of names)
        expect(`${domain}.${name}: ${ctx[domain]?.[name]}`).toBe(
          `${domain}.${name}: function`,
        )
  })

  test("OpenCode's local API has the routes the plugin may need where the context falls short", async () => {
    const auth = btoa(`opencode:${process.env.OPENCODE_PASSWORD}`)
    const res = await fetch(`${oc.url}/openapi.json`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10_000),
    })
    const spec = (await res.json()) as any
    const routes = new Set<string>()
    for (const [path, ops] of Object.entries<any>(spec.paths))
      for (const method of Object.keys(ops))
        routes.add(`${method.toUpperCase()} ${path}`)
    for (const route of [
      "GET /api/info",
      "GET /api/location",
      "POST /api/session",
      "GET /api/session/{sessionID}",
      "DELETE /api/session/{sessionID}",
      "POST /api/session/{sessionID}/prompt",
      "POST /api/session/{sessionID}/interrupt",
      "POST /api/session/{sessionID}/compact",
      "PUT /api/session/{sessionID}/environment",
      "GET /api/session/{sessionID}/form",
      "POST /api/session/{sessionID}/form/{formID}/reply",
      "DELETE /api/session/{sessionID}/form/{formID}",
      "GET /api/session/{sessionID}/permission",
      "POST /api/session/{sessionID}/permission/{requestID}/reply",
      "GET /api/event",
    ])
      expect(routes.has(route) ? route : `missing ${route}`).toBe(route)
  })
})
