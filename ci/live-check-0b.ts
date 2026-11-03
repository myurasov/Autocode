/*
 * Live check, tier 0b: real models in real sessions of the machine's OpenCode
 * background service (in a scratch folder), against the Autocode server on the
 * same machine. Two agents register and set a wake through the tools; one
 * messages the other, and the message's injection wakes it; the owner fires a
 * wake and answers a message to the owner; the agent loads the autocode skill;
 * and a folder the service unloaded is loaded again for a fired wake. Prints
 * one JSON line with the steps and the sessions' cost. Not run in CI.
 *
 *   bun ci/live-check-0b.ts --server http://127.0.0.1:4848 \
 *     --admin-token-file ~/.autocode/admin.token \
 *     --model PROVIDER/MODEL --variant high --folder DIR [--skip-unload]
 */
import { mkdirSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { findService } from "@autocode/server/loader"

const { values: opt } = parseArgs({
  options: {
    server: { type: "string" },
    "admin-token-file": { type: "string" },
    model: { type: "string" },
    variant: { type: "string", default: "high" },
    folder: { type: "string" },
    "skip-unload": { type: "boolean", default: false },
    "turn-timeout-min": { type: "string", default: "6" },
  },
})
for (const name of ["server", "admin-token-file", "model", "folder"] as const)
  if (!opt[name]) throw new Error(`--${name} is required`)

const server = opt.server as string
const admin = readFileSync(opt["admin-token-file"] as string, "utf8").trim()
const folder = opt.folder as string
const [providerID, ...rest] = (opt.model as string).split("/")
const modelID = rest.join("/")
const turnTimeout = Number(opt["turn-timeout-min"]) * 60_000
const short = modelID.split("/").at(-1) ?? "model"
const run = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)
const idA = `live:0b:${short}:a:${run}`
const idB = `live:0b:${short}:b:${run}`
const steps: { step: string; ok: boolean; detail?: string }[] = []

