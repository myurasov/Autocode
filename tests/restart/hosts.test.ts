/*
 * A host's record that is gone (1.0.1: forgotten after host_expire_after,
 * or removed by the owner) with a real OpenCode that comes back: its plugin
 * says hello and it is a host again, and a session's next shell has a
 * living token, with no tool call in between. The plugin keeps each
 * session's token in OpenCode's storage; the one it kept died with the
 * host's record, and a shell does not renew a refused token as a tool call
 * does. First in this suite: no agent is registered on the host yet, so the
 * owner may remove it.
 */
import { expect, test } from "bun:test"
import {
  admin,
  callTool,
  hostOf,
  hostSeenAfter,
  readySession,
} from "../helpers/autocode.ts"
import { containerName, docker } from "../helpers/docker.ts"
import { nodes } from "../helpers/env.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { until } from "../helpers/wait.ts"

const node = nodes[0]!

test("a host whose record went is a host again when its OpenCode is back; a session's next shell has a living token", async () => {
  const oc = new OpenCode(node)
  const s = await readySession(oc)
  // a shell of the session: it reaches the server with the session's token
  const me = (on: OpenCode) =>
    callTool(on, s.id, "shell", {
      command: "autocode me 2>&1 | head -3",
      description: "who am I",
    })
  expect(await me(oc)).toContain("this session is not registered")
  const before = await hostOf(node)

  // its OpenCode goes; the host is offline, and the owner removes its record
  expect((await docker(["stop", "--time=3", containerName(node)])).code).toBe(0)
  await hostOf(node, false, 60_000)
  const path = `/v1/hosts/${encodeURIComponent(before.id)}`
  expect(await admin("DELETE", path)).toEqual({ removed: before.id })
  expect(
    (await admin("GET", "/v1/hosts")).hosts.map((h: any) => h.id),
  ).not.toContain(before.id)

  // OpenCode is back: the same host, known anew
  const started = Date.now()
  expect((await docker(["start", containerName(node)])).code).toBe(0)
  await until(() => new OpenCode(node).info().catch(() => undefined), {
    timeoutMs: 60_000,
    what: "OpenCode to answer",
  })
  const back = new OpenCode(node)
  await back.loadLocation()
  const after = await hostSeenAfter(node, started)
  expect(after.id).toBe(before.id)
  expect(Date.parse(after.first_seen)).toBeGreaterThanOrEqual(started - 1000)
  const again = await me(back)
  expect(again).not.toContain("refused")
  expect(again).toContain("this session is not registered")
}, 300_000)
