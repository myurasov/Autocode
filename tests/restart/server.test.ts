/*
 * Restarts: the server restarted on its persistent volume, and an OpenCode
 * machine restarted, also under a running turn, which is then resumed (tier
 * 0e).
 */
import { expect, test } from "bun:test"
import {
  admin,
  agentStatus,
  callTool,
  hostOf,
  hostSeenAfter,
  readySession,
} from "../helpers/autocode.ts"
import { containerName, docker } from "../helpers/docker.ts"
import { autocodeUrl, nodes } from "../helpers/env.ts"
import { FakeModel, toolResults } from "../helpers/fake.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { fetchJson, until } from "../helpers/wait.ts"

const node = nodes[0]!
const id = `restart:${crypto.randomUUID().slice(0, 6)}:lead`

test("an agent stays registered across a server restart, and its machine reconnects", async () => {
  const oc = new OpenCode(node)
  const s = await readySession(oc)
  expect(
    await callTool(oc, s.id, "autocode_me", {
      action: "register",
      id,
      description: "survivor",
    }),
  ).toContain("Registered")
  const before = await hostOf(node)

  expect(
    (await docker(["restart", "--time=2", containerName("server")])).code,
  ).toBe(0)
  const restarted = Date.now()
  await until(() => fetchJson(`${autocodeUrl}/v1/info`, { timeoutMs: 2000 }), {
    timeoutMs: 30_000,
    what: "the server",
  })

  const agent = (await admin("GET", `/v1/agents/${id}`)).agent
  expect(agent).toMatchObject({ id, description: "survivor", session: s.id })
  const after = await hostSeenAfter(node, restarted)
  expect(after.id).toBe(before.id)
  expect(after.instance).toBe(before.instance)
  await agentStatus(id, "idle", 30_000)
  expect(
    await callTool(oc, s.id, "autocode_me", { action: "status" }),
  ).toContain(`Registered as ${id}: survivor.`)
})

test("while the server is down, sessions' shells run at once, without a token, and the plugin reconnects after", async () => {
  const oc = new OpenCode(node)
  const fake = new FakeModel(node)
  await hostOf(node)
  expect(
    (await docker(["stop", "--time=2", containerName("server")])).code,
  ).toBe(0)
  try {
    for (let round = 0; round < 2; round++) {
      const s = await readySession(oc)
      await fake.script(
        [
          {
            session: s.id,
            tool_calls: [
              {
                name: "shell",
                arguments: { command: 'echo "token=[$AUTOCODE_TOKEN]"' },
              },
            ],
          },
          { session: s.id, reply: "done" },
        ],
        true,
      )
      await oc.run(s.id, "a shell while the server is down")
      const reqs = (await fake.requests()).filter(
        (r) => r.session === s.id && r.kind === "primary",
      )
      expect(toolResults(reqs, s.id).join("")).toContain("token=[]")
      // The shell started without waiting on the unreachable server.
      const gap = Date.parse(reqs[1]!.at) - Date.parse(reqs[0]!.at)
      expect(gap).toBeLessThan(1500)
    }
  } finally {
    expect((await docker(["start", containerName("server")])).code).toBe(0)
  }
  const restarted = Date.now()
  await until(() => fetchJson(`${autocodeUrl}/v1/info`, { timeoutMs: 2000 }), {
    timeoutMs: 30_000,
    what: "the server",
  })
  await hostSeenAfter(node, restarted)
})

test("while the server hangs without answering, a new session's shell still starts within seconds, without a token", async () => {
  const oc = new OpenCode(node)
  const fake = new FakeModel(node)
  await hostOf(node)
  const s = await readySession(oc)
  // A paused container keeps its connections open and answers nothing: the
  // plugin's channel still looks connected.
  expect((await docker(["pause", containerName("server")])).code).toBe(0)
  try {
    await fake.script(
      [
        {
          session: s.id,
          tool_calls: [
            {
              name: "shell",
              arguments: { command: 'echo "token=[$AUTOCODE_TOKEN]"' },
            },
          ],
        },
        { session: s.id, reply: "done" },
      ],
      true,
    )
    await oc.run(s.id, "a shell while the server hangs")
    const reqs = (await fake.requests()).filter(
      (r) => r.session === s.id && r.kind === "primary",
    )
    expect(toolResults(reqs, s.id).join("")).toContain("token=[]")
    // The token request gave up after its 3 s limit; the shell did not wait on
    // the server beyond that.
    const gap = Date.parse(reqs[1]!.at) - Date.parse(reqs[0]!.at)
    expect(gap).toBeLessThan(6000)
  } finally {
    expect((await docker(["unpause", containerName("server")])).code).toBe(0)
  }
  const resumed = Date.now()
  await hostSeenAfter(node, resumed)
})

test("an OpenCode restart keeps the same host and the agent's session", async () => {
  const before = await hostOf(node)
  expect(
    (await docker(["restart", "--time=3", containerName(node)])).code,
  ).toBe(0)
  const restarted = Date.now()
  await until(() => new OpenCode(node).info().catch(() => undefined), {
    timeoutMs: 60_000,
    what: "OpenCode to answer",
  })
  await new OpenCode(node).loadLocation()
  const after = await hostSeenAfter(node, restarted)
  expect(after.id).toBe(before.id)
  expect(after.instance).not.toBe(before.instance)
  const agent = await agentStatus(id, "idle", 30_000)
  const oc = new OpenCode(node)
  expect(
    await callTool(oc, agent.session, "autocode_me", { action: "status" }),
  ).toContain(`Registered as ${id}`)
})

// Tier 0e: a turn cut by OpenCode going away is resumed when it is back.
test("a turn cut by an OpenCode restart is resumed with a resume prompt", async () => {
  const agent = await agentStatus(id, "idle", 60_000)
  const fake = new FakeModel(node)
  // the turn hangs in the model; OpenCode is killed under it
  await fake.script([{ session: agent.session, hang: true }], true)
  const oc = new OpenCode(node)
  await oc.prompt(agent.session, "a long turn")
  await agentStatus(id, "working", 30_000)
  expect(
    (await docker(["restart", "--time=1", containerName(node)])).code,
  ).toBe(0)
  await until(() => new OpenCode(node).info().catch(() => undefined), {
    timeoutMs: 60_000,
    what: "OpenCode to answer",
  })
  await new OpenCode(node).loadLocation()
  // OpenCode never resumes a cut turn; Autocode's prompt does
  const resumed = await until(
    async () =>
      (await fake.requests()).find(
        (r: any) =>
          r.session === agent.session &&
          JSON.stringify(r.messages).includes("[autocode] resume"),
      ),
    { timeoutMs: 120_000, intervalMs: 1000, what: "the resume prompt" },
  )
  expect(JSON.stringify(resumed.messages)).toContain(
    "Your last turn was cut off",
  )
  const h = (
    await admin(
      "GET",
      `/v1/history?kind=turn.cut&agent=${encodeURIComponent(id)}`,
    )
  ).history
  expect(h.length).toBeGreaterThan(0)
}, 300_000)
