/*
 * Spike check 6 with the real plugin: each session's shells get its own
 * AUTOCODE_* values through OpenCode's session environment, on top of
 * OpenCode's own environment, Subagent shells included, and the token acts as
 * that session; the owner's own ! commands in that session get them too.
 */
import { expect, test } from "bun:test"
import { admin, readySession } from "../helpers/autocode.ts"
import { dockerExec } from "../helpers/docker.ts"
import { autocodeUrl, nodes } from "../helpers/env.ts"
import { FakeModel, toolResults } from "../helpers/fake.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { fetchJson, until } from "../helpers/wait.ts"

const probe =
  'echo "url=$AUTOCODE_URL server=$AUTOCODE_SERVER_ID ' +
  'session=$AUTOCODE_SESSION own=[$FAKE_MODEL_URL]"; ' +
  'curl -s --max-time 5 -H "Authorization: Bearer $AUTOCODE_TOKEN" ' +
  '"$AUTOCODE_URL/v1/me"'

test.each(nodes)(
  "a shell in a session on %s acts as that session",
  async (node) => {
    const oc = new OpenCode(node)
    const fake = new FakeModel(node)
    const s = await readySession(oc)
    await fake.script(
      [
        {
          session: s.id,
          tool_calls: [{ name: "shell", arguments: { command: probe } }],
        },
        { session: s.id, reply: "done" },
      ],
      true,
    )
    await oc.run(s.id, "probe the shell")
    const out = toolResults(await fake.requests(), s.id).join("")
    expect(out).toContain("url=http://server:4848 server=ci-server")
    expect(out).toContain(`session=${s.id}`)
    expect(out).toContain(`"session":"${s.id}"`)
    // the session environment replaces OpenCode's own: the plugin keeps it
    expect(out).toContain(`own=[http://fake-model:9000/${node}/v1]`)
  },
)

test("the owner's own ! command in a session gets its values once the session's shells have them", async () => {
  const node = nodes[0]!
  const oc = new OpenCode(node)
  const fake = new FakeModel(node)
  const s = await readySession(oc)
  const file = `/tmp/bang-${crypto.randomUUID().slice(0, 8)}`
  // What a ! command in the session sees, as it writes it to a file.
  const bang = async (name: string) => {
    await oc.api("POST", `/api/session/${s.id}/shell`, {
      command: `echo "[$AUTOCODE_SESSION]" > ${file}-${name}`,
    })
    return until(
      async () => {
        const res = await dockerExec(node, ["cat", `${file}-${name}`])
        return res.code === 0 && res.stdout ? res.stdout.trim() : undefined
      },
      { what: `the ! command's file ${name}` },
    )
  }
  expect(await bang("before")).toBe("[]")
  await fake.script(
    [
      {
        session: s.id,
        tool_calls: [{ name: "shell", arguments: { command: "true" } }],
      },
      { session: s.id, reply: "done" },
    ],
    true,
  )
  await oc.run(s.id, "one shell call")
  expect(await bang("after")).toBe(`[${s.id}]`)
})

test("a Subagent's shell acts as its top-level session", async () => {
  const node = nodes[0]!
  const oc = new OpenCode(node)
  const fake = new FakeModel(node)
  const s = await readySession(oc)
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
            arguments: {
              command:
                `echo ${marker}; ` +
                `echo "oc=$OPENCODE_SESSION_ID"; ` +
                `${probe}`,
            },
          },
        ],
      },
      { match: marker, reply: "child done" },
      { session: s.id, reply: "parent done" },
    ],
    true,
  )
  await oc.run(s.id, "a subagent probes its shell", 90_000)
  // The Subagent's shell output is the tool result that starts with the marker
  // line.
  const results = (await fake.requests()).flatMap((r) =>
    (r.messages as any[])
      .filter((m) => m?.role === "tool")
      .map((m) => String(m.content)),
  )
  const out = results.find((text) => text.startsWith(`${marker}\n`))
  expect(out).toBeTruthy()
  // The shell ran in the Subagent's own session, yet acts as the top-level one.
  const own = /oc=(ses_\S+)/.exec(out ?? "")?.[1]
  expect(own).toBeTruthy()
  expect(own).not.toBe(s.id)
  expect(out).toContain(`session=${s.id}`)
  expect(out).toContain(`"session":"${s.id}"`)
})

// The session a token acts as, asked from the runner.
async function sessionOf(
  token: string | undefined,
): Promise<string | undefined> {
  if (!token) return undefined
  return (
    await fetchJson(`${autocodeUrl}/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).session
}

test("two sessions running the same command at once each get their own session's token", async () => {
  const node = nodes[0]!
  const oc = new OpenCode(node)
  const fake = new FakeModel(node)
  const cmd = 'sleep 1; echo "token=$AUTOCODE_TOKEN"'
  const a = await readySession(oc)
  const b = await readySession(oc)
  for (const s of [a, b])
    await fake.script(
      [
        {
          session: s.id,
          tool_calls: [{ name: "shell", arguments: { command: cmd } }],
        },
        { session: s.id, reply: "done" },
      ],
      true,
    )
  await Promise.all([oc.run(a.id, "token"), oc.run(b.id, "token")])
  const reqs = await fake.requests()
  const ta = /token=(acs_\S+)/.exec(toolResults(reqs, a.id).join(""))?.[1]
  const tb = /token=(acs_\S+)/.exec(toolResults(reqs, b.id).join(""))?.[1]
  expect({ a: await sessionOf(ta), b: await sessionOf(tb) }).toEqual({
    a: a.id,
    b: b.id,
  })
})

test("a shell call that fails before its shell starts does not hand its token to another session's shell", async () => {
  const node = nodes[0]!
  const oc = new OpenCode(node)
  const fake = new FakeModel(node)
  const cmd = `echo "stale-check token=$AUTOCODE_TOKEN"`
  const a = await readySession(oc)
  const b = await readySession(oc)
  // ses A's call has an input the shell tool refuses (a timeout that is not a
  // number): no shell starts for it
  await fake.script(
    [
      {
        session: a.id,
        tool_calls: [
          { name: "shell", arguments: { command: cmd, timeout: "soon" } },
        ],
      },
      { session: a.id, reply: "done" },
    ],
    true,
  )
  await oc.run(a.id, "a refused shell call")
  // the tool's error repeats the arguments, with the variable not expanded: no
  // shell ran
  const refused = toolResults(await fake.requests(), a.id).join("")
  expect(refused).toContain("Invalid arguments")
  expect(refused).not.toMatch(/stale-check token=acs_/)
  /*
   * yet the plugin saw the call (execute.before runs before OpenCode checks the
   * input): it got A's token for it, so A's call was pending when B's shell
   * came
   */
  const tokens = (
    await admin("GET", "/v1/history?kind=session.token&limit=500")
  ).history
  expect(tokens.some((h: any) => h.session === a.id)).toBe(true)
  await fake.script(
    [
      {
        session: b.id,
        tool_calls: [{ name: "shell", arguments: { command: cmd } }],
      },
      { session: b.id, reply: "done" },
    ],
    true,
  )
  await oc.run(b.id, "the same command in another session")
  const token = /stale-check token=(acs_\S+)/.exec(
    toolResults(await fake.requests(), b.id).join(""),
  )?.[1]
  expect(await sessionOf(token)).toBe(b.id)
})
