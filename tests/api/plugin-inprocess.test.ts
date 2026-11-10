/*
 * The real plugin module, set up with a fake OpenCode plugin context (in the
 * shapes OpenCode 2.2.0 uses), against an in-process server: the parts of its
 * wiring that real OpenCode cannot be made to show on demand.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  call,
  PRESET_CONSUMER,
  type TestServer,
  testServer,
} from "../helpers/server.ts"
import { until } from "../helpers/wait.ts"

const root = mkdtempSync(join(tmpdir(), "autocode-plugin-"))
const saved: Record<string, string | undefined> = {}
const savedArgv = [...process.argv]
const cleanups: (() => Promise<void>)[] = []
let t: TestServer
let plugin: any
let api: FakeApi

function setEnv(name: string, value: string | undefined) {
  if (!(name in saved)) saved[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

interface ApiRequest {
  method: string
  path: string
  authorization: string
  body: any
}

interface FakeApi {
  url: string
  requests: ApiRequest[]
  // The process ID /api/info gives: this process unless a test says otherwise.
  infoPid: number
  stop: () => void
}

/*
 * An OpenCode server's local API, as far as the plugin uses it: /api/info
 * (version and process ID, as @opencode/client's discovery reads it), and a
 * session's environment. It wants the password "pw".
 */
function fakeApi(): FakeApi {
  const requests: ApiRequest[] = []
  const state = { infoPid: process.pid }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url)
      const authorization = req.headers.get("authorization") ?? ""
      const text = await req.text()
      requests.push({
        method: req.method,
        path: url.pathname,
        authorization,
        body: text ? JSON.parse(text) : undefined,
      })
      if (authorization !== `Basic ${btoa("opencode:pw")}`)
        return new Response("unauthorized", { status: 401 })
      if (url.pathname === "/api/info")
        return Response.json({ version: "2.2.0", pid: state.infoPid })
      if (
        req.method === "PUT" &&
        /^\/api\/session\/[^/]+\/environment$/.test(url.pathname)
      )
        return new Response(null, { status: 204 })
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    get infoPid() {
      return state.infoPid
    },
    set infoPid(pid: number) {
      state.infoPid = pid
    },
    stop: () => server.stop(true),
  }
}

// The environments the plugin set for a session, oldest first.
function environments(session: string): Record<string, string>[] {
  return api.requests
    .filter(
      (r) =>
        r.method === "PUT" && r.path === `/api/session/${session}/environment`,
    )
    .map((r) => r.body.variables)
}

/*
 * How OpenCode was started, as the plugin finds out at setup: `opencode serve`
 * with --port and a password (the fake API), the same with that port
 * answering as another process, the background service (its registration
 * file, as @opencode/client's discover() reads it), one whose registration
 * names another process, or a standalone server (`serve --stdio --port 0`,
 * no password).
 */
type Started =
  | "serve"
  | "serve-elsewhere"
  | "service"
  | "service-other-pid"
  | "standalone"

function startedAs(how: Started) {
  const port = new URL(api.url).port
  const bin = ["/usr/bin/opencode", "/x/opencode"]
  const argv = how.startsWith("serve")
    ? [...bin, "serve", "--hostname", "0.0.0.0", "--port", port]
    : how === "standalone"
      ? [...bin, "serve", "--stdio", "--port", "0"]
      : [...bin, "serve", "--service"]
  process.argv.splice(0, process.argv.length, ...argv)
  // OPENCODE_PASSWORD would win over it (the CI runner has one)
  setEnv("OPENCODE_PASSWORD", undefined)
  setEnv("OPENCODE_SERVER_PASSWORD", how.startsWith("serve") ? "pw" : undefined)
  api.infoPid = how === "serve-elsewhere" ? process.pid + 1 : process.pid
  const state = join(root, `state-${how}`)
  mkdirSync(join(state, "opencode"), { recursive: true })
  if (how.startsWith("service"))
    writeFileSync(
      join(state, "opencode", "service.json"),
      JSON.stringify({
        id: "svc",
        version: "2.2.0",
        url: api.url,
        pid: how === "service-other-pid" ? process.pid + 1 : process.pid,
        password: "pw",
      }),
    )
  setEnv("XDG_STATE_HOME", state)
}

