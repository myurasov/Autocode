/*
 * Live check, tier 0a: a real model in a real OpenCode session registers with
 * autocode_me against a server on another machine, is seen there, and stays
 * registered after that server restarts. Runs with Bun on the machine of the
 * OpenCode session (not in CI); prints one JSON line with the results and the
 * session's cost.
 *
 *   bun ci/live-check.ts --server URL --admin-token-file FILE \
 *     --opencode URL --opencode-password PW \
 *     --model PROVIDER/MODEL --variant VARIANT \
 *     --restart "SHELL COMMAND" [--prompt-timeout-min 6]
 */
import { readFileSync } from "node:fs"
import { hostname } from "node:os"
import { parseArgs } from "node:util"

const { values: opt } = parseArgs({
  options: {
    server: { type: "string" },
    "admin-token-file": { type: "string" },
    opencode: { type: "string" },
    "opencode-password": { type: "string" },
    model: { type: "string" },
    variant: { type: "string" },
    restart: { type: "string" },
    "prompt-timeout-min": { type: "string", default: "6" },
  },
})
for (const name of [
  "server",
  "admin-token-file",
  "opencode",
  "opencode-password",
  "model",
  "restart",
] as const)
  if (!opt[name]) throw new Error(`--${name} is required`)

const server = opt.server as string
const admin = readFileSync(opt["admin-token-file"] as string, "utf8").trim()
const oc = opt.opencode as string
const ocAuth = `Basic ${btoa(`opencode:${opt["opencode-password"]}`)}`
const [providerID, ...rest] = (opt.model as string).split("/")
const modelID = rest.join("/")
const promptTimeout = Number(opt["prompt-timeout-min"]) * 60_000
const machine =
  hostname()
    .split(".")[0]
    ?.replace(/[^A-Za-z0-9._-]+/g, "-") ?? ""
const run = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)
const agentId = `live:${machine}:${modelID.split("/").at(-1)}:${run}`
const steps: { step: string; ok: boolean; detail?: string }[] = []

async function http(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
  })
  const text = await res.text()
  const body = text ? JSON.parse(text) : undefined
  if (!res.ok)
    throw new Error(
      `${init.method ?? "GET"} ${url}: ${res.status} ${text.slice(0, 200)}`,
    )
  return body && typeof body === "object" && "data" in body ? body.data : body
}
const api = (path: string) =>
  http(`${server}${path}`, { headers: { authorization: `Bearer ${admin}` } })
const ocApi = (
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
) =>
  http(`${oc}${path}`, {
    method,
    timeoutMs,
    headers: {
      authorization: ocAuth,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

async function until<T>(
  what: string,
  check: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined)
    if (value) return value
    await Bun.sleep(1000)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function turn(sessionID: string, text: string) {
  const before =
    (await ocApi("GET", `/api/session/${sessionID}`)).time?.idle ?? 0
  await ocApi("POST", `/api/session/${sessionID}/prompt`, { text })
  return until(
    "the turn to end",
    async () => {
      const s = await ocApi("GET", `/api/session/${sessionID}`)
      return s.time?.idle > before && s.outcome ? s : undefined
    },
    promptTimeout,
  )
}

function record(step: string, ok: boolean, detail?: string) {
  steps.push({ step, ok, detail })
  if (!ok) throw new Error(`${step}: ${detail ?? "failed"}`)
}

let sessionID = ""
let cost = 0
try {
  const info = await api("/v1/info")
  record("server answers", true, `${info.id} ${info.version}`)
  await ocApi("GET", "/api/location")
  const host = await until(
    "the plugin to connect",
    async () =>
      (await api("/v1/hosts")).hosts.find(
        (h: any) => h.machine === machine && h.online,
      ),
    60_000,
  )
  record("plugin connected across machines", true, host.id)

  const session = await ocApi("POST", "/api/session", {
    model: { providerID, id: modelID, variant: opt.variant },
    title: agentId,
  })
  sessionID = session.id
  const first = await turn(
    sessionID,
    "Register this session with Autocode: call the autocode_me tool with " +
      `action "register", id "${agentId}" and description ` +
      `"live check of tier 0a". Then call autocode_me with action ` +
      `"discover" and pattern "live:*". Reply with the two results, briefly.`,
  )
  record("first turn ended", first.outcome === "succeeded", first.outcome)
  const agent = (await api(`/v1/agents/${encodeURIComponent(agentId)}`)).agent
  record(
    "registered and seen by the server",
    agent.session === sessionID && agent.machine === machine,
    `${agent.id} on ${agent.machine}`,
  )

  const restarted = Date.now()
  const proc = Bun.spawn(["sh", "-c", opt.restart as string], {
    stdout: "inherit",
    stderr: "inherit",
  })
  record("server restart command", (await proc.exited) === 0)
  await until("the server to answer again", () => api("/v1/info"), 60_000)
  const kept = (await api(`/v1/agents/${encodeURIComponent(agentId)}`)).agent
  record("still registered after the restart", kept.session === sessionID)
  await until(
    "the plugin to reconnect",
    async () =>
      (await api("/v1/hosts")).hosts.find(
        (h: any) =>
          h.id === host.id && h.online && Date.parse(h.last_seen) > restarted,
      ),
    90_000,
  )
  record("plugin reconnected", true)

  const second = await turn(
    sessionID,
    `Call the autocode_me tool with action "status" ` +
      "and reply with what it says.",
  )
  record("second turn ended", second.outcome === "succeeded", second.outcome)
  const after = (await api(`/v1/agents/${encodeURIComponent(agentId)}`)).agent
  record(
    "the agent's status call reached the restarted server",
    Date.parse(after.last_active) > restarted,
    after.last_active,
  )
  cost = (await ocApi("GET", `/api/session/${sessionID}`)).cost ?? 0
  console.log(
    JSON.stringify({
      ok: true,
      model: opt.model,
      variant: opt.variant,
      agent: agentId,
      session: sessionID,
      cost,
      steps,
    }),
  )
} catch (err) {
  if (sessionID)
    cost =
      (await ocApi("GET", `/api/session/${sessionID}`).catch(() => ({})))
        ?.cost ?? 0
  console.log(
    JSON.stringify({
      ok: false,
      model: opt.model,
      agent: agentId,
      session: sessionID,
      cost,
      error: String(err),
      steps,
    }),
  )
  process.exit(1)
}
