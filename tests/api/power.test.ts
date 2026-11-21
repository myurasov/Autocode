/*
 * A power cycle over the API (spec, Power Cycle): the server's data as it lay
 * on disk at one instant (no shutdown code ran), and a new server on it some
 * time later. The plugin is played over its channel, OpenCode's background
 * service by a small server that the loader finds, or starts first when it is
 * gone. Here: what was in flight at the cut (a running turn, a prompt handed
 * over, a check, a compaction, a job's run) and a long outage (wakes, a lock
 * and an approval that ran out meanwhile). The whole machine, with real
 * systemd and a real OpenCode, is tests/power.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ack,
  call,
  type FakeClock,
  hello,
  instructions,
  registered,
  report,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

const HOST = "m:1"
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const enc = encodeURIComponent

let t: TestServer
let a: string
let service: ReturnType<typeof Bun.serve>
// OpenCode's background service: whether it runs, how often the server
// started it, and the folders it was asked to load
let up: boolean
let started: number
let loaded: string[]
// the plugin instance that speaks (a new one after each boot)
let instance: string
const copies: string[] = []

const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const as = (token: string, method: string, path: string, body?: unknown) =>
  call(t.url, token, method, path, body)

function server(dataDir?: string, clock?: FakeClock) {
  return testServer({
    dataDir,
    clock,
    // as a server started without flags: a host silent for 65 s is offline
    offlineAfter: 65,
    machine: "m",
    findService: async () =>
      up ? { url: `http://127.0.0.1:${service.port}` } : undefined,
    ensureService: async () => {
      started++
      up = true
    },
  })
}

/*
 * The power goes and comes back `offMs` later: the new server runs on a copy
 * of the data folder as it lay on disk at the cut (what the old process does
 * after that is lost with it), and OpenCode is gone with its plugin.
 */
async function powerCycle(offMs: number) {
  const copy = mkdtempSync(join(tmpdir(), "autocode-power-"))
  copies.push(copy)
  cpSync(t.dataDir, copy, { recursive: true })
  const clock = t.clock
  await t.stop()
  up = false
  clock.advance(offMs)
  t = await server(copy, clock)
}

// The plugin of the OpenCode that is back: a new instance says hello.
async function back(active: string[] = []) {
  instance = `boot-${crypto.randomUUID().slice(0, 6)}`
  const res = await hello(t, HOST, {
    instance,
    process: { pid: 78, kind: "service" },
    active,
  })
  expect(res.status).toBe(200)
}

// What waits for the plugin now (fetched, not acknowledged).
async function next(): Promise<any[]> {
  const res = await call(
    t.url,
    t.consumer,
    "GET",
    `/v1/hosts/${enc(HOST)}/next?wait=0&instance=${enc(instance)}`,
  )
  expect(res.status).toBe(200)
  return res.body.instructions
}

const events = (list: unknown[]) =>
  call(t.url, t.consumer, "POST", `/v1/hosts/${enc(HOST)}/events`, {
    instance,
    events: list,
  })
const done = (id: string, result: unknown = { ok: true }) =>
  events([{ type: "ack", id, ok: true, result }])

// One scheduler pass; the loader's requests get a moment to arrive.
async function pass() {
  t.server.tick()
  await Bun.sleep(150)
}

// Runs the scheduler, fetches and acknowledges; the prompts' texts.
async function prompts(): Promise<string[]> {
  t.server.tick()
  const out: string[] = []
  for (const i of await next()) {
    if (i.type === "inject") out.push(i.payload.text)
    await done(i.id)
  }
  return out
}

// The same after the 5 s in which OpenCode may resume a cut turn itself.
async function promptsAfterWait(): Promise<string[]> {
  t.clock.advance(5000)
  return prompts()
}

const kinds = async (kind: string) =>
  (await owner("GET", `/v1/history?kind=${kind}`)).body.history as any[]