beforeAll(async () => {
  t = await testServer({ pollWait: 1 })
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({ url: t.url, consumer_token: PRESET_CONSUMER }),
  )
  setEnv("AUTOCODE_CONFIG", join(root, "config.json"))
  // the plugin's log (in the Autocode home) and the host ID's data folder stay
  // inside this test's folder
  setEnv("AUTOCODE_HOME", join(root, "home"))
  setEnv("XDG_DATA_HOME", join(root, "data"))
  api = fakeApi()
  plugin = (await import("../../plugin/src/index.ts")).default
})

afterAll(async () => {
  for (const c of cleanups.splice(0)) await c()
  await t.stop()
  api.stop()
  process.argv.splice(0, process.argv.length, ...savedArgv)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

interface Session {
  id: string
  parentID?: string
  directory: string
}

interface Fake {
  tools: any[]
  hooks: Record<string, (event: any) => any>
  emit: (event: any) => void
  // ctx.session.prompt and ctx.session.interrupt calls, oldest first
  calls: { kind: string; input: any }[]
  // the skills the plugin's skill transforms add now
  skills: () => any[]
}

// OpenCode's plugin storage (ctx.storage), shared by instances, as on disk.
const storage = new Map<string, unknown>()

/*
 * A plugin context with what the plugin uses: sessions (get, list, prompt,
 * interrupt, hooks), tool and shell hooks, skills, storage, and an event
 * stream that carries every folder's events, as OpenCode's does. OpenCode runs
 * as `opencode serve` with the fake local API unless told otherwise.
 */
async function startPlugin(
  directory: string,
  sessions: Session[],
  how: Started = "serve",
): Promise<Fake> {
  mkdirSync(directory, { recursive: true })
  startedAs(how)
  const tools: any[] = []
  const hooks: Record<string, (event: any) => any> = {}
  const calls: { kind: string; input: any }[] = []
  const skillTransforms: ((editor: any) => void)[] = []
  const queue: any[] = []
  let wake: (() => void) | undefined
  const ctx = {
    location: { directory },
    app: { version: "2.2.0" },
    storage: {
      get: async (key: string) => structuredClone(storage.get(key)),
      set: async (key: string, value: unknown) => {
        storage.set(key, structuredClone(value))
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...storage]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const s = sessions.find((x) => x.id === sessionID)
        // core's error for a missing session (in-process), not the HTTP API's
        if (!s)
          throw Object.assign(new Error(""), {
            _tag: "Session.NotFoundError",
            sessionID,
          })
        return {
          id: s.id,
          parentID: s.parentID,
          location: { directory: s.directory },
        }
      },
      list: async (input: {
        directory?: string
        parentID?: null
        limit?: number
      }) => ({
        data: sessions
          .filter(
            (s) =>
              (input.directory === undefined ||
                s.directory === input.directory) &&
              !s.parentID,
          )
          .slice(0, input.limit ?? 50)
          .map((s) => ({ id: s.id, location: { directory: s.directory } })),
        cursor: {},
      }),
      prompt: async (input: any) => {
        calls.push({ kind: "prompt", input })
        return { id: input.id }
      },
      interrupt: async (input: any) => {
        calls.push({ kind: "interrupt", input })
        return { interrupted: true }
      },
      hook: async (name: string, fn: any) => {
        hooks[`session.${name}`] = fn
      },
    },
    skill: {
      transform: async (fn: (editor: any) => void) => {
        skillTransforms.push(fn)
      },
      reload: async () => {},
    },
    tool: {
      transform: async (fn: (registry: any) => void) =>
        fn({ add: (tool: any) => tools.push(tool) }),
      hook: async (name: string, fn: any) => {
        hooks[`tool.${name}`] = fn
      },
    },
    shell: {
      hook: async (name: string, fn: any) => {
        hooks[`shell.${name}`] = fn
      },
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) {
            const next = queue.shift()
            if (next) {
              yield next
              continue
            }
            await new Promise<void>((resolve) => {
              wake = resolve
              signal?.addEventListener("abort", () => resolve())
            })
          }
        },
      }),
    },
  }
  const cleanup = await plugin.setup(ctx)
  if (cleanup) cleanups.push(cleanup)
  api.infoPid = process.pid
  return {
    tools,
    hooks,
    calls,
    skills: () => {
      const added: any[] = []
      for (const fn of skillTransforms) fn({ add: (x: any) => added.push(x) })
      return added
    },
    emit: (event) => {
      queue.push(event)
      wake?.()
    },
  }
}

