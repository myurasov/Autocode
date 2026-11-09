/*
 * The agents suite (tier 0b2): real models in real OpenCode sessions must use
 * Autocode correctly in common cases, from a plain request: register; set a
 * reminder and act on it; poll in work hours with a check; have a background
 * job wake them; run a loop spaced from the end of each run; ask the owner and
 * follow the answer; answer another agent's question (tier 0d); ask for an
 * approval and follow it (tier 0d); ask another agent and act on the reply
 * that comes in a prompt after its turn (Phase 1). With the tools, never the
 * CLI (but in a job's own command) or the API, and without reading the
 * plugin's code.
 *
 * Runs on the host, not in Docker: the provider's key is in the owner's
 * OpenCode config. An Autocode server from the source on a scratch data
 * folder, and an `opencode serve` with a scratch HOME, config (the provider
 * block copied there, 0600), data and state folders, the plugin and an
 * `autocode` shim from the source; the models' shells and the checks run with
 * that HOME and a short environment. The scratch folders (the copy of the
 * key with them) are deleted at the end, on SIGTERM and SIGINT too. Model and
 * scenario pairs run in parallel; the summary and results.json go to --out.
 *
 *   bun ci/agents/run.ts --out DIR [--models a,b] [--scenarios x,y]
 *     [--concurrency 12] [--turn-minutes 8]
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { misuseOf, readJsonc } from "./checks.ts"
import { workHours } from "./schedule.ts"

const root = resolve(import.meta.dir, "../..")
const { values: opt } = parseArgs({
  options: {
    out: { type: "string" },
    models: { type: "string" },
    scenarios: { type: "string" },
    concurrency: { type: "string", default: "12" },
    "turn-minutes": { type: "string", default: "8" },
  },
})
const out = resolve(opt.out ?? join(root, "__out", "agents"))
mkdirSync(out, { recursive: true })
const turnMs = Number(opt["turn-minutes"]) * 60_000
const list = (text: string | undefined) =>
  (text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

interface ModelDef {
  name: string
  model: string
  variant?: string
}
const wantModels = list(opt.models ?? process.env.AGENT_MODELS)
const models = (
  JSON.parse(readFileSync(join(root, "ci/agents/models.json"), "utf8"))
    .models as ModelDef[]
).filter((m) => !wantModels.length || wantModels.includes(m.name))

const runLog = join(out, "run.log")
function log(line: string) {
  const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`
  console.log(stamped)
  writeFileSync(runLog, `${stamped}\n`, { flag: "a" })
}

// The environment without this session's own OpenCode and Autocode values.
// A short environment: the owner's locale, terminal and way to the network
// (proxies, certificates), nothing else of it (no keys, tokens or sockets),
// plus `extra`.
const KEPT = new RegExp(
  "^(LANG|LC_\\w+|TERM|TZ|USER|LOGNAME|(https?|no|all)_proxy|" +
    "(HTTPS?|NO|ALL)_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_(FILE|DIR))$",
)

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && KEPT.test(k)) env[k] = v
  return { ...env, ...extra }
}

function freePort(): number {
  const s = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  })
  const port = s.port
  s.stop(true)
  return port
}

async function http(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<any> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  })
  const text = await res.text()
  let body: any = text
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {}
  if (!res.ok)
    throw new Error(`${init.method ?? "GET"} ${url}: ${res.status} ${text}`)
  return body && typeof body === "object" && "data" in body ? body.data : body
}

async function until<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v as T
    } catch (err) {
      last = err
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ""}`)
    await Bun.sleep(1000)
  }
}

// --- the isolated Autocode server and OpenCode -----------------------------

const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)
const tmp = `/tmp/opencode/agents-ci-${runId}`
const dirs = {
  server: join(tmp, "server"),
  home: join(tmp, "home"),
  config: join(tmp, "config"),
  xdgConfig: join(tmp, "xdg-config"),
  data: join(tmp, "data"),
  state: join(tmp, "state"),
  bin: join(tmp, "bin"),
  work: join(tmp, "work"),
  // HOME for OpenCode, the models' shells and the checks: not the owner's
  user: join(tmp, "user"),
}
for (const d of [tmp, ...Object.values(dirs)])
  mkdirSync(d, { recursive: true, mode: 0o700 })
// where ci/run.sh finds the scratch folder if this run is killed
if (process.env.AGENTS_SCRATCH_NOTE)
  writeFileSync(process.env.AGENTS_SCRATCH_NOTE, tmp)
const bun = process.execPath
const main = join(root, "packages/cli/src/main.ts")
const PATH = [
  dirs.bin,
  dirname(bun),
  join(homedir(), ".opencode/bin"),
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":")
writeFileSync(
  join(dirs.bin, "autocode"),
  `#!/bin/sh\nexec ${bun} ${main} "$@"\n`,
)
chmodSync(join(dirs.bin, "autocode"), 0o755)

const procs: ReturnType<typeof Bun.spawn>[] = []
function stop() {
  for (const p of procs) p.kill()
}

// The owner's OpenCode config: only the provider block the models need, the
// permission settings (nothing may stop to ask), never logged.
function opencodeConfig(): unknown {
  const file = join(homedir(), ".config/opencode/opencode.jsonc")
  const owner = readJsonc(readFileSync(file, "utf8"))
  const providers = new Set(models.map((m) => m.model.split("/")[0]!))
  const provider: Record<string, unknown> = {}
  for (const p of providers)
    if (owner.provider?.[p]) provider[p] = owner.provider[p]
    else throw new Error(`the owner's OpenCode config has no provider ${p}`)
  return {
    $schema: "https://opencode.ai/config.json",
    model: models[0]?.model,
    update: "disable",
    share: "disabled",
    provider,
    ...(owner.yolo !== undefined ? { yolo: owner.yolo } : {}),
    ...(owner.permissions ? { permissions: owner.permissions } : {}),
  }
}

let aurl = ""
let admin = ""
let ocUrl = ""
let ocAuth = ""

async function start() {
  log(`generating the plugin bundle`)
  const gen = Bun.spawnSync([bun, join(root, "packages/cli/build.ts")], {
    cwd: root,
    env: cleanEnv({ PATH }),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (gen.exitCode !== 0)
    throw new Error(`build.ts failed: ${gen.stderr.toString().slice(-500)}`)

  const aport = freePort()
  aurl = `http://127.0.0.1:${aport}`
  log(`Autocode server at ${aurl}`)
  procs.push(
    Bun.spawn(
      [bun, main, "serve", "--listen", `127.0.0.1:${aport}`, "--id"].concat([
        "agents-ci",
        "--data",
        dirs.server,
      ]),
      {
        cwd: root,
        env: cleanEnv({ PATH, HOME: homedir() }),
        stdout: Bun.file(join(out, "server.out.log")),
        stderr: Bun.file(join(out, "server.err.log")),
      },
    ),
  )
  await until(() => http(`${aurl}/v1/info`), 60_000, "the Autocode server")
  admin = readFileSync(join(dirs.server, "admin.token"), "utf8").trim()

  const install = Bun.spawnSync(
    [bun, main, "plugin", "install", "--url", aurl, "--consumer-token-file"]
      .concat([join(dirs.server, "consumer.token"), "--server-id"])
      .concat(["agents-ci", "--opencode-config-dir", dirs.config]),
    {
      cwd: root,
      env: cleanEnv({ PATH, HOME: homedir(), AUTOCODE_HOME: dirs.home }),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (install.exitCode !== 0)
    throw new Error(`plugin install: ${install.stderr.toString().slice(-500)}`)
  const cfg = join(dirs.config, "opencode.json")
  writeFileSync(cfg, JSON.stringify(opencodeConfig(), null, 2), {
    mode: 0o600,
  })
  chmodSync(cfg, 0o600)

  const oport = freePort()
  const password = crypto.randomUUID()
  ocUrl = `http://127.0.0.1:${oport}`
  ocAuth = `Basic ${btoa(`opencode:${password}`)}`
  log(`OpenCode at ${ocUrl}`)
  procs.push(
    Bun.spawn(
      [join(homedir(), ".opencode/bin/opencode"), "serve", "--hostname"].concat(
        ["127.0.0.1", "--port", String(oport)],
      ),
      {
        cwd: dirs.work,
        env: cleanEnv({
          PATH,
          HOME: dirs.user,
          OPENCODE_CONFIG_DIR: dirs.config,
          XDG_CONFIG_HOME: dirs.xdgConfig,
          XDG_DATA_HOME: dirs.data,
          XDG_STATE_HOME: dirs.state,
          OPENCODE_PASSWORD: password,
          AUTOCODE_HOME: dirs.home,
        }),
        stdout: Bun.file(join(out, "opencode.out.log")),
        stderr: Bun.file(join(out, "opencode.err.log")),
      },
    ),
  )
  await until(() => oc("GET", "/api/info"), 90_000, "OpenCode")
}

const oc = (method: string, path: string, body?: unknown) =>
  http(`${ocUrl}${path}`, {
    method,
    headers: {
      authorization: ocAuth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const ac = (method: string, path: string, body?: unknown) =>
  http(`${aurl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${admin}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

// --- sessions and turns ----------------------------------------------------

interface Ctx {
  m: ModelDef
  scenario: string
  id: string
  dir: string
  session: string
  // other sessions the scenario made (their cost and transcript count too)
  others?: Ctx[]
}

async function prepare(m: ModelDef, scenario: string): Promise<Ctx> {
  const dir = join(dirs.work, m.name, scenario)
  mkdirSync(dir, { recursive: true })
  const where = new URLSearchParams({ "location[directory]": dir })
  await oc("GET", `/api/location?${where}`)
  await until(
    async () =>
      (await ac("GET", "/v1/hosts")).hosts.find(
        (h: any) => h.directory === dir && h.online,
      ),
    90_000,
    `the plugin in ${dir}`,
  )
  const [providerID, ...rest] = m.model.split("/")
  const s = await oc("POST", "/api/session", {
    location: { directory: dir },
    model: {
      providerID,
      id: rest.join("/"),
      ...(m.variant ? { variant: m.variant } : {}),
    },
    title: `agents-ci ${m.name} ${scenario}`,
  })
  return { m, scenario, id: `ci:${m.name}:${scenario}`, dir, session: s.id }
}

const session = (ctx: Ctx) => oc("GET", `/api/session/${ctx.session}`)
const idleTime = async (ctx: Ctx) =>
  Number((await session(ctx))?.time?.idle ?? 0)

// Waits until the session has finished a turn that ended after `since`.
async function idleAfter(ctx: Ctx, since: number, what: string) {
  return until(
    async () => {
      const s = await session(ctx)
      return s?.time?.idle && s.time.idle > since && s.outcome ? s : undefined
    },
    turnMs,
    `${what} (${ctx.m.name} ${ctx.scenario})`,
  )
}

async function turn(ctx: Ctx, text: string) {
  const before = await idleTime(ctx)
  await oc("POST", `/api/session/${ctx.session}/prompt`, { text })
  return idleAfter(ctx, before, "the turn")
}

// The session's messages, oldest first (the API lists the newest first).
async function messages(ctx: Ctx): Promise<any[]> {
  const res = await oc("GET", `/api/session/${ctx.session}/message`)
  const all: any[] = Array.isArray(res)
    ? res
    : (res?.items ?? res?.messages ?? [])
  return [...all].sort(
    (a, b) => Number(a.time?.created ?? 0) - Number(b.time?.created ?? 0),
  )
}

// The tool calls of the session: [name, input].
async function toolCalls(ctx: Ctx): Promise<[string, any][]> {
  const calls: [string, any][] = []
  for (const m of await messages(ctx))
    for (const p of m.content ?? [])
      if (p?.type === "tool") calls.push([p.name, p.state?.input ?? {}])
  return calls
}

// What the agent wrote in the turns that started after `since`.
async function textSince(ctx: Ctx, since: number): Promise<string> {
  return (await messages(ctx))
    .filter(
      (m) => m.type === "assistant" && Number(m.time?.created ?? 0) > since,
    )
    .flatMap((m) => m.content ?? [])
    .filter((p: any) => p?.type === "text")
    .map((p: any) => p.text)
    .join("\n")
}

// A short transcript of the session, for reading a failure afterwards.
async function transcript(ctx: Ctx): Promise<string> {
  const lines: string[] = []
  const cut = (text: string, n: number) =>
    text.length > n ? `${text.slice(0, n)}…` : text
  for (const m of await messages(ctx).catch(() => [])) {
    for (const p of m.content ?? []) {
      if (p?.type === "text")
        lines.push(`[${m.type}] ${cut(String(p.text), 2000)}`)
      else if (p?.type === "tool") {
        const output = (p.state?.content ?? [])
          .map((c: any) => c?.text ?? "")
          .join("")
        lines.push(
          `[tool ${p.name}] ${cut(JSON.stringify(p.state?.input ?? {}), 600)}`,
          `  -> ${cut(output, 400)}`,
        )
      }
    }
  }
  return `${lines.join("\n")}\n`
}

/*
 * What the agent ran in its shells that it should have done with a tool: the
 * `autocode` CLI (a background job's `autocode fire` is allowed when asked
 * for), or reading the plugin's code.
 */
