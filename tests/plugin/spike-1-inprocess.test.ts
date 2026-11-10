/*
 * Spike check 1: what the plugin can do in-process, through its plugin context,
 * and what needs OpenCode's local API.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { sessionIsGone } from "../../plugin/src/errors.ts"
import { dockerExec } from "../helpers/docker.ts"
import { nodes } from "../helpers/env.ts"
import { FakeModel, toolResults } from "../helpers/fake.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { events, probe } from "../helpers/probe.ts"
import { until } from "../helpers/wait.ts"

const oc = new OpenCode(nodes[0]!)
const fake = new FakeModel(nodes[0]!)

async function ended(sessionID: string, timeoutMs = 20_000) {
  return until(
    async () => {
      const s = await oc.getSession(sessionID)
      return s.outcome ? s : undefined
    },
    { timeoutMs, what: `session ${sessionID} to end its turn` },
  )
}

beforeAll(async () => {
  await oc.loadLocation()
  await until(async () => (await probe.info()).length > 0, {
    what: "the probe plugin",
  })
})

describe("spike check 1: in-process", () => {
  test("the session domain has prompt, interrupt, compact, create, remove, get, list, context and wait", async () => {
    const [instance] = await probe.info()
    for (const name of [
      "prompt",
      "interrupt",
      "compact",
      "create",
      "remove",
      "get",
      "list",
      "context",
      "wait",
    ])
      expect(instance.info.sessionKeys).toContain(name)
  })

  test("forms, the session environment and the session inbox are not in-process: they need OpenCode's local API", async () => {
    const [instance] = await probe.info()
    for (const name of ["form", "environment", "inbox", "active", "message"])
      expect(instance.info.sessionKeys).not.toContain(name)
  })

  test("inject: ctx.session.prompt starts a turn whose request reaches the model", async () => {
    const s = await oc.createSession({})
    const res = await probe.call("session.prompt", {
      sessionID: s.id,
      text: "INJECTED-BY-PLUGIN",
    })
    expect(res.ok).toBe(true)
    expect((await ended(s.id)).outcome).toBe("succeeded")
    const reqs = (await fake.requests()).filter(
      (r) => r.session === s.id && r.kind === "primary",
    )
    expect(JSON.stringify(reqs[0]?.messages)).toContain("INJECTED-BY-PLUGIN")
  })

  test("interrupt: ctx.session.interrupt ends a hanging turn as interrupted", async () => {
    const s = await oc.createSession({})
    await fake.script([{ session: s.id, hang: true }], true)
    await oc.prompt(s.id, "hang")
    await until(
      async () =>
        (await fake.requests()).some(
          (r) => r.session === s.id && r.kind === "primary",
        ),
      {
        what: "the hanging request",
      },
    )
    const res = await probe.call("session.interrupt", { sessionID: s.id })
    expect(res.result).toEqual({ interrupted: true })
    expect((await ended(s.id)).outcome).toBe("interrupted")
    expect((await events("session.execution.interrupted", s.id)).length).toBe(1)
  })

  test("compact: ctx.session.compact compacts the session between turns", async () => {
    const s = await oc.createSession({})
    await oc.run(s.id, "a turn to compact")
    const since = await probe.lastSeq()
    const res = await probe.call("session.compact", { sessionID: s.id })
    expect(res.ok).toBe(true)
    expect(res.result.type).toBe("compaction")
    await until(
      async () =>
        (await events("session.compaction.ended", s.id, since)).length > 0,
      {
        timeoutMs: 20_000,
        what: "the compaction to end",
      },
    )
    const context = await probe.call("session.context", { sessionID: s.id })
    expect(context.result.map((m: any) => m.type)).toContain("compaction")
  })

  test("create and delete: a session in a folder with a model and agent runs a prompt and is removed", async () => {
    const created = await probe.call("session.create", {
      location: { directory: "/home/dev/work" },
      title: "made by the plugin",
      model: { providerID: "fake", id: "main" },
      agent: "build",
    })
    expect(created.ok).toBe(true)
    const id = created.result.id as string
    expect(created.result.agent).toBe("build")
    await probe.call("session.prompt", {
      sessionID: id,
      text: "RUN-IN-CREATED-SESSION",
    })
    expect((await probe.call("session.wait", { sessionID: id })).ok).toBe(true)
    expect((await oc.getSession(id)).outcome).toBe("succeeded")
    expect((await probe.call("session.remove", { sessionID: id })).ok).toBe(
      true,
    )
    const gone = await oc.getSession(id).then(
      () => false,
      (err) => err.status === 404,
    )
    expect(gone).toBe(true)
    await until(async () => (await events("session.deleted", id)).length > 0, {
      what: "the session.deleted event",
    })
    // In-process, a missing session is core's tagged error (the plugin's
    // sessionIsGone relies on the tag).
    const missing = await probe.call("session.get", { sessionID: id })
    expect({ ok: missing.ok, name: missing.name }).toEqual({
      ok: false,
      name: "Session.NotFoundError",
    })
  })

  test("list: the top-level sessions of one folder, newest first, as {data, cursor}; session.created names the folder", async () => {
    const since = await probe.lastSeq()
    const s = await oc.createSession({})
    const listed = await probe.call("session.list", {
      directory: "/home/dev/work",
      parentID: null,
      limit: 200,
    })
    expect(listed.ok).toBe(true)
    expect(Array.isArray(listed.result.data)).toBe(true)
    const found = listed.result.data.find((x: any) => x.id === s.id)
    expect(found?.location?.directory).toBe("/home/dev/work")
    expect(found?.parentID).toBeUndefined()
    const created = await probe.waitFor(
      "event",
      (r) =>
        r.data.type === "session.created" &&
        r.data.data?.data?.sessionID === s.id,
      since,
    )
    expect(created.data.data.data.location.directory).toBe("/home/dev/work")
  })

  /*
   * The plugin's host is one OpenCode data folder and workspace folder. When a
   * second OpenCode process uses the same ones, its plugin instance checks the
   * server's sessions for that host at hello and reports the missing ones gone
   * (for good): that is right only if both processes see the same sessions.
   */
  test("two OpenCode processes on one data folder see each other's sessions", async () => {
    const node = nodes[0]!
    const second = new OpenCode(node, `http://${node}:4098`)
    // the second process gets an empty config folder (no plugins, so it leaves
    // this suite's host alone) and the same data folder
    const started = await dockerExec(node, [
      "sh",
      "-c",
      "mkdir -p /tmp/second-config && cd ~/work && " +
        "XDG_CONFIG_HOME=/tmp/second-config nohup opencode serve " +
        "--hostname 0.0.0.0 --port 4098 >/tmp/second.log 2>&1 & " +
        "echo $! > /tmp/second.pid",
    ])
    expect(started.code).toBe(0)
    try {
      await until(() => second.info().catch(() => undefined), {
        timeoutMs: 60_000,
        what: "the second OpenCode",
      })
      const first = await oc.createSession({})
      expect((await second.getSession(first.id)).id).toBe(first.id)
      const made = await second.createSession({})
      expect((await oc.getSession(made.id)).id).toBe(made.id)
    } finally {
      await dockerExec(node, [
        "sh",
        "-c",
        "kill $(cat /tmp/second.pid) 2>/dev/null; true",
      ])
    }
  })

  test("permissions: a request is listed and answered in-process, and the tool then runs", async () => {
    const s = await oc.createSession({
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    })
    await fake.script(
      [
        {
          session: s.id,
          tool_calls: [
            { name: "shell", arguments: { command: "echo PERMITTED" } },
          ],
        },
        { session: s.id, reply: "done" },
      ],
      true,
    )
    const since = await probe.lastSeq()
    await oc.prompt(s.id, "run a shell command that needs permission")
    const asked = await until(
      async () => (await events("permission.asked", s.id, since))[0],
      {
        what: "permission.asked",
      },
    )
    const list = await probe.call("permission.list", { sessionID: s.id })
    expect(list.result.map((p: any) => p.id)).toContain(asked.data.data.id)
    const reply = await probe.call("permission.reply", {
      sessionID: s.id,
      requestID: asked.data.data.id,
      decision: "once",
    })
    expect(reply.ok).toBe(true)
    expect((await ended(s.id)).outcome).toBe("succeeded")
    expect(toolResults(await fake.requests(), s.id).join("")).toContain(
      "PERMITTED",
    )
  })

  test("status, cost and context size are readable in-process", async () => {
    const s = await oc.createSession({})
    await fake.script(
      [
        {
          session: s.id,
          reply: "measured",
          usage: {
            prompt_tokens: 12_345,
            completion_tokens: 10,
            cached_tokens: 2345,
          },
        },
      ],
      true,
    )
    const since = await probe.lastSeq()
    await probe.call("session.prompt", { sessionID: s.id, text: "measure me" })
    await ended(s.id)
    const got = await probe.call("session.get", { sessionID: s.id })
    expect(got.result.outcome).toBe("succeeded")
    expect(got.result.time.idle).toBeGreaterThan(0)
    expect(got.result.cost).toBeGreaterThan(0)
    const step = (await events("session.step.ended", s.id, since)).at(-1)
    const tokens = step.data.data.tokens
    expect(tokens.input + tokens.cache.read + tokens.cache.write).toBe(12_345)
    expect(step.data.data.cost).toBeGreaterThan(0)
    expect(
      (await events("session.execution.started", s.id, since)).length,
    ).toBe(1)
    expect(
      (await events("session.execution.succeeded", s.id, since)).length,
    ).toBe(1)
    const context = await probe.call("session.context", { sessionID: s.id })
    expect(context.result.at(-1)).toMatchObject({
      type: "idle",
      outcome: "succeeded",
    })
  })
})

/*
 * The Autocode plugin counts a session as deleted only on OpenCode's own
 * not-found error, which OpenCode does not document: these keep that check
 * honest against the real thing.
 */
describe("the plugin's check for a deleted session, against real OpenCode", () => {
  // The error ctx.session.get gave, as the plugin's check sees it.
  async function gotError(sessionID: string) {
    const got = await probe.call("session.get", { sessionID })
    return got.ok ? undefined : { _tag: got.name, message: got.error }
  }

  test("a deleted session and one that never existed count as gone", async () => {
    const s = await oc.createSession({})
    await oc.deleteSession(s.id)
    for (const id of [s.id, "ses_00000000000000000000000000"]) {
      const err = await gotError(id)
      expect({ id, err: err !== undefined, gone: sessionIsGone(err) }).toEqual({
        id,
        err: true,
        gone: true,
      })
    }
  })

  test("a live session does not, and other failures do not either", async () => {
    const s = await oc.createSession({})
    expect(await gotError(s.id)).toBeUndefined()
    // a malformed ID is refused by OpenCode, but that is not "deleted"
    const bad = await gotError("not-a-session-id")
    expect(bad === undefined || !sessionIsGone(bad)).toBe(true)
  })
})