function logCount(text: string): number {
  const file = join(root, "home", "logs", "plugin.log")
  return existsSync(file)
    ? readFileSync(file, "utf8").split(text).length - 1
    : 0
}

async function connected(start: () => Promise<Fake>): Promise<Fake> {
  const before = logCount("connected to")
  const fake = await start()
  await until(() => logCount("connected to") > before, {
    what: "the plugin to connect",
  })
  return fake
}

const me = (fake: Fake) => fake.tools.find((x) => x.name === "autocode_me")

/*
 * What OpenCode 2.2.0 does for one tool call before the tool runs (and, for the
 * shell tool, before it builds the shell's environment): execute.before,
 * awaited.
 */
function toolCall(fake: Fake, tool: string, session: string, id: string) {
  return fake.hooks["tool.execute.before"]!({
    tool,
    sessionID: session,
    id,
    input: tool === "shell" ? { command: "git status" } : {},
  })
}

async function sessionOf(token: string | undefined) {
  return (await call(t.url, token ?? "", "GET", "/v1/me")).body?.session
}

describe("the plugin in-process", () => {
  test("a session in an OpenCode process whose plugin instance was superseded can still register", async () => {
    const dir = join(root, "work-a")
    // two OpenCode processes with the same data folder (so the same sessions)
    // and the same workspace folder
    const sessions: Session[] = [
      { id: "ses_old", directory: dir },
      { id: "ses_new", directory: dir },
    ]
    const older = await connected(() => startPlugin(dir, sessions))
    await startPlugin(dir, sessions)
    await until(() => logCount("superseded by a newer instance") > 0, {
      timeoutMs: 15_000,
      what: "the first instance to step back",
    })
    const out = await me(older).execute(
      { action: "register", id: "inproc:older" },
      { sessionID: "ses_old" },
    )
    expect(out.content).toStartWith("Registered as inproc:older (status idle).")
    // the owner deletes that session in the older process: only that process's
    // event stream carries it
    sessions.splice(0, 1)
    older.emit({ type: "session.deleted", data: { sessionID: "ses_old" } })
    await until(
      async () =>
        (
          await call(t.url, t.admin, "GET", "/v1/history?kind=session.deleted")
        ).body.history.some((h: any) => h.session === "ses_old"),
      {
        timeoutMs: 8000,
        what: "the superseded instance to report the deletion",
      },
    )
  })

  test("each shell call sets its session's environment: OpenCode's own environment plus the session's values", async () => {
    const dir = join(root, "work-b")
    const fake = await connected(() =>
      startPlugin(dir, [
        { id: "ses_a", directory: dir },
        { id: "ses_b", directory: dir },
      ]),
    )
    await toolCall(fake, "read", "ses_b", "call_read")
    expect(environments("ses_b")).toEqual([])
    await toolCall(fake, "shell", "ses_b", "call_b")
    const put = api.requests.find(
      (r) => r.path === "/api/session/ses_b/environment",
    )!
    expect(put.authorization).toBe(`Basic ${btoa("opencode:pw")}`)
    const [env] = environments("ses_b")
    expect(env!.PATH).toBe(process.env.PATH!)
    expect(env!.AUTOCODE_URL).toBe(t.url)
    expect(env!.AUTOCODE_SERVER_ID).toBe(t.server.id)
    expect(env!.AUTOCODE_SESSION).toBe("ses_b")
    expect(await sessionOf(env!.AUTOCODE_TOKEN)).toBe("ses_b")
    /*
     * set again at the next shell call, with the same token (2026-11-08: an
     * OpenCode client replaces a session's environment when it opens it);
     * another session's shells are left alone
     */
    await toolCall(fake, "shell", "ses_b", "call_b2")
    expect(environments("ses_b").length).toBe(2)
    expect(environments("ses_b")[1]!.AUTOCODE_TOKEN).toBe(env!.AUTOCODE_TOKEN)
    expect(environments("ses_a")).toEqual([])
  })

  test("a Subagent's shells get its top-level session's values", async () => {
    const dir = join(root, "work-c")
    const fake = await connected(() =>
      startPlugin(dir, [
        { id: "ses_top", directory: dir },
        { id: "ses_child", parentID: "ses_top", directory: dir },
      ]),
    )
    await toolCall(fake, "shell", "ses_child", "c1")
    const [env] = environments("ses_child")
    expect(env!.AUTOCODE_SESSION).toBe("ses_top")
    expect(await sessionOf(env!.AUTOCODE_TOKEN)).toBe("ses_top")
  })

  test("after a rotation the plugin sets the new token in the session's environments; the old one is dead", async () => {
    const dir = join(root, "work-d")
    const fake = await connected(() =>
      startPlugin(dir, [
        { id: "ses_rot", directory: dir },
        { id: "ses_rot_child", parentID: "ses_rot", directory: dir },
      ]),
    )
    await me(fake).execute(
      { action: "register", id: "inproc:rot" },
      { sessionID: "ses_rot" },
    )
    await toolCall(fake, "shell", "ses_rot", "r1")
    await toolCall(fake, "shell", "ses_rot_child", "r2")
    const old = environments("ses_rot")[0]!.AUTOCODE_TOKEN
    expect(environments("ses_rot_child")[0]!.AUTOCODE_TOKEN).toBe(old)
    expect(
      (await call(t.url, t.admin, "POST", "/v1/agents/inproc:rot/token/rotate"))
        .status,
    ).toBe(200)
    await until(
      async () => {
        const rows = t.server.db
          .query(
            "SELECT acked_at, result FROM instructions WHERE type = 'token'",
          )
          .all() as any[]
        return rows.some((r) => r.acked_at && JSON.parse(r.result).ok)
      },
      { what: "the plugin to acknowledge the rotation" },
    )
    expect((await call(t.url, old!, "GET", "/v1/me")).status).toBe(401)
    // set again before the acknowledgement, for the session and its Subagent
    const fresh = environments("ses_rot").at(-1)!.AUTOCODE_TOKEN
    expect(fresh).not.toBe(old)
    expect(environments("ses_rot_child").at(-1)!.AUTOCODE_TOKEN).toBe(fresh)
    expect((await call(t.url, fresh!, "GET", "/v1/me")).body.agent.id).toBe(
      "inproc:rot",
    )
  })

  // The owner, 2026-11-05: a plugin reload or a deploy does not mint a new
  // session token; the one in OpenCode's plugin storage is used again.
  test("a reloaded plugin uses the session's stored token again; a dead one is replaced", async () => {
    const dir = join(root, "work-store")
    const sessions: Session[] = [{ id: "ses_keep", directory: dir }]
    const tokens = () =>
      (
        t.server.db
          .query(
            "SELECT COUNT(*) AS n FROM tokens WHERE session_id = 'ses_keep'",
          )
          .get() as { n: number }
      ).n
    const first = await connected(() => startPlugin(dir, sessions))
    await me(first).execute(
      { action: "register", id: "inproc:keep" },
      { sessionID: "ses_keep" },
    )
    expect(tokens()).toBe(1)
    // OpenCode loads the plugin again (an update, a reload)
    const again = await connected(() => startPlugin(dir, sessions))
    const out = await me(again).execute(
      { action: "status" },
      { sessionID: "ses_keep" },
    )
    expect(out.content).toContain("Registered as inproc:keep")
    expect(tokens()).toBe(1)
    // a stored token the server no longer takes is replaced once
    t.server.db
      .query("UPDATE tokens SET revoked_at = 1 WHERE session_id = 'ses_keep'")
      .run()
    const third = await connected(() => startPlugin(dir, sessions))
    const after = await me(third).execute(
      { action: "status" },
      { sessionID: "ses_keep" },
    )
    expect(after.content).toContain("Registered as inproc:keep")
    expect(tokens()).toBe(2)
  })

  test("hello says whether the plugin can set shell values; where it cannot, a shell call sets nothing", async () => {
    const hostAt = async (dir: string) =>
      (await call(t.url, t.admin, "GET", "/v1/hosts")).body.hosts.find(
        (h: any) => h.directory === dir,
      )
    const cases: [Started, string, boolean, string][] = [
      ["serve", "serve", true, "work-g1"],
      ["service", "service", true, "work-g2"],
      ["service-other-pid", "service", false, "work-g3"],
      ["standalone", "serve", false, "work-g4"],
      // its port answers, but as another OpenCode process: not this one's API
      ["serve-elsewhere", "serve", false, "work-g5"],
    ]
    for (const [how, kind, can, name] of cases) {
      const dir = join(root, name)
      const session = `ses_${name.replace("-", "_")}`
      const fake = await connected(() =>
        startPlugin(dir, [{ id: session, directory: dir }], how),
      )
      const host = await hostAt(dir)
      expect({
        how,
        kind: host?.process_kind,
        shell_values: host?.shell_values,
      }).toEqual({ how, kind, shell_values: can })
      await toolCall(fake, "shell", session, `${name}-1`)
      expect({ how, set: environments(session).length }).toEqual({
        how,
        set: can ? 1 : 0,
      })
    }
  })

  test("hello reports this folder's top-level sessions, and new ones are reported as they come", async () => {
    const dir = join(root, "work-e")
    const other = join(root, "elsewhere")
    const fake = await connected(() =>
      startPlugin(dir, [
        { id: "ses_listed", directory: dir },
        { id: "ses_sub", parentID: "ses_listed", directory: dir },
        { id: "ses_elsewhere", directory: other },
      ]),
    )
    const bind = (id: string, session: string) =>
      call(t.url, t.admin, "POST", "/v1/agents", { id, session })
    expect((await bind("inproc:listed", "ses_listed")).status).toBe(201)
    expect((await bind("inproc:sub", "ses_sub")).status).toBe(404)
    expect((await bind("inproc:elsewhere", "ses_elsewhere")).status).toBe(404)
    // OpenCode's event stream carries every folder's sessions; only this
    // folder's top-level ones are this host's
    const created = (
      sessionID: string,
      directory: string,
      parentID?: string,
    ) => ({
      type: "session.created",
      data: {
        sessionID,
        location: { directory },
        ...(parentID ? { parentID } : {}),
      },
    })
    fake.emit(created("ses_other_dir", other))
    fake.emit(created("ses_child_new", dir, "ses_listed"))
    fake.emit(created("ses_fresh", dir))
    await until(
      async () => (await bind("inproc:fresh", "ses_fresh")).status === 201,
      { what: "ses_fresh to be known" },
    )
    expect((await bind("inproc:other", "ses_other_dir")).status).toBe(404)
    expect((await bind("inproc:child", "ses_child_new")).status).toBe(404)
  })

  test("at hello, a session the server knows but OpenCode no longer has (core's not-found error) is reported gone", async () => {
    const dir = join(root, "work-f")
    const sessions: Session[] = [{ id: "ses_will_go", directory: dir }]
    const first = await connected(() => startPlugin(dir, sessions))
    await me(first).execute(
      { action: "register", id: "inproc:gone" },
      { sessionID: "ses_will_go" },
    )
    sessions.splice(0)
    // OpenCode restarts: a new instance of the same host says hello and checks
    // the server's list of its sessions
    await connected(() => startPlugin(dir, sessions))
    await until(
      async () =>
        (
          await call(t.url, t.admin, "GET", "/v1/history?kind=session.deleted")
        ).body.history.some((h: any) => h.session === "ses_will_go"),
      { what: "the gone session to be reported" },
    )
    expect(
      (await call(t.url, t.admin, "GET", "/v1/agents/inproc:gone")).body.agent
        .status,
    ).toBe("offline")
  })
})