async function misuse(ctx: Ctx, allowFire = false): Promise<string | null> {
  return misuseOf(await toolCalls(ctx), allowFire)
}

const wakesOf = async (ctx: Ctx): Promise<any[]> =>
  (await ac("GET", `/v1/agents/${encodeURIComponent(ctx.id)}/wakes`)).wakes
const wakeList = (wakes: any[]) =>
  wakes.map((w) => `${w.name} (${w.trigger})`).join(", ") || "none"
const file = (ctx: Ctx, name: string) => join(ctx.dir, name)
const read = (ctx: Ctx, name: string) =>
  existsSync(file(ctx, name)) ? readFileSync(file(ctx, name), "utf8") : null

const register = (ctx: Ctx) =>
  `Register this session with Autocode as the agent \`${ctx.id}\` ` +
  "(one-line description: CI check agent). Then"

// --- the scenarios ---------------------------------------------------------

type Outcome = string | null // null: passed; else why it failed

const MIN = 60_000

const SCENARIOS: Record<string, (ctx: Ctx) => Promise<Outcome>> = {
  async register(ctx) {
    await turn(
      ctx,
      `Register this session with Autocode as the agent \`${ctx.id}\`, ` +
        "with a one-line description saying that you are a CI check agent. " +
        "Then tell me in one sentence what your Autocode status is.",
    )
    const agent = await ac("GET", `/v1/agents/${encodeURIComponent(ctx.id)}`)
      .then((r) => r.agent)
      .catch(() => null)
    if (!agent) return `not registered as ${ctx.id}`
    if (!agent.description) return "registered without a description"
    return misuse(ctx)
  },

  async reminder(ctx) {
    const t0 = Date.now()
    await turn(
      ctx,
      `${register(ctx)} use Autocode to remind yourself in 10 minutes to ` +
        "write the word PONG into the file reminder.txt in this folder. Do " +
        "not write the file now.",
    )
    const t1 = Date.now()
    const wakes = await wakesOf(ctx)
    const w = wakes.find((x) => {
      const due = x.due ? Date.parse(x.due) : 0
      return due >= t0 + 8 * MIN && due <= t1 + 12 * MIN
    })
    if (!w) return `no wake due in about 10 minutes (${wakeList(wakes)})`
    if (read(ctx, "reminder.txt") !== null)
      return "wrote the file before the reminder"
    const used = await misuse(ctx)
    if (used) return used
    const before = await idleTime(ctx)
    await ac(
      "POST",
      `/v1/agents/${encodeURIComponent(ctx.id)}/wakes/` +
        `${encodeURIComponent(w.name)}/fire`,
    )
    await idleAfter(ctx, before, "the reminder's turn")
    if (!/PONG/.test(read(ctx, "reminder.txt") ?? ""))
      return "did not act on the reminder (no PONG in reminder.txt)"
    return misuse(ctx)
  },

  async polling(ctx) {
    mkdirSync(file(ctx, "incoming"), { recursive: true })
    await turn(
      ctx,
      `${register(ctx)} set up Autocode so that you are woken every 30 ` +
        "minutes on weekdays between 09:00 and 17:00 Pacific time " +
        "(America/Los_Angeles) to process the new files that arrive in the " +
        "incoming/ folder here (move each processed file to done/), but " +
        "only when there are new files: do not get woken when there is " +
        "nothing new. Set it up now; there are no files yet.",
    )
    // the agent may split the schedule over several wakes: all of them
    // together must keep to work hours, and each must have a check
    const wakes = await wakesOf(ctx)
    if (!wakes.length) return "no wake"
    const unchecked = wakes.filter((x) => !x.check)
    if (unchecked.length)
      return (
        `no check on ${unchecked.map((x) => x.name).join(", ")}: it would ` +
        "wake you for nothing"
      )
    const schedule = workHours(wakes.map((x) => x.trigger))
    if (schedule) return schedule
    // each check: exit 1 with nothing new, exit 0 with a new file, no changes
    const run = (cmd: string) =>
      Bun.spawnSync(["bash", "-c", cmd], {
        cwd: ctx.dir,
        env: cleanEnv({ PATH, HOME: dirs.user }),
        timeout: 30_000,
      }).exitCode
    const added = file(ctx, "incoming/new.csv")
    for (const w of wakes) {
      rmSync(added, { force: true })
      const empty = run(w.check)
      if (empty !== 1)
        return `${w.name}'s check exits ${empty} with no new files, not 1`
      writeFileSync(added, "a,b\n1,2\n")
      const full = run(w.check)
      if (full !== 0)
        return `${w.name}'s check exits ${full} with a new file, not 0`
      if (!existsSync(added))
        return (
          `${w.name}'s check moved or deleted the file ` +
          "(a check must not act)"
        )
    }
    return misuse(ctx)
  },

  async job(ctx) {
    await turn(
      ctx,
      `${register(ctx)} start this command as a background job in this ` +
        "folder and do not wait for it: `sleep 20; echo finished > job.txt`. " +
        "Have Autocode wake you when the job ends (no polling and no fixed " +
        "schedule); when you are woken, tell me what job.txt says.",
    )
    const wakes = await wakesOf(ctx)
    const w = wakes.find((x) => x.trigger === "fire-only")
    if (!w) return `no fire-only wake (${wakeList(wakes)})`
    const setupEnded = Date.now()
    let fired: any
    try {
      fired = await until(
        async () =>
          (
            await ac(
              "GET",
              `/v1/history?kind=wake.fired&agent=${encodeURIComponent(ctx.id)}`,
            )
          ).history.find(
            (h: any) => h.data?.name === w.name && h.data?.by === ctx.id,
          ),
        3 * MIN,
        "the job to fire the wake",
      )
    } catch {
      return "the job did not fire the wake (autocode fire me ...)"
    }
    // the turn Autocode's prompt starts (OpenCode's own background shell may
    // wake the session first, when the job's command ends); a job shorter
    // than the setup turn fires during it, and its prompt comes as that turn
    // ends: so from the fire, not from the end of the setup
    const firedAt = Date.parse(fired.at)
    let sent: any
    try {
      sent = await until(
        async () =>
          (
            await ac(
              "GET",
              "/v1/history?kind=injection.sent&agent=" +
                encodeURIComponent(ctx.id),
            )
          ).history.find((h: any) => Date.parse(h.at) >= firedAt),
        turnMs,
        "Autocode's prompt for the wake",
      )
    } catch {
      return "the wake fired, but its prompt was never sent"
    }
    // the turn that prompt started: it ends after the prompt was sent
    await idleAfter(ctx, Date.parse(sent.at), "the woken turn")
    // the job itself must fire the wake: its own command, not a later check
    const shells = (await toolCalls(ctx))
      .filter(([name]) => name === "shell" || name === "bash")
      .map(([, input]) => String(input.command ?? ""))
    const fires = /(?<![\w.-])autocode\s+fire\b/
    if (!shells.some((c) => /sleep 20/.test(c) && fires.test(c)))
      return "the job's command does not fire the wake (no autocode fire in it)"
    if (shells.some((c) => fires.test(c) && !/sleep 20/.test(c)))
      return "fired the wake by hand instead of from the job"
    if (!/finished/i.test(await textSince(ctx, Math.min(setupEnded, firedAt))))
      return "woken, but did not report what job.txt says"
    return misuse(ctx, true)
  },

  async loop(ctx) {
    await turn(
      ctx,
      `${register(ctx)} set up this loop with Autocode: each time you are ` +
        "woken for it, append one line `tick` to ticks.txt in this folder; " +
        "the next run must come 20 minutes after you finished the previous " +
        "one, not on a fixed clock schedule. Set it up now; do not append " +
        "anything yet.",
    )
    const now = Date.now()
    const wakes = await wakesOf(ctx)
    const once = (x: any, from: number) => {
      const due = x.due ? Date.parse(x.due) : 0
      return (
        x.trigger.startsWith("at ") &&
        due >= from + 15 * MIN &&
        due <= from + 25 * MIN
      )
    }
    const idle = (x: any) => /^idle 20m( repeat)?$/.test(x.trigger)
    const w = wakes.find((x) => idle(x) || once(x, now - 5 * MIN))
    if (!w) return `no wake for a spaced loop (${wakeList(wakes)})`
    if (read(ctx, "ticks.txt") !== null) return "appended before a run"
    const used = await misuse(ctx)
    if (used) return used
    const firedAt = Date.now()
    const before = await idleTime(ctx)
    await ac(
      "POST",
      `/v1/agents/${encodeURIComponent(ctx.id)}/wakes/` +
        `${encodeURIComponent(w.name)}/fire`,
    )
    await idleAfter(ctx, before, "the loop's run")
    const ticks = (read(ctx, "ticks.txt") ?? "")
      .split("\n")
      .filter((l) => l.trim() === "tick")
    if (ticks.length !== 1) return `${ticks.length} tick lines after one run`
    if (!idle(w)) {
      const ended = Date.now()
      const next = (await wakesOf(ctx)).find(
        (x) => once(x, ended) && Date.parse(x.updated_at) >= firedAt,
      )
      if (!next) return "did not set the next run after this one"
    }
    return misuse(ctx)
  },

  async owner(ctx) {
    mkdirSync(file(ctx, "old-logs"), { recursive: true })
    for (const name of ["a.log", "b.log"])
      writeFileSync(file(ctx, `old-logs/${name}`), "old\n")
    const before = await idleTime(ctx)
    await oc("POST", `/api/session/${ctx.session}/prompt`, {
      text:
        `${register(ctx)} ask the owner, through Autocode, whether you may ` +
        "delete the files in old-logs/ here. Do not delete anything until " +
        "the owner answers; when the answer comes, follow it.",
    })
    let item: any
    try {
      item = await until(
        async () =>
          (await ac("GET", "/v1/inbox")).items.find(
            (i: any) => i.agent === ctx.id,
          ),
        turnMs,
        "a question in the inbox",
      )
    } catch {
      await idleAfter(ctx, before, "the turn").catch(() => {})
      return "no question in the owner's inbox"
    }
    if (readdirSync(file(ctx, "old-logs")).length !== 2)
      return "deleted files before the answer"
    // the owner answers as soon as the question is there: the agent may be
    // waiting for it in its turn, or have ended the turn
    await ac("POST", `/v1/inbox/${item.id}/answer`, {
      text: "Yes, you may delete them.",
    })
    const logs = () =>
      existsSync(file(ctx, "old-logs"))
        ? readdirSync(file(ctx, "old-logs")).filter((n) => n.endsWith(".log"))
        : []
    try {
      await until(async () => logs().length === 0, turnMs, "the deletion")
    } catch {
      return `did not follow the answer (${logs().join(", ")})`
    }
    await idleAfter(ctx, before, "the turn after the answer").catch(() => {})
    return misuse(ctx)
  },

  /*
   * Tier 0d: a question of another agent is sent to this one (question_mode
   * agent:<id>). The asker is a second session of the same model that asks
   * with OpenCode's question tool (a real form, reported by the plugin);
   * this agent answers from its notes with autocode_message action=answer,
   * and the asker's turn goes on with that answer.
   */
  async answerer(ctx) {
    writeFileSync(
      file(ctx, "NOTES.md"),
      "Fold splits: always use folds v3 (v2 has a leak).\n",
    )
    await turn(
      ctx,
      `${register(ctx)} end your turn: other agents' questions may be sent ` +
        "to you later, as prompts of their own. NOTES.md here has what you " +
        "need to answer them.",
    )
    const asker: Ctx = {
      ...(await prepare(ctx.m, `${ctx.scenario}-asker`)),
    }
    ctx.others = [...(ctx.others ?? []), asker]
    await turn(asker, `${register(asker)} say ready; nothing else for now.`)
    await ac("PATCH", "/v1/settings", {
      agents: { [asker.id]: { question_mode: `agent:${ctx.id}` } },
    })
    const before = await idleTime(asker)
    await oc("POST", `/api/session/${asker.session}/prompt`, {
      text:
        "Use your question tool now to ask which fold split to train on, " +
        "with the options v3 and v2. When you have the answer, write it " +
        "alone into choice.txt in this folder.",
    })
    let ask: any
    try {
      ask = await until(
        async () => {
          const all = (await ac("GET", "/v1/inbox?all=1")).items
          const a = all.find(
            (i: any) => i.agent === asker.id && i.kind === "question",
          )
          return a && a.state !== "open" ? a : undefined
        },
        turnMs * 2,
        "the answer to the asker's question",
      )
    } catch {
      const open = (await ac("GET", "/v1/inbox")).items.find(
        (i: any) => i.agent === asker.id,
      )
      return open
        ? "did not answer the question sent to it"
        : "the asker did not use the question tool"
    }
    await idleAfter(asker, before, "the asker's turn").catch(() => {})
    await ac("DELETE", `/v1/agents/${encodeURIComponent(asker.id)}`).catch(
      () => {},
    )
    if (ask.by !== ctx.id) return `answered by ${ask.by}, not the agent`
    const given = JSON.stringify(ask.answer ?? {})
    if (!/v3/.test(given)) return `answered ${given}, not v3 (see NOTES.md)`
    return misuse(ctx)
  },

  /*
   * Phase 1 (the owner, 2026-11-08): a message comes only in a prompt. The
   * agent asks another agent (a second session of the same model, which only
   * registers, then is paused) and must end its turn to get the reply; the
   * owner answers for it, as a reply to that message, which comes in a prompt
   * that wakes the agent, and it writes the answer down.
   */
  async reply(ctx) {
    const peer: Ctx = { ...(await prepare(ctx.m, `${ctx.scenario}-peer`)) }
    ctx.others = [...(ctx.others ?? []), peer]
    await turn(peer, `${register(peer)} say ready; nothing else for now.`)
    // the peer's own turns do nothing; its reply is the owner's
    await ac("POST", `/v1/agents/${encodeURIComponent(peer.id)}/pause`)
    const before = await idleTime(ctx)
    await oc("POST", `/api/session/${ctx.session}/prompt`, {
      text:
        `${register(ctx)} ask the agent \`${peer.id}\`, with an Autocode ` +
        "message, which learning rate to use. When its answer comes, " +
        "write the rate alone into rate.txt in this folder.",
    })
    const asked = await until(
      async () =>
        (
          await ac("GET", `/v1/messages?agent=${encodeURIComponent(peer.id)}`)
        ).messages.find((m: any) => m.from === ctx.id),
      turnMs,
      "the message to the peer",
    ).catch(() => undefined)
    if (!asked) return `sent no message to ${peer.id}`
    await idleAfter(ctx, before, "the asking turn").catch(() => {})
    if (read(ctx, "rate.txt") !== null)
      return "wrote rate.txt before the answer came"
    const waited = await idleTime(ctx)
    await ac("POST", "/v1/messages", {
      to: ctx.id,
      text: `Answering for ${peer.id}: use 0.003.`,
      reply_to: asked.id,
    })
    await idleAfter(ctx, waited, "the turn the reply started")
    await ac("DELETE", `/v1/agents/${encodeURIComponent(peer.id)}`).catch(
      () => {},
    )
    const rate = (read(ctx, "rate.txt") ?? "").trim()
    if (!/^0?\.003$/.test(rate))
      return `rate.txt has ${JSON.stringify(rate)}, not 0.003`
    return misuse(ctx)
  },

  // Tier 0d: a risky step asked as an approval, done only once approved.
  async approval(ctx) {
    const before = await idleTime(ctx)
    await oc("POST", `/api/session/${ctx.session}/prompt`, {
      text:
        `${register(ctx)} get the owner's approval through Autocode before ` +
        "you create a file deploy.txt here with the word deployed (it " +
        "stands for a production deployment). Do not create it unless it " +
        "is approved; once you learn the answer, act on it.",
    })
    let item: any
    try {
      item = await until(
        async () =>
          (await ac("GET", "/v1/inbox")).items.find(
            (i: any) => i.agent === ctx.id && i.kind === "approval",
          ),
        turnMs,
        "an approval in the inbox",
      )
    } catch {
      await idleAfter(ctx, before, "the turn").catch(() => {})
      return "no approval in the owner's inbox (autocode_approval ask)"
    }
    if (read(ctx, "deploy.txt") !== null)
      return "created deploy.txt before the approval"
    await ac("POST", `/v1/asks/${item.id}/answer`, {
      decision: "approve",
      text: "go ahead",
    })
    try {
      await until(
        async () => /deployed/.test(read(ctx, "deploy.txt") ?? ""),
        turnMs * 2,
        "deploy.txt after the approval",
      )
    } catch {
      return "did not act on the approval"
    }
    await idleAfter(ctx, before, "the turn after the approval").catch(() => {})
    return misuse(ctx)
  },
}

