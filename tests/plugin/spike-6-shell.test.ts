/*
 * Spike check 6: the shell hooks put each session's own values (its token, the
 * AUTOCODE_* variables) into its shells, Subagent shells included. The probe
 * matches each new shell to the shell tool call that started it: the tool hook
 * (execute.before) knows the session, the shell hook (create.before) can set
 * the environment, and the oldest pending call with the same command is the one
 * being created. The probe sets its own variable (PROBE_TOKEN): the Autocode
 * plugin loaded beside it sets AUTOCODE_TOKEN itself, after the hooks
 * (tests/e2e/shell-env.test.ts covers that).
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { nodes } from "../helpers/env.ts"
import { FakeModel, toolResults } from "../helpers/fake.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { probe } from "../helpers/probe.ts"
import { until } from "../helpers/wait.ts"

const oc = new OpenCode(nodes[0]!)
const fake = new FakeModel(nodes[0]!)
const command =
  'echo "token=$PROBE_TOKEN probe=$PROBE_SESSION opencode=$OPENCODE_SESSION_ID"'

function shellCall(session: string, cmd = command) {
  return [
    { session, tool_calls: [{ name: "shell", arguments: { command: cmd } }] },
    { session, reply: "done" },
  ]
}

beforeAll(async () => {
  await oc.loadLocation()
  await until(async () => (await probe.info()).length > 0, {
    what: "the probe plugin",
  })
})

describe("spike check 6: shell environment", () => {
  test("a session's shell gets the values the plugin set for that session", async () => {
    const s = await oc.createSession({})
    await probe.shellEnv(s.id, { PROBE_TOKEN: "token-of-s" })
    const since = await probe.lastSeq()
    await fake.script(shellCall(s.id), true)
    await oc.run(s.id, "run the shell")
    const out = toolResults(await fake.requests(), s.id).join("")
    expect(out).toContain("token=token-of-s")
    expect(out).toContain(`probe=${s.id}`)
    /*
     * OpenCode puts the calling session into the shell itself, but only after
     * the shell hook ran: the hook's environment does not have it yet (the
     * Autocode plugin applies its values when OpenCode sets it).
     */
    expect(out).toContain(`opencode=${s.id}`)
    const hook = await probe.waitFor(
      "shell.before",
      (r) => r.data.command === command,
      since,
    )
    expect(hook.data.envKeys).not.toContain("OPENCODE_SESSION_ID")
  })

  test("a Subagent's shell call is seen with the Subagent's own session, whose parent is known", async () => {
    const s = await oc.createSession({})
    const marker = `SUBSHELL-${crypto.randomUUID().slice(0, 8)}`
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
                prompt: `${marker} shell`,
              },
            },
          ],
        },
        {
          match: marker,
          tool_calls: [
            {
              name: "shell",
              arguments: { command: `echo ${marker} probe=$PROBE_SESSION` },
            },
          ],
        },
        { match: marker, reply: "child done" },
        { session: s.id, reply: "parent done" },
      ],
      true,
    )
    const since = await probe.lastSeq()
    await oc.run(s.id, "a subagent runs a shell", 60_000)
    const shell = await probe.waitFor(
      "shell.before",
      (r) => String(r.data.command).includes(marker),
      since,
    )
    const child = shell.data.matchedSession as string
    expect(child).toMatch(/^ses_/)
    expect(child).not.toBe(s.id)
    const parent = await probe.call("session.get", { sessionID: child })
    expect(parent.result.parentID).toBe(s.id)
  })

  test("two sessions running the same command at the same time each get their own values", async () => {
    for (let round = 0; round < 3; round++) {
      const a = await oc.createSession({})
      const b = await oc.createSession({})
      await probe.shellEnv(a.id, { PROBE_TOKEN: `token-a-${round}` })
      await probe.shellEnv(b.id, { PROBE_TOKEN: `token-b-${round}` })
      const same = 'sleep 1; echo "token=$PROBE_TOKEN"'
      await fake.script(
        [...shellCall(a.id, same), ...shellCall(b.id, same)],
        true,
      )
      await Promise.all([
        oc.run(a.id, "same command"),
        oc.run(b.id, "same command"),
      ])
      const reqs = await fake.requests()
      expect(toolResults(reqs, a.id).join("")).toContain(
        `token=token-a-${round}`,
      )
      expect(toolResults(reqs, b.id).join("")).toContain(
        `token=token-b-${round}`,
      )
    }
  })

  test("alternative: OpenCode's local API sets a session's shell environment (PUT /api/session/:id/environment), which replaces OpenCode's own", async () => {
    const s = await oc.createSession({})
    /*
     * The Autocode plugin, installed here too, sets the session's environment
     * at its first shell call (and not again while its token stays the same):
     * let it, then replace it.
     */
    await fake.script(shellCall(s.id, "true"), true)
    await oc.run(s.id, "first shell")
    await oc.api("PUT", `/api/session/${s.id}/environment`, {
      variables: { FROM_LOCAL_API: "yes" },
    })
    await fake.script(
      shellCall(s.id, 'echo "local=$FROM_LOCAL_API own=[$FAKE_MODEL_URL]"'),
      true,
    )
    await oc.run(s.id, "local api env")
    // the plugin (since spec draft 17) therefore sends OpenCode's own
    // environment along with its values
    expect(toolResults(await fake.requests(), s.id).join("")).toContain(
      "local=yes own=[]",
    )
  })
})