/*
 * Tier 0b in the plugin: the server's instructions (inject, interrupt, check,
 * registration), turn events, the agent guide (the autocode skill and the line
 * for registered sessions), and the wake and message tools.
 */
describe("the plugin in-process, tier 0b", () => {
  const tool = (fake: Fake, name: string) =>
    fake.tools.find((x) => x.name === name)
  const hostOf = async (dir: string) =>
    (await call(t.url, t.admin, "GET", "/v1/hosts")).body.hosts.find(
      (h: any) => h.directory === dir && h.online,
    ).id as string
  // Sends an instruction to the plugin and waits for its acknowledgement.
  const instruct = async (host: string, type: string, payload: unknown) => {
    const id = t.server.enqueue(host, type, payload)
    return until(
      () => {
        const state = t.server.instruction(id)
        return state?.acked ? state : undefined
      },
      { timeoutMs: 15_000, what: `the plugin to answer ${type}` },
    )
  }
  const agentOf = async (id: string) =>
    (await call(t.url, t.admin, "GET", `/v1/agents/${id}`)).body.agent

  test("inject and interrupt reach the session; inject waits behind a running turn", async () => {
    const dir = join(root, "work-0b-inject")
    const fake = await connected(() =>
      startPlugin(dir, [{ id: "ses_inj", directory: dir }]),
    )
    const host = await hostOf(dir)
    const done = await instruct(host, "inject", {
      session: "ses_inj",
      prompt_id: "msg_0123456789abcdef01234567",
      text: '[autocode] wake "w"\n\nWake "w":\nGo.',
    })
    expect(done.ok).toBe(true)
    expect(fake.calls).toContainEqual({
      kind: "prompt",
      input: {
        sessionID: "ses_inj",
        id: "msg_0123456789abcdef01234567",
        text: '[autocode] wake "w"\n\nWake "w":\nGo.',
        delivery: "queue",
      },
    })
    // a steer goes into the running turn at its next step (the owner,
    // 2026-11-09)
    await instruct(host, "inject", {
      session: "ses_inj",
      prompt_id: "msg_0123456789abcdef01234568",
      text: "[autocode] 1 message, during your turn",
      delivery: "steer",
    })
    expect(fake.calls).toContainEqual({
      kind: "prompt",
      input: {
        sessionID: "ses_inj",
        id: "msg_0123456789abcdef01234568",
        text: "[autocode] 1 message, during your turn",
        delivery: "steer",
      },
    })
    await instruct(host, "interrupt", { session: "ses_inj" })
    expect(fake.calls).toContainEqual({
      kind: "interrupt",
      input: { sessionID: "ses_inj", resume: false },
    })
  })

  test("a check runs in the folder with the session's values, a time limit and an output limit", async () => {
    const dir = join(root, "work-0b-check")
    await connected(() => startPlugin(dir, [{ id: "ses_chk", directory: dir }]))
    const host = await hostOf(dir)
    const ran = await instruct(host, "check", {
      session: "ses_chk",
      directory: dir,
      command: 'echo "in $(pwd)"; echo "as $AUTOCODE_SESSION" >&2; exit 3',
      timeout_ms: 10_000,
      output_limit: 1000,
    })
    expect(ran.result).toEqual({
      exit: 3,
      output: `in ${dir}\nas ses_chk\n`,
      timed_out: false,
    })
    const started = Date.now()
    const slow = await instruct(host, "check", {
      session: "ses_chk",
      directory: dir,
      command: "echo started; sleep 30.4321 & sleep 30.4321",
      timeout_ms: 500,
      output_limit: 1000,
    })
    expect(slow.result).toMatchObject({ exit: null, timed_out: true })
    expect(Date.now() - started).toBeLessThan(10_000)
    // the time limit killed all of it, the background child too (Linux: the
    // command lines in /proc)
    const running = () =>
      readdirSync("/proc")
        .filter((d) => /^\d+$/.test(d))
        .some((d) => {
          try {
            return readFileSync(`/proc/${d}/cmdline`, "utf8").includes(
              "30.4321",
            )
          } catch {
            return false
          }
        })
    await until(() => !running(), { timeoutMs: 3000, what: "no sleep left" })
    // a child left in the background does not keep a finished check waiting
    const quick = Date.now()
    const done = await instruct(host, "check", {
      session: "ses_chk",
      directory: dir,
      command: "(sleep 5.4321 &); echo ok; exit 0",
      timeout_ms: 10_000,
      output_limit: 1000,
    })
    expect(done.result).toEqual({ exit: 0, output: "ok\n", timed_out: false })
    expect(Date.now() - quick).toBeLessThan(4000)
    const cut = await instruct(host, "check", {
      session: "ses_chk",
      directory: dir,
      command: "seq 1 1000",
      timeout_ms: 10_000,
      output_limit: 10,
    })
    expect(cut.result).toEqual({
      exit: 0,
      output: "1\n2\n3\n4\n5\n",
      timed_out: false,
    })
  })

  test("turn events of this folder's top-level sessions are reported; other folders' and Subagents' are not", async () => {
    const dir = join(root, "work-0b-turns")
    const other = join(root, "work-0b-elsewhere")
    const sessions: Session[] = [
      { id: "ses_turn", directory: dir },
      { id: "ses_turn_child", directory: dir, parentID: "ses_turn" },
      { id: "ses_turn_other", directory: other },
    ]
    const fake = await connected(() => startPlugin(dir, sessions))
    await tool(fake, "autocode_me").execute(
      { action: "register", id: "inproc:turns" },
      { sessionID: "ses_turn" },
    )
    const event = (type: string, session: string, at = dir, data = {}) => ({
      type,
      location: { directory: at },
      data: { sessionID: session, ...data },
    })
    fake.emit(event("session.execution.started", "ses_turn"))
    await until(
      async () => (await agentOf("inproc:turns")).status === "working",
      { what: "the agent to be working" },
    )
    // a Subagent's turn ending, and another folder's, change nothing
    fake.emit(event("session.execution.succeeded", "ses_turn_child"))
    fake.emit(event("session.execution.succeeded", "ses_turn_other", other))
    await Bun.sleep(500)
    expect((await agentOf("inproc:turns")).status).toBe("working")
    fake.emit(
      event("session.execution.failed", "ses_turn", dir, {
        error: { type: "rate_limit", message: "slow down" },
      }),
    )
    // a failed turn: the error state, with OpenCode's error type (tier 0b3)
    await until(
      async () => (await agentOf("inproc:turns")).status === "error",
      { what: "the agent to be in the error state" },
    )
    const failed = await agentOf("inproc:turns")
    expect(failed.last_outcome).toBe("failed")
    expect(failed.error.type).toBe("rate_limit")
  })

  test("the agent guide: the autocode skill for every session, the line only for registered ones and their Subagents", async () => {
    const dir = join(root, "work-0b-guide")
    const sessions: Session[] = [
      { id: "ses_guide", directory: dir },
      { id: "ses_guide_child", directory: dir, parentID: "ses_guide" },
      { id: "ses_guide_free", directory: dir },
    ]
    const fake = await connected(() => startPlugin(dir, sessions))
    const [skill, ...more] = fake.skills()
    expect(more).toEqual([])
    expect(skill).toMatchObject({ id: "autocode", name: "Autocode" })
    expect(skill.description).toContain("[autocode]")
    expect(skill.path).toMatch(/^\/.*SKILL\.md$/)
    expect(skill.content).toContain("`api-test`")
    for (const name of ["autocode_me", "autocode_wake", "autocode_message"])
      expect(skill.content).toContain(`\`${name}\``)
    const context = (session: string) => {
      const event = { sessionID: session, system: [] as any[], tools: {} }
      return fake.hooks["session.context"]!(event).then(() => event.system)
    }
    expect(await context("ses_guide")).toEqual([])
    await tool(fake, "autocode_me").execute(
      { action: "register", id: "inproc:guide" },
      { sessionID: "ses_guide" },
    )
    const line = {
      type: "text",
      text:
        "This session is Autocode agent `inproc:guide` on server `api-test`. " +
        "Use the `autocode_*` tools (not the `autocode` CLI); `autocode_me " +
        "action=help` or the `autocode` skill explains exactly how wakes and " +
        "messages work. Write to the owner briefly: only what they need, " +
        "the point first, in plain words.",
    }
    await until(async () => (await context("ses_guide")).length === 1, {
      what: "the registration to reach the plugin",
    })
    expect(await context("ses_guide")).toEqual([line])
    // the same guide through the tool, for agents that do not load skills
    const help = await tool(fake, "autocode_me").execute(
      { action: "help", topic: "wakes" },
      { sessionID: "ses_guide" },
    )
    expect(help.content).toStartWith("## Wakes")
    expect(await context("ses_guide_child")).toEqual([line])
    expect(await context("ses_guide_free")).toEqual([])
    await tool(fake, "autocode_me").execute(
      { action: "unregister" },
      { sessionID: "ses_guide" },
    )
    await until(async () => (await context("ses_guide")).length === 0, {
      what: "the unregistration to reach the plugin",
    })
  })

  test("the wake and message tools (text messages only)", async () => {
    const dir = join(root, "work-0b-tools")
    const fake = await connected(() =>
      startPlugin(dir, [
        { id: "ses_tool_a", directory: dir },
        { id: "ses_tool_b", directory: dir },
      ]),
    )
    const run = async (name: string, input: any, session: string) =>
      (await tool(fake, name).execute(input, { sessionID: session })).content
    await run(
      "autocode_me",
      { action: "register", id: "tools:a" },
      "ses_tool_a",
    )
    await run(
      "autocode_me",
      { action: "register", id: "tools:b" },
      "ses_tool_b",
    )
    expect(
      await run(
        "autocode_wake",
        { action: "set", name: "daily", trigger: "every 1h", text: "Look." },
        "ses_tool_a",
      ),
    ).toMatch(
      new RegExp(
        '^Wake "daily" set: every 1h\\. ' +
          "Next run [\\d-]{10} \\d\\d:\\d\\d \\S+ \\(in 1h\\)\\.",
      ),
    )
    expect(
      await run("autocode_wake", { action: "list" }, "ses_tool_a"),
    ).toContain("daily: every 1h; next ")
    expect(
      await run(
        "autocode_wake",
        { action: "fire", agent: "tools:a", name: "daily", text: "now" },
        "ses_tool_b",
      ),
    ).toBe('Fired wake "daily" of tools:a: it comes when that session is idle.')
    // text only (the owner, 2026-11-07): no file, no path
    expect(
      await run(
        "autocode_message",
        { action: "send", to: "tools:b", subject: "plot", text: "see it" },
        "ses_tool_a",
      ),
    ).toMatch(/^Sent to tools:b \(m_\w+\)\.$/)
    // the owner, 2026-11-09: list and read are back
    expect(
      await run("autocode_message", { action: "list" }, "ses_tool_b"),
    ).toMatch(
      /^Waiting: m_\w+ from agent tools:a, subject "plot", 6 characters\./,
    )
    expect(
      await run("autocode_message", { action: "read" }, "ses_tool_b"),
    ).toMatch(/^Message m_\w+ from agent tools:a, subject "plot":\n> see it$/)
    expect(
      await run("autocode_message", { action: "list" }, "ses_tool_b"),
    ).toBe("No messages wait for you.")
    expect(
      await run(
        "autocode_message",
        { action: "send", to: "tools:b", file: "notes.txt" },
        "ses_tool_a",
      ),
    ).toBe("error: send needs text")
  })
})