// --- running them -----------------------------------------------------------

interface Result {
  model: string
  scenario: string
  ok: boolean
  reason: string | null
  seconds: number
  cost: number
  session: string | null
}

async function runOne(m: ModelDef, scenario: string): Promise<Result> {
  const started = Date.now()
  let ctx: Ctx | undefined
  let reason: string | null
  try {
    ctx = await prepare(m, scenario)
    reason = await SCENARIOS[scenario]!(ctx)
  } catch (err) {
    reason = `error: ${(err as Error).message.slice(0, 300)}`
  }
  let cost = 0
  if (ctx) {
    mkdirSync(join(out, "transcripts"), { recursive: true })
    // the scenario's own session and the others it made (an asker)
    for (const c of [ctx, ...(ctx.others ?? [])]) {
      cost += Number((await session(c).catch(() => ({})))?.cost ?? 0) || 0
      writeFileSync(
        join(out, "transcripts", `${m.name}-${c.scenario}.txt`),
        await transcript(c).catch((e) => `no transcript: ${e}\n`),
      )
    }
  }
  const r: Result = {
    model: m.name,
    scenario,
    ok: reason === null,
    reason,
    seconds: Math.round((Date.now() - started) / 1000),
    cost,
    session: ctx?.session ?? null,
  }
  log(
    `${r.ok ? "pass" : "FAIL"} ${m.name} ${scenario} ${r.seconds}s ` +
      `$${cost.toFixed(4)}${reason ? `: ${reason}` : ""}`,
  )
  return r
}

