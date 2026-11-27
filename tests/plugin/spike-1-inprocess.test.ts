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

// A prompt's ID as Autocode's server makes it (server/src/delivery.ts).
function promptId(now: number): string {
  const time = Math.floor(now).toString(16).padStart(12, "0")
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 12)
  return `msg_${time}${random}`
}

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

  /*
   * 1.1.0-rc7 (costs by cause): the plugin says which prompt started a
   * turn. OpenCode announces each input before the turn it starts
   * (session.inbox.enqueued), under the ID the prompt was given: the ID
   * Autocode's server made for its prompt. A queued prompt and a steer
   * prompt alike.
   */
  test("inject: the input that OpenCode announces for a prompt has the prompt's own ID", async () => {
    const s = await oc.createSession({})
    for (const delivery of ["queue", "steer"]) {
      const id = promptId(Date.now())
      const since = await probe.lastSeq()
      const res = await probe.call("session.prompt", {
        sessionID: s.id,
        id,
        text: `WITH-AN-ID ${delivery}`,
        delivery,
      })
      expect(res.ok, res.error).toBe(true)
      const announced = await until(
        async () => (await events("session.inbox.enqueued", s.id, since))[0],
        { what: `the ${delivery} prompt's input` },
      )
      expect(announced.data.data.inboxID).toBe(id)
      expect(announced.data.data.item.type).toBe("user")
      expect((await ended(s.id)).outcome).toBe("succeeded")
    }
  })

  /*
   * 1.1.1: the agent line must be on every request of an agent's session,
   * or a warming ping and a compaction miss the provider's cache. OpenCode
   * has a session hook for each kind of request: `context` (a turn's),
   * `generate` (a plugin's own request, as warming's) and `compaction`.
   */
  test("the session hooks generate and compaction exist; each is given a system list", async () => {
    const hooks = await until(
      async () => {
        const h = (await probe.info())[0]?.info?.hooks
        return h && h.registered.length + h.refused.length === 3 ? h : undefined
      },
      { what: "the probe's hooks" },
    )
    expect(hooks.registered).toContain("generate")
    expect(hooks.registered).toContain("compaction")
    // for the record: what OpenCode does with a name it does not know
    const unknown = hooks.refused.includes("no-such-hook")
    console.log(
      `spike 1: a session hook OpenCode does not know is ${
        unknown ? "refused" : "taken"
      }`,
    )
    const s = await oc.createSession({})
    await probe.call("session.prompt", { sessionID: s.id, text: "say hi" })
    expect((await ended(s.id)).outcome).toBe("succeeded")
    // a request that leaves no trace in the conversation, as warming's ping
    const start = await probe.lastSeq()
    const made = await probe.call("session.generate", {
      sessionID: s.id,
      prompt: "ping",
    })
    expect(made.error).toBeUndefined()
    expect(typeof made.result?.text).toBe("string")
    const pinged = (await probe.records("hook.generate", start)).filter(
      (r) => r.data.sessionID === s.id,
    )
    expect(pinged.length).toBeGreaterThan(0)
    expect(pinged[0]!.data.keys).toContain("system")
    // a list (the probe says null of anything else)
    expect(typeof pinged[0]!.data.system).toBe("number")
    const since = await probe.lastSeq()
    await probe.call("session.compact", { sessionID: s.id })
    await until(
      async () =>
        (await events("session.compaction.ended", s.id, since)).length > 0,
      { timeoutMs: 60_000, what: "the compaction to end" },
    )
    const seen = (await probe.records("hook.compaction", since)).filter(
      (r) => r.data.sessionID === s.id,
    )
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]!.data.keys).toContain("system")
    expect(typeof seen[0]!.data.system).toBe("number")
    console.log(
      `spike 1: system entries before the probe's hook: generate ${
        pinged[0]!.data.system
      }, compaction ${seen[0]!.data.system}`,
    )
  })

  /*
   * 1.1.2: what a session spends outside its steps. A `generate` request
   * (cache warming's ping) leaves no message, so no step event and no
   * record of the session has its cost. OpenCode announces each request's
   * usage (session.usage.recorded, with its source), but not to a plugin:
   * a plugin is told the session's totals after every request
   * (session.usage.updated). Autocode's plugin counts on what is pinned
   * here: the totals of a turn's steps, of the title and of a compaction
   * come before that turn's end is said, each step's right after the
   * step's own event; a ping's come while no turn runs, and they rise by
   * exactly what the request answered that it cost.
   */
  test("session.usage.updated says the session's totals after every request: a turn's before its end, a ping's while it idles", async () => {
    const start = await probe.lastSeq()
    const s = await oc.createSession({})
    // a turn of two steps
    await fake.script(
      [
        {
          session: s.id,
          tool_calls: [
            { name: "autocode_me", arguments: { action: "status" } },
          ],
        },
        { session: s.id, reply: "done" },
      ],
      true,
    )
    await probe.call("session.prompt", { sessionID: s.id, text: "two steps" })
    // the session's events so far, in the bus's order (the probe keeps
    // each event whole, under `data`)
    const said = async (since = start) =>
      (await probe.records("event", since))
        .map((r) => r.data.data)
        .filter((e) => e?.data?.sessionID === s.id)
    const types = async (since?: number) =>
      (await said(since)).map((e) => e.type)
    await until(
      async () => (await types()).includes("session.execution.succeeded"),
      { timeoutMs: 60_000, what: "the turn to end" },
    )
    const turn = await said()
    // not for a plugin: the announcement that names each request's source
    expect(turn.map((e) => e.type)).not.toContain("session.usage.recorded")
    const steps = turn.filter((e) => e.type === "session.step.ended")
    expect(steps.length).toBe(2)
    const totals = turn.filter((e) => e.type === "session.usage.updated")
    // each step's, and the title's
    expect(totals.length).toBeGreaterThanOrEqual(2)
    for (const e of totals) {
      // an ID of its own, a time, no folder; dollars and tokens by kind
      expect(e.id).toMatch(/^evt_[0-9A-Za-z]{20,}$/)
      expect(typeof e.created).toBe("number")
      expect(e.location).toBeUndefined()
      expect(typeof e.data.cost).toBe("number")
      for (const key of ["input", "output", "reasoning"])
        expect(typeof e.data.tokens[key]).toBe("number")
      for (const key of ["read", "write"])
        expect(typeof e.data.tokens.cache[key]).toBe("number")
    }
    expect(new Set(totals.map((e) => e.id)).size).toBe(totals.length)
    // they only rise
    const costs = totals.map((e) => e.data.cost as number)
    expect([...costs].sort((a, b) => a - b)).toEqual(costs)
    // each step's totals come right after the step's own event, and rise
    // by the step's cost
    const order = turn.map((e) => e.type)
    for (const step of steps) {
      const i = turn.indexOf(step)
      expect(order[i + 1]).toBe("session.usage.updated")
      const before = turn
        .slice(0, i)
        .filter((e) => e.type === "session.usage.updated")
        .at(-1)
      const rise = turn[i + 1].data.cost - (before?.data.cost ?? 0)
      expect(rise).toBeCloseTo(step.data.cost, 9)
    }
    // all of the turn's before its end is said
    expect(order.lastIndexOf("session.usage.updated")).toBeLessThan(
      order.indexOf("session.execution.succeeded"),
    )
    const sum = steps.reduce((n, e) => n + e.data.cost, 0)
    // what the totals hold beyond the steps: the title, if one was made
    const title = costs.at(-1)! - sum
    expect(title).toBeGreaterThanOrEqual(-1e-9)
    console.log(
      `spike 1: a turn's totals ${JSON.stringify(costs)}, its steps ${sum}`,
    )
    // a ping, while the session idles: the totals rise by what it cost
    const idle = await probe.lastSeq()
    const made = await probe.call("session.generate", {
      sessionID: s.id,
      prompt: "ping",
    })
    expect(made.error).toBeUndefined()
    expect(made.result.cost).toBeGreaterThan(0)
    const pinged = await until(
      async () =>
        (await said(idle)).find((e) => e.type === "session.usage.updated"),
      { what: "the ping's totals" },
    )
    expect(pinged.data.cost - costs.at(-1)!).toBeCloseTo(made.result.cost, 9)
    expect(pinged.data.tokens.input - totals.at(-1)!.data.tokens.input).toBe(
      made.result.tokens.input,
    )
    // no turn ran for it, and no message holds it
    expect(await types(idle)).not.toContain("session.execution.started")
    const messages = await oc.api(
      "GET",
      `/api/session/${s.id}/message?limit=200&order=desc`,
    )
    expect(JSON.stringify(messages)).not.toContain("ping")
    // a compaction is a turn of its own: its totals come inside it
    const since = await probe.lastSeq()
    await probe.call("session.compact", { sessionID: s.id })
    await until(
      async () => (await types(since)).includes("session.execution.succeeded"),
      { timeoutMs: 60_000, what: "the compaction's turn to end" },
    )
    const compaction = await types(since)
    const at = (type: string) => compaction.indexOf(type)
    expect(at("session.execution.started")).toBeGreaterThanOrEqual(0)
    expect(at("session.usage.updated")).toBeGreaterThan(
      at("session.execution.started"),
    )
    expect(at("session.usage.updated")).toBeLessThan(
      at("session.execution.succeeded"),
    )
  })

  /*
   * 1.1.2: a Subagent works on after its parent's turn has ended (OpenCode
   * 2.3 runs it in the background), so the parent idles while the Subagent
   * spends. Its requests move its own session's totals and never its
   * parent's: else each of its steps would look like a ping of the parent.
   */
  test("a Subagent's requests move its own session's totals, not its parent's", async () => {
    const start = await probe.lastSeq()
    const s = await oc.createSession({})
    const marker = `TOTALS-KID-${crypto.randomUUID().slice(0, 8)}`
    await fake.script(
      [
        {
          session: s.id,
          tool_calls: [
            {
              name: "subagent",
              arguments: {
                agent: "general",
                description: "totals",
                prompt: `${marker} say hi`,
              },
            },
          ],
        },
        { session: s.id, reply: "parent done" },
        // the Subagent answers well after its parent's turn has ended
        { match: marker, reply: "child done", delay_ms: 3000 },
        { session: s.id, reply: "parent after the child" },
      ],
      true,
    )
    await probe.call("session.prompt", { sessionID: s.id, text: "a kid" })
    const all = async () =>
      (await probe.records("event", start)).map((r) => r.data.data)
    const of = async (session: string) =>
      (await all()).filter((e) => e?.data?.sessionID === session)
    // the parent's two turns: its own, and the one its Subagent's result
    // starts
    await until(
      async () =>
        (await of(s.id)).filter((e) => e.type === "session.execution.succeeded")
          .length >= 2,
      { timeoutMs: 60_000, what: "the parent's second turn to end" },
    )
    const kid = (await all()).find(
      (e) => e.type === "session.created" && e.data?.parentID === s.id,
    )?.data.sessionID as string
    expect(typeof kid).toBe("string")
    const parent = await of(s.id)
    const child = await of(kid)
    const cost = (events: any[], type: string) =>
      events.filter((e) => e.type === type).map((e) => e.data.cost as number)
    const sum = (list: number[]) => list.reduce((n, c) => n + c, 0)
    // the Subagent spent, on its own totals
    const spent = sum(cost(child, "session.step.ended"))
    expect(spent).toBeGreaterThan(0)
    expect(cost(child, "session.usage.updated").at(-1)).toBeCloseTo(spent, 9)
    // the parent's totals: its own steps, and its title before the first
    const own = sum(cost(parent, "session.step.ended"))
    const totals = cost(parent, "session.usage.updated")
    const first = parent.findIndex((e) => e.type === "session.step.ended")
    const title = sum(
      cost(parent.slice(0, first), "session.usage.updated").slice(-1),
    )
    expect(totals.at(-1)! - own - title).toBeCloseTo(0, 9)
    // and none of the parent's totals came while only the Subagent worked:
    // each is inside one of the parent's own turns
    let running = false
    for (const e of parent) {
      if (e.type === "session.execution.started") running = true
      if (e.type === "session.execution.succeeded") running = false
      if (e.type === "session.usage.updated") expect(running).toBe(true)
    }
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