async function http(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
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

const service = await findService()
if (!service) throw new Error("no OpenCode background service on this machine")
const oc = service.url
const ocAuth = service.authorization ?? ""
const ocApi = (
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
) =>
  http(`${oc}${path}`, {
    method,
    headers: {
      ...(ocAuth ? { authorization: ocAuth } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
const ac = (method: string, path: string, body?: unknown) =>
  http(`${server}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${admin}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function until<T>(
  fn: () => Promise<T | undefined | false | null>,
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

async function step(name: string, fn: () => Promise<string | undefined>) {
  try {
    const detail = await fn()
    steps.push({ step: name, ok: true, ...(detail ? { detail } : {}) })
  } catch (err) {
    steps.push({ step: name, ok: false, detail: (err as Error).message })
  }
}

const session = (id: string) => ocApi("GET", `/api/session/${id}`)
const messages = async (id: string): Promise<any[]> => {
  const res = await ocApi("GET", `/api/session/${id}/message`)
  return Array.isArray(res) ? res : (res?.items ?? res?.messages ?? [])
}
const allText = async (id: string) => JSON.stringify(await messages(id))

// Prompts and waits until the turn has ended.
async function turn(id: string, text: string) {
  const before = (await session(id))?.time?.idle ?? 0
  await ocApi("POST", `/api/session/${id}/prompt`, { text })
  return until(
    async () => {
      const s = await session(id)
      return s?.time?.idle && s.time.idle > before && s.outcome ? s : undefined
    },
    turnTimeout,
    `the turn in ${id}`,
  )
}

// Waits until the session has run a turn that saw `text` and ended after it.
async function answered(id: string, text: string) {
  return until(
    async () => {
      const all = await allText(id)
      if (!all.includes(text)) return undefined
      const s = await session(id)
      return s?.outcome && s.time?.idle ? s : undefined
    },
    turnTimeout,
    `a turn in ${id} that saw ${text}`,
  )
}

const hostOf = async (online: boolean) =>
  (await ac("GET", "/v1/hosts")).hosts.find(
    (h: any) => h.directory === folder && h.online === online,
  )

mkdirSync(folder, { recursive: true })
let a = ""
let b = ""

const where = new URLSearchParams({ "location[directory]": folder })

// Waits until the session has finished a turn that began after `since` (its
// idle time moves past it).
async function idleAfter(id: string, since: number) {
  return until(
    async () => {
      const s = await session(id)
      return s?.time?.idle && s.time.idle > since && s.outcome ? s : undefined
    },
    turnTimeout,
    `${id} to finish its turn`,
  )
}

await step("the folder's plugin connects", async () => {
  await ocApi("GET", `/api/location?${where}`)
  const host = await until(() => hostOf(true), 60_000, "the folder's host")
  return host.id
})

await step("two sessions on the model", async () => {
  const create = () =>
    ocApi("POST", "/api/session", {
      location: { directory: folder },
      model: { providerID, id: modelID, variant: opt.variant },
      title: `autocode live check 0b ${run}`,
    })
  a = (await create()).id
  b = (await create()).id
  return `${a} ${b}`
})

await step(
  "agent A registers and sets a fire-only wake through the tools",
  async () => {
    await turn(
      a,
      `Use the autocode_me tool to register this session as ${idA} with the ` +
        `description "live check 0b". Then use autocode_wake to set a ` +
        `fire-only wake named ping whose text is "Reply with the single word ` +
        `PONG-${run}." Then stop.`,
    )
    const agent = (await ac("GET", `/v1/agents/${idA}`)).agent
    const wake = (await ac("GET", `/v1/agents/${idA}/wakes`)).wakes.find(
      (w: any) => w.name === "ping",
    )
    if (!wake) throw new Error("no wake ping")
    return `${agent.status}; wake ${wake.trigger}`
  },
)

await step(
  "agent B registers and messages A; the injection wakes A",
  async () => {
    await turn(
      b,
      `Use autocode_me to register this session as ${idB}. Then use ` +
        `autocode_message to send ${idA} a message with the subject hello ` +
        `and the text "HELLO-${run}". Then stop.`,
    )
    const s = await answered(a, `HELLO-${run}`)
    const all = await allText(a)
    if (!all.includes("[autocode] 1 message"))
      throw new Error("no [autocode] header in A's session")
    return `A's turn ${s.outcome}`
  },
)

await step("the owner fires A's wake; A answers PONG", async () => {
  const since = (await session(a))?.time?.idle ?? 0
  await ac("POST", `/v1/agents/${idA}/wakes/ping/fire`, { text: "live check" })
  await idleAfter(a, since)
  if (!(await allText(a)).includes(`PONG-${run}`))
    throw new Error("no PONG in A's session")
  return "fired by the owner"
})

await step(
  "a message to the owner reaches the inbox; the answer reaches B",
  async () => {
    await turn(
      b,
      `Use autocode_message to send the owner (to: owner) the text ` +
        `"QUESTION-${run}: may I continue?". Then stop.`,
    )
    const item = await until(
      async () =>
        (await ac("GET", "/v1/inbox")).items.find((i: any) =>
          String(i.body).includes(`QUESTION-${run}`),
        ),
      60_000,
      "the inbox item",
    )
    await ac("POST", `/v1/inbox/${item.id}/answer`, {
      text: `ANSWER-${run}: yes.`,
    })
    await answered(b, `ANSWER-${run}`)
    return item.id
  },
)

await step("B loads the autocode skill", async () => {
  await turn(
    b,
    "Load the autocode skill with the skill tool, then say in one sentence " +
      "what a wake's check does.",
  )
  const all = await allText(b)
  if (!all.includes("Autocode links OpenCode sessions"))
    throw new Error("the skill's text is not in the session")
  return "loaded"
})

await step("the agents' turns were reported (working, then idle)", async () => {
  const history = (await ac("GET", `/v1/history?kind=turn.ended&agent=${idA}`))
    .history
  if (!history.length) throw new Error("no turn.ended for A")
  const agent = (await ac("GET", `/v1/agents/${idA}`)).agent
  return `${history.length} turns; now ${agent.status}`
})

if (!opt["skip-unload"])
  await step(
    "an unloaded folder is loaded again for a fired wake",
    async () => {
      const before = (await allText(a)).split(`PONG-${run}`).length
      // only an idle folder is unloaded (a running turn keeps it)
      for (const id of [idA, idB])
        await until(
          async () =>
            (await ac("GET", `/v1/agents/${id}`)).agent.status === "idle",
          turnTimeout,
          `${id} to be idle`,
        )
      const since = (await session(a))?.time?.idle ?? 0
      await ocApi("DELETE", `/api/debug/location?${where}`)
      await until(() => hostOf(false), 180_000, "the host to go offline")
      await ac("POST", `/v1/agents/${idA}/wakes/ping/fire`, {
        text: "after unload",
      })
      await until(() => hostOf(true), 180_000, "the host to come back")
      await idleAfter(a, since)
      if ((await allText(a)).split(`PONG-${run}`).length <= before)
        throw new Error("no new PONG after the reload")
      const loads = (await ac("GET", "/v1/history?kind=host.load")).history
      return `${loads.length} host.load entries`
    },
  )

let cost = 0
for (const id of [a, b])
  if (id) cost += Number((await session(id).catch(() => ({})))?.cost ?? 0)

for (const id of [idA, idB])
  await ac("DELETE", `/v1/agents/${id}`).catch(() => {})

console.log(
  JSON.stringify({
    model: opt.model,
    agents: [idA, idB],
    sessions: [a, b],
    passed: steps.filter((s) => s.ok).length,
    failed: steps.filter((s) => !s.ok).length,
    steps,
    cost,
  }),
)