async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i]!)
      }
    }),
  )
  return results
}

async function main_() {
  const wantScenarios = list(opt.scenarios ?? process.env.AGENT_SCENARIOS)
  const scenarios = Object.keys(SCENARIOS).filter(
    (s) => !wantScenarios.length || wantScenarios.includes(s),
  )
  if (!models.length || !scenarios.length)
    throw new Error("no models or no scenarios to run")
  log(
    `models: ${models.map((m) => m.name).join(", ")}; ` +
      `scenarios: ${scenarios.join(", ")}`,
  )
  await start()
  const pairs = models.flatMap((m) => scenarios.map((s) => ({ m, s })))
  const results = await pool(pairs, Number(opt.concurrency) || 12, (p) =>
    runOne(p.m, p.s),
  )
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2))
  const passed = results.filter((r) => r.ok).length
  const spend = results.reduce((sum, r) => sum + r.cost, 0)
  console.log("")
  for (const m of models) {
    const mine = results.filter((r) => r.model === m.name)
    console.log(
      `${m.name.padEnd(10)} ${mine.filter((r) => r.ok).length}/` +
        `${mine.length}  $${mine
          .reduce((s, r) => s + r.cost, 0)
          .toFixed(4)}  ${mine
          .filter((r) => !r.ok)
          .map((r) => r.scenario)
          .join(" ")}`,
    )
  }
  console.log(
    `agents: ${passed} pass, ${results.length - passed} fail; ` +
      `spend $${spend.toFixed(4)}`,
  )
  return passed === results.length ? 0 : 1
}

// The processes stop and the scratch folders go (the copy of the provider's
// key with them): at the end, and when ci/run.sh's timeout or a ^C stops
// the run (`finally` does not run then).
function cleanUp() {
  stop()
  rmSync(tmp, { recursive: true, force: true })
  if (process.env.AGENTS_SCRATCH_NOTE)
    rmSync(process.env.AGENTS_SCRATCH_NOTE, { force: true })
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => {
    log(`stopped by ${signal}; cleaning up`)
    cleanUp()
    process.exit(130)
  })

let code = 1
try {
  code = await main_()
} catch (err) {
  log(`error: ${(err as Error).message}`)
} finally {
  cleanUp()
}
process.exit(code)
