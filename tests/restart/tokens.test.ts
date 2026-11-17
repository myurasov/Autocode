/*
 * A replaced consumer token (autocode token rotate --consumer) with a real
 * OpenCode that keeps running: a session's next shell acts as its agent
 * again, with no tool call in between. The documentation's fact check
 * before 1.0.0: the rotation ends every session token, and the plugin went
 * on handing the one it held, or had kept in OpenCode's storage, to the
 * session's shells until an autocode tool call was refused, so `autocode
 * fire me` in a shell got a 401. Both ways a machine gets the new token:
 * `plugin install` again (OpenCode 2.3 then loads the plugin anew: the kept
 * token is the dead one), and the client config alone, as the rotation
 * itself writes it on its own machine (the running plugin reads it again:
 * the token it holds is the dead one). Last in this suite: the topology's
 * consumer token is another one afterwards.
 */
import { expect, test } from "bun:test"
import {
  admin,
  callTool,
  hostSeenAfter,
  readySession,
} from "../helpers/autocode.ts"
import { dockerExec } from "../helpers/docker.ts"
import { autocodeUrl, nodes } from "../helpers/env.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { until } from "../helpers/wait.ts"

const node = nodes[0]!
const id = `rotate:${crypto.randomUUID().slice(0, 6)}:lead`

test("after a replaced consumer token, a session's next shell acts as its agent, with no tool call first", async () => {
  const oc = new OpenCode(node)
  const s = await readySession(oc)
  expect(
    await callTool(oc, s.id, "autocode_me", { action: "register", id }),
  ).toContain("Registered")
  // a shell of the session: it acts as the agent, with the session's token
  const me = () =>
    callTool(oc, s.id, "shell", {
      command: "autocode me 2>&1 | head -3",
      description: "who am I",
    })
  expect(await me()).toContain(`${id}:`)
  const log = async () =>
    (await dockerExec(node, ["cat", "/home/dev/.autocode/logs/plugin.log"]))
      .stdout

  // 1. on another machine, as the documents say: plugin install again with
  // the new token; OpenCode keeps running
  const first = (await admin("POST", "/v1/tokens/consumer/rotate")).token
  expect(first).toStartWith("acc_")
  const installed = await dockerExec(node, [
    "autocode",
    "plugin",
    "install",
    "--url",
    autocodeUrl,
    "--consumer-token",
    first,
  ])
  expect(installed.code, installed.stderr).toBe(0)
  await hostSeenAfter(node, Date.now(), 120_000)
  const again = await me()
  expect(again).not.toContain("refused")
  expect(again).toContain(`${id}:`)

  // 2. on the rotation's own machine: only the client config changes, and
  // the running plugin reads it again when the server refuses its token
  const second = (await admin("POST", "/v1/tokens/consumer/rotate")).token
  const written = await dockerExec(node, [
    "sed",
    "-i",
    `s/"consumer_token": *"[^"]*"/"consumer_token": "${second}"/`,
    "/home/dev/.autocode/client.json",
  ])
  expect(written.code, written.stderr).toBe(0)
  await until(
    async () =>
      (await log()).includes("the client config has a new consumer token"),
    { timeoutMs: 120_000, what: "the plugin to take the new consumer token" },
  )
  await hostSeenAfter(node, Date.now(), 120_000)
  const third = await me()
  expect(third).not.toContain("refused")
  expect(third).toContain(`${id}:`)
  await admin("DELETE", `/v1/agents/${encodeURIComponent(id)}`)
}, 600_000)