beforeEach(async () => {
  up = true
  started = 0
  loaded = []
  service = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/api/info")
        return Response.json({ version: "2.3.0", pid: 78 })
      loaded.push(url.searchParams.get("location[directory]") ?? "")
      return Response.json({})
    },
  })
  t = await server()
  await owner("PATCH", "/v1/settings", {
    server: { timezone: "UTC", min_interval: "1s" },
  })
  await hello(t, HOST, { process: { pid: 77, kind: "service" } })
  a = await registered(t, HOST, "ses_a", "team:a")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(async () => {
  await t.stop()
  service.stop(true)
  for (const dir of copies.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe("a turn running at the cut", () => {
  test("with nothing waiting: the server starts OpenCode and loads the folder by itself, and the turn is resumed", async () => {
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await powerCycle(5 * MIN)
    // the data came through
    const agent = (await owner("GET", "/v1/agents/team:a")).body.agent
    expect(agent).toMatchObject({ id: "team:a", session: "ses_a" })
    // nothing is connected to a server that was off this long
    const host = (await owner("GET", "/v1/hosts")).body.hosts[0]
    expect(host.online).toBe(false)
    await pass()
    expect({ started, loaded }).toEqual({ started: 1, loaded: ["/work"] })
    await back()
    // not at once: OpenCode may be resuming the turn itself
    expect(await prompts()).toEqual([])
    const got = await promptsAfterWait()
    expect(got.length).toBe(1)
    expect(got[0]).toStartWith("[autocode] resume\n\n")
    expect((await kinds("turn.cut")).length).toBe(1)
    expect((await kinds("turn.resumed")).length).toBe(1)
  })

  test("OpenCode resumes it itself (a turn starts in the session right after the hello): no resume prompt, and what waited comes after that turn", async () => {
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "in 2m" })
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await powerCycle(5 * MIN)
    await pass()
    await back()
    expect(await prompts()).toEqual([])
    // OpenCode's own resume of the turn its killed server left
    await events([{ type: "turn.started", session: "ses_a" }])
    t.clock.advance(10_000)
    expect(await prompts()).toEqual([])
    await events([
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    // the wake that fell due meanwhile comes as itself, not as a resume
    const got = await promptsAfterWait()
    expect(got.length).toBe(1)
    expect(got[0]).toStartWith('[autocode] wake "w"')
    expect((await kinds("turn.uncut")).length).toBe(1)
    expect(await kinds("turn.resumed")).toEqual([])
  })

  test("a quick cycle (back within offline-after): once the host counts as offline it is loaded, and the turn is resumed", async () => {
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await powerCycle(10_000)
    // the host still counts as online: the server waits for it
    const host = (await owner("GET", "/v1/hosts")).body.hosts[0]
    expect(host.online).toBe(true)
    await pass()
    expect({ started, loaded }).toEqual({ started: 0, loaded: [] })
    t.clock.advance(70_000)
    t.server.maintenance()
    await pass()
    expect({ started, loaded }).toEqual({ started: 1, loaded: ["/work"] })
    await back()
    expect((await promptsAfterWait())[0]).toStartWith("[autocode] resume\n\n")
  })

  test("an idle wake of that agent comes again after the resumed turn", async () => {
    await as(a, "PUT", "/v1/me/wakes/watch", {
      text: "Look.",
      trigger: "idle 10m repeat",
    })
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    await powerCycle(2 * HOUR)
    await pass()
    await back()
    expect((await promptsAfterWait())[0]).toStartWith("[autocode] resume\n\n")
    await events([{ type: "turn.started", session: "ses_a" }])
    await events([
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    t.clock.advance(10 * MIN)
    const got = await prompts()
    expect(got.length).toBe(1)
    expect(got[0]).toContain("Look.")
  })
})

describe("a prompt handed over at the cut", () => {
  test("never fetched, and a quick cycle: the host is loaded once it counts as offline, and the prompt arrives once", async () => {
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "in 1m" })
    t.clock.advance(MIN)
    // the plugin was heard from a moment before the cut
    await hello(t, HOST, { process: { pid: 77, kind: "service" } })
    t.server.tick() // handed over: it waits for the plugin's next poll
    await powerCycle(10_000)
    await pass() // the host still counts as online: nothing yet
    expect({ started, loaded }).toEqual({ started: 0, loaded: [] })
    t.clock.advance(70_000)
    t.server.maintenance()
    await pass()
    expect({ started, loaded }).toEqual({ started: 1, loaded: ["/work"] })
    await back()
    const got = await prompts()
    expect(got.length).toBe(1)
    expect(got[0]).toContain("Go.")
    t.clock.advance(5 * MIN)
    expect(await prompts()).toEqual([])
  })

  test("fetched but not started (OpenCode died with it): the host is loaded, and the prompt comes again", async () => {
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "in 1m" })
    t.clock.advance(MIN)
    t.server.tick()
    const fetched = (await instructions(t, HOST)).filter(
      (i) => i.type === "inject",
    )
    expect(fetched.length).toBe(1)
    await powerCycle(5 * MIN)
    await pass()
    expect({ started, loaded }).toEqual({ started: 1, loaded: ["/work"] })
    await back()
    const got = await prompts()
    expect(got.length).toBe(1)
    expect(got[0]).toContain("Go.")
  })
})

describe("a check running at the cut", () => {
  test("it runs again when the host is back, and its wake is delivered", async () => {
    await as(a, "PUT", "/v1/me/wakes/w", {
      text: "Work.",
      trigger: "in 1m",
      check: "./has-work.sh",
    })
    t.clock.advance(MIN)
    t.server.tick()
    const sent = (await instructions(t, HOST)).filter((i) => i.type === "check")
    expect(sent.length).toBe(1)
    await powerCycle(5 * MIN)
    await pass()
    expect({ started, loaded }).toEqual({ started: 1, loaded: ["/work"] })
    await back()
    t.server.tick()
    const again = (await next()).filter((i) => i.type === "check")
    expect(again.length).toBe(1)
    await done(again[0].id, { exit: 0, output: "yes" })
    const got = await prompts()
    expect(got.length).toBe(1)
    expect(got[0]).toContain("Work.")
  })
})

describe("a compaction running at the cut", () => {
  test("the agent is not left compacting: it is resumed, and its next wake is delivered", async () => {
    await as(a, "PUT", "/v1/me/wakes/w", { text: "Go.", trigger: "every 1h" })
    await report(t, HOST, [{ type: "turn.started", session: "ses_a" }])
    expect((await as(a, "POST", "/v1/me/compact")).status).toBe(200)
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    t.server.tick()
    const [compact] = (await instructions(t, HOST)).filter(
      (i) => i.type === "compact",
    )
    expect(compact).toBeDefined()
    // OpenCode took it: the compaction's turn runs when the power goes
    await ack(t, HOST, compact.id, { ok: true })
    await report(t, HOST, [
      { type: "turn.started", session: "ses_a", by: "compaction" },
    ])
    await powerCycle(5 * MIN)
    await pass()
    expect({ started, loaded }).toEqual({ started: 1, loaded: ["/work"] })
    await back()
    const first = await promptsAfterWait()
    expect(first.length).toBe(1)
    await events([{ type: "turn.started", session: "ses_a" }])
    await events([
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
    ])
    // whatever the server does about the compaction, the wake still comes
    const texts = [...first]
    for (let i = 0; i < 6 && !texts.some((x) => x.includes("Go.")); i++) {
      t.clock.advance(20 * MIN)
      for (const text of await prompts()) {
        texts.push(text)
        await events([{ type: "turn.started", session: "ses_a" }])
        await events([
          { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
        ])
      }
    }
    expect(texts.some((x) => x.includes("Go."))).toBe(true)
    const agent = (await owner("GET", "/v1/agents/team:a")).body.agent
    expect(agent.status).toBe("idle")
  })
})

describe("a job's run in flight at the cut", () => {
  test("its turn is resumed when the host is back, and its result still arrives", async () => {
    await owner("PUT", "/v1/jobs/mail", {
      host: HOST,
      description: "Summarizes the day's mail",
      model: "fake/main",
      prompt: "Summarize today's mail.",
      trigger: "fire-only",
      to: "owner",
    })
    expect((await owner("POST", "/v1/jobs/mail/run")).status).toBe(201)
    // spawned, registered and prompted: its turn runs when the power goes
    for (let round = 0; round < 2; round++) {
      t.server.tick()
      for (const i of await instructions(t, HOST))
        await ack(
          t,
          HOST,
          i.id,
          i.type === "spawn" ? { session: "ses_run" } : { ok: true },
        )
    }
    await report(t, HOST, [{ type: "turn.started", session: "ses_run" }])
    await powerCycle(5 * MIN)
    await pass()
    expect({ started, loaded }).toEqual({ started: 1, loaded: ["/work"] })
    await back()
    const got = await promptsAfterWait()
    expect(got.length).toBe(1)
    expect(got[0]).toStartWith("[autocode] resume\n\n")
    // the run goes on to its end
    await events([{ type: "turn.started", session: "ses_run" }])
    const token = await call(
      t.url,
      t.consumer,
      "POST",
      `/v1/hosts/${enc(HOST)}/sessions/ses_run/token`,
      { instance, directory: "/work" },
    )
    expect(token.status).toBe(200)
    const fin = await as(token.body.token, "POST", "/v1/me/finish", {
      result: "Five lines of mail.",
    })
    expect(fin.status).toBe(200)
    const run = (await owner("GET", "/v1/runs?job=mail")).body.runs[0]
    expect(run).toMatchObject({
      state: "succeeded",
      result: "Five lines of mail.",
    })
  })
})

describe("a long outage (3 days)", () => {
  test("the agent and its host stay; each wake that fell due runs once; a lock and an approval that ran out are told", async () => {
    await as(a, "PUT", "/v1/me/wakes/often", {
      text: "Often.",
      trigger: "every 30m",
    })
    await as(a, "PUT", "/v1/me/wakes/daily", {
      text: "Daily.",
      trigger: 'cron "0 9 * * *"',
    })
    const lock = await as(a, "POST", "/v1/locks/gpu-0/acquire", {
      ttl: "1h",
    })
    expect(lock.status).toBe(200)
    const approval = await as(a, "POST", "/v1/me/approvals", {
      text: "Pay the invoice?",
      expires: "2h",
    })
    expect(approval.status).toBe(201)
    await powerCycle(3 * DAY)
    // registered still, and its host kept though it is long past
    // host_expire_after: an agent needs it
    const agent = (await owner("GET", "/v1/agents/team:a")).body.agent
    expect(agent).toMatchObject({ id: "team:a", session: "ses_a" })
    const hosts = (await owner("GET", "/v1/hosts")).body.hosts
    expect(hosts.map((h: any) => [h.id, h.online])).toEqual([[HOST, false]])
    await pass()
    expect({ started, loaded }).toEqual({ started: 1, loaded: ["/work"] })
    await back()
    const texts: string[] = []
    for (let i = 0; i < 4; i++) {
      for (const text of await prompts()) {
        texts.push(text)
        await events([{ type: "turn.started", session: "ses_a" }])
        await events([
          { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
        ])
      }
      t.clock.advance(2000)
    }
    const all = texts.join("\n---\n")
    // 144 runs of the one and 3 of the other were missed: one of each comes
    expect(all.split("Often.").length - 1).toBe(1)
    expect(all.split("Daily.").length - 1).toBe(1)
    expect(all).toContain('lock "gpu-0" expired')
    expect(all).toContain('Your hold on lock "gpu-0" ran out')
    expect(all).toContain('approval "Pay the invoice?" rejected (expired)')
    // the next run of the frequent wake is half an hour from now
    t.clock.advance(29 * MIN)
    expect(await prompts()).toEqual([])
    t.clock.advance(MIN)
    const later = await prompts()
    expect(later.length).toBe(1)
    expect(later[0]).toContain("Often.")
  })
})
