/*
 * Locks and semaphores over the API (tier 0c): acquire (try, queue),
 * renew, release and list, with their errors; grants, expiries and the
 * owner's releases come as notices from Autocode, in a prompt of their own
 * (held while the agent is paused); there is no mode=wait; /v1/me says what
 * an agent holds; unregistering releases everything; many agents at once
 * never exceed a lock's capacity.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ack,
  call,
  hello,
  instructions,
  registered,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

let t: TestServer
let a: string
let b: string
let c: string
const HOST = "m:1"
const MIN = 60_000
const FOOTER =
  "— From Autocode, not the owner. Your wakes: autocode_wake list. " +
  "How Autocode works: autocode_me action=help."

const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const lock = (token: string, name: string, action: string, body = {}) =>
  call(t.url, token, "POST", `/v1/locks/${name}/${action}`, body)
const list = async (token = t.admin, q = "") =>
  (await call(t.url, token, "GET", `/v1/locks${q}`)).body.locks
const holders = async (name: string) =>
  ((await list()).find((l: any) => l.name === name)?.holders ?? []).map(
    (h: any) => h.agent,
  )

// One scheduler tick; the prompts it sent (acked), by session.
async function tick(): Promise<Record<string, string>> {
  t.server.tick()
  const out: Record<string, string> = {}
  for (const i of await instructions(t, HOST)) {
    if (i.type === "inject") out[i.payload.session] = i.payload.text
    await ack(t, HOST, i.id, { ok: true })
  }
  return out
}
const kinds = async (kind: string) =>
  (await owner("GET", `/v1/history?kind=${kind}`)).body.history

beforeEach(async () => {
  t = await testServer()
  await owner("PATCH", "/v1/settings", {
    server: { timezone: "America/Los_Angeles" },
  })
  await hello(t, HOST)
  a = await registered(t, HOST, "ses_a", "team:a")
  b = await registered(t, HOST, "ses_b", "team:b")
  c = await registered(t, HOST, "ses_c", "team:c")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("the routes", () => {
  test("acquire, list, renew and release, with their errors and codes", async () => {
    const got = await lock(a, "gpu-0", "acquire", { ttl: "10m" })
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({
      granted: true,
      expires: "2026-10-28T12:10:00.000Z",
      lock: { name: "gpu-0", max: 1, holders: [{ agent: "team:a" }] },
    })
    const busy = await lock(b, "gpu-0", "acquire", { ttl: "5m", mode: "try" })
    expect(busy.status).toBe(409)
    expect(busy.body.error.code).toBe("lock_busy")
    const queued = await lock(b, "gpu-0", "acquire", { ttl: "5m" })
    expect(queued.body).toMatchObject({ granted: false, position: 1 })
    const cap = await lock(c, "gpu-0", "acquire", { ttl: "5m", max: 2 })
    expect(cap.status).toBe(409)
    expect(cap.body.error.code).toBe("lock_capacity")
    const nottl = await lock(c, "gpu-0", "acquire", {})
    expect(nottl.status).toBe(400)
    expect(nottl.body.error.message).toContain("ttl")
    const mode = await lock(c, "gpu-0", "acquire", { ttl: "1m", mode: "x" })
    expect(mode.status).toBe(400)
    // every lock, for an agent too; by pattern
    expect(await list(c)).toMatchObject([
      {
        name: "gpu-0",
        max: 1,
        holders: [{ agent: "team:a", expires: "2026-10-28T12:10:00.000Z" }],
        queue: [{ agent: "team:b", position: 1 }],
      },
    ])
    expect(await list(c, "?match=data:*")).toEqual([])
    expect((await lock(b, "gpu-0", "renew")).body.error.code).toBe("not_held")
    t.clock.advance(MIN)
    const renewed = await lock(a, "gpu-0", "renew", { ttl: "1h" })
    expect(renewed.body.expires).toBe("2026-10-28T13:01:00.000Z")
    expect((await lock(a, "gpu-0", "release")).body.released).toBe("held")
    expect(await holders("gpu-0")).toEqual(["team:b"])
    const none = await lock(c, "gpu-0", "release")
    expect(none.status).toBe(404)
    expect(none.body.error.code).toBe("not_held")
    expect((await lock(c, "nothing", "release")).body.error.code).toBe(
      "no_lock",
    )
    // the consumer token does not take locks
    expect((await lock(t.consumer, "gpu-0", "acquire")).status).toBe(403)
  })

  test("history: acquired, queued, renewed, released, left", async () => {
    await lock(a, "gpu-0", "acquire", { ttl: "10m" })
    await lock(b, "gpu-0", "acquire", { ttl: "10m" })
    await lock(c, "gpu-0", "acquire", { ttl: "10m" })
    await lock(a, "gpu-0", "renew")
    await lock(c, "gpu-0", "release")
    await lock(a, "gpu-0", "release")
    const got = await kinds("lock.*")
    expect(
      got
        .map((h: any) => `${h.kind} ${h.agent}`)
        .reverse()
        .slice(0, 6),
    ).toEqual([
      "lock.acquired team:a",
      "lock.queued team:b",
      "lock.queued team:c",
      "lock.renewed team:a",
      "lock.left team:c",
      "lock.released team:a",
    ])
    expect(got[0]).toMatchObject({
      kind: "lock.acquired",
      agent: "team:b",
      data: { lock: "gpu-0", queued: true },
    })
  })
})

describe("notices", () => {
  test("a grant comes as a notice from Autocode, in a prompt of its own", async () => {
    await lock(a, "gpu-0", "acquire", { ttl: "10m" })
    await lock(b, "gpu-0", "acquire", { ttl: "10m" })
    expect(await tick()).toEqual({})
    await lock(a, "gpu-0", "release")
    const sent = await tick()
    expect(sent.ses_b).toBe(
      '[autocode] lock "gpu-0" granted\n\n' +
        'You hold lock "gpu-0" now, until 2026-10-28 05:10 PDT: its ttl ' +
        "of 10m counts from the grant. Renew it before then " +
        "(autocode_lock action=renew name=gpu-0); release it when you are " +
        "done (action=release).\n\n" +
        FOOTER,
    )
    expect(sent.ses_a).toBeUndefined()
    // it is a message from autocode, carried whole: delivered
    const mine = (await owner("GET", "/v1/messages?agent=team:b")).body
    expect(mine.messages).toMatchObject([
      { from: "autocode", subject: 'lock "gpu-0" granted', state: "delivered" },
    ])
  })

  test("a semaphore's notice says how many places it has", async () => {
    await lock(a, "sem", "acquire", { ttl: "10m", max: 2 })
    await lock(c, "sem", "acquire", { ttl: "10m" })
    await lock(b, "sem", "acquire", { ttl: "10m" })
    await lock(a, "sem", "release")
    expect((await tick()).ses_b).toContain(
      'You hold lock "sem" now (one of its 2 places), until',
    )
  })

  test("an expired hold is freed, its holder told, and the next in the queue granted", async () => {
    await lock(a, "gpu-0", "acquire", { ttl: "2m" })
    await lock(b, "gpu-0", "acquire", { ttl: "10m" })
    t.clock.advance(2 * MIN)
    const sent = await tick()
    expect(sent.ses_a).toBe(
      '[autocode] lock "gpu-0" expired\n\n' +
        'Your hold on lock "gpu-0" ran out at 2026-10-28 05:02 PDT (its ' +
        "ttl was 2m) and was freed; another agent may hold it now. " +
        "Acquire it again if you still need it.\n\n" +
        FOOTER,
    )
    expect(sent.ses_b).toStartWith('[autocode] lock "gpu-0" granted\n\n')
    expect(await holders("gpu-0")).toEqual(["team:b"])
    expect((await kinds("lock.expired"))[0]).toMatchObject({
      agent: "team:a",
      data: { lock: "gpu-0" },
    })
  })

  test("a notice goes with what else waits, before the messages", async () => {
    await lock(a, "gpu-0", "acquire", { ttl: "10m" })
    await lock(b, "gpu-0", "acquire", { ttl: "10m" })
    await call(t.url, c, "POST", "/v1/messages", { to: "team:b", text: "hi" })
    await lock(a, "gpu-0", "release")
    const prompt = (await tick()).ses_b!
    expect(prompt).toStartWith('[autocode] lock "gpu-0" granted, 1 message\n\n')
    expect(prompt.indexOf('You hold lock "gpu-0"')).toBeLessThan(
      prompt.indexOf("from agent team:c:\n> hi"),
    )
  })

  test("notices wait while the agent is paused; the grant itself does not", async () => {
    await lock(a, "gpu-0", "acquire", { ttl: "10m" })
    await lock(b, "gpu-0", "acquire", { ttl: "10m" })
    await owner("POST", "/v1/agents/team:b/pause")
    await lock(a, "gpu-0", "release")
    expect(await holders("gpu-0")).toEqual(["team:b"])
    expect(await tick()).toEqual({})
    await owner("POST", "/v1/agents/team:b/resume")
    expect((await tick()).ses_b).toStartWith('[autocode] lock "gpu-0" granted')
  })
})

// The owner, 2026-11-07: no mode=wait; queue and the grant notice do it.
describe("no wait", () => {
  test("mode=wait is refused; try and queue are the modes", async () => {
    await lock(a, "gpu-0", "acquire", { ttl: "10m" })
    const res = await lock(b, "gpu-0", "acquire", { ttl: "10m", mode: "wait" })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toBe("mode is try or queue")
    const old = await lock(b, "gpu-0", "acquire", { ttl: "10m", seconds: 20 })
    expect(old.body.error.message).toBe("unknown field seconds")
    expect(await list()).toMatchObject([{ queue: [] }])
  })
})

describe("the owner and the agent", () => {
  test("the owner lists every lock and releases an agent's hold; the agent is told", async () => {
    await lock(a, "gpu-0", "acquire", { ttl: "10m" })
    await lock(b, "gpu-0", "acquire", { ttl: "10m" })
    expect(
      (await owner("POST", "/v1/locks/gpu-0/release", {})).body.error.code,
    ).toBe("bad_request")
    const res = await owner("POST", "/v1/locks/gpu-0/release", {
      agent: "team:a",
    })
    expect(res.body.released).toBe("held")
    const sent = await tick()
    expect(sent.ses_a).toBe(
      '[autocode] lock "gpu-0" released by the owner\n\n' +
        'The owner released your hold on lock "gpu-0" at 2026-10-28 05:00 ' +
        "PDT; another agent may hold it now. Acquire it again if you still " +
        "need it.\n\n" +
        FOOTER,
    )
    expect(sent.ses_b).toStartWith('[autocode] lock "gpu-0" granted')
    expect((await kinds("lock.released"))[0].data).toMatchObject({
      lock: "gpu-0",
      by: "owner",
    })
  })

  test("/v1/me says what the agent holds and where it waits", async () => {
    await lock(a, "x", "acquire", { ttl: "10m" })
    await lock(b, "x", "acquire", { ttl: "10m" })
    await lock(b, "y", "acquire", { ttl: "1h", max: 3 })
    const me = (await call(t.url, b, "GET", "/v1/me")).body
    expect(me.locks).toEqual({
      held: [{ name: "y", max: 3, expires: "2026-10-28T13:00:00.000Z" }],
      queued: [{ name: "x", max: 1, position: 1 }],
    })
  })

  test("unregistering releases the agent's holds and leaves its queues", async () => {
    await lock(a, "x", "acquire", { ttl: "10m" })
    await lock(b, "x", "acquire", { ttl: "10m" })
    await lock(c, "y", "acquire", { ttl: "10m" })
    await lock(a, "y", "acquire", { ttl: "10m" })
    expect((await call(t.url, a, "DELETE", "/v1/me")).status).toBe(200)
    expect(await holders("x")).toEqual(["team:b"])
    expect((await list()).find((l: any) => l.name === "y").queue).toEqual([])
    expect((await tick()).ses_b).toStartWith('[autocode] lock "x" granted')
    expect((await kinds("lock.released"))[0].data).toMatchObject({
      by: "unregister",
    })
  })
})

// Found by the 0c review (2026-11-05).
describe("review findings", () => {
  test("the owner acts only for a registered agent", async () => {
    for (const agent of ["nobody:here", "owner", "autocode"]) {
      const res = await owner("POST", "/v1/locks/gpu-0/acquire", {
        agent,
        ttl: "10m",
      })
      expect(res.status, agent).toBe(404)
      expect(res.body.error.code, agent).toBe("not_registered")
    }
    expect(await list()).toEqual([])
    const ok = await owner("POST", "/v1/locks/gpu-0/acquire", {
      agent: "team:a",
      ttl: "10m",
    })
    expect(ok.body.granted).toBe(true)
  })

  test("the owner taking an agent out of the queue tells it", async () => {
    await lock(a, "gpu-0", "acquire", { ttl: "10m" })
    await lock(b, "gpu-0", "acquire", { ttl: "10m" })
    await owner("POST", "/v1/locks/gpu-0/release", { agent: "team:b" })
    expect((await tick()).ses_b).toBe(
      '[autocode] lock "gpu-0": out of the queue\n\n' +
        'The owner took you out of the queue of lock "gpu-0" at 2026-10-28 ' +
        "05:00 PDT; it will not be granted to you. Acquire it again if you " +
        "still need it.\n\n" +
        FOOTER,
    )
  })

  test("an unregistered agent's waiting notices are dropped", async () => {
    await lock(a, "gpu-0", "acquire", { ttl: "10m" })
    await lock(b, "gpu-0", "acquire", { ttl: "10m" })
    await owner("POST", "/v1/agents/team:b/pause")
    await lock(a, "gpu-0", "release")
    await call(t.url, b, "DELETE", "/v1/me")
    const again = await registered(t, HOST, "ses_b", "team:b")
    expect((await call(t.url, again, "GET", "/v1/me")).body.waiting).toBe(0)
    const mine = (await owner("GET", "/v1/messages?agent=team:b")).body
    expect(mine.messages).toEqual([])
  })
})

describe("concurrency", () => {
  // Replays a lock's history: how many held it at once, at most.
  async function most(name: string): Promise<number> {
    const h = (
      await owner("GET", "/v1/history?kind=lock.*&limit=1000")
    ).body.history.reverse()
    let n = 0
    let top = 0
    for (const e of h) {
      if (e.data?.lock !== name) continue
      if (e.kind === "lock.acquired") n++
      if (e.kind === "lock.released" || e.kind === "lock.expired") n--
      top = Math.max(top, n)
    }
    return top
  }

  test("many agents acquiring a semaphore at once never exceed its capacity, and are granted in arrival order", async () => {
    const ids: string[] = []
    const tokens: Record<string, string> = {}
    for (let i = 0; i < 12; i++) {
      const id = `swarm:${i}`
      tokens[id] = await registered(t, HOST, `ses_s${i}`, id)
      ids.push(id)
    }
    const jitter = () => Bun.sleep(Math.random() * 20)
    for (let round = 0; round < 3; round++) {
      const name = `sem-${round}`
      await Promise.all(
        ids.map(async (id) => {
          await jitter()
          const res = await lock(tokens[id]!, name, "acquire", {
            ttl: "1h",
            max: 3,
          })
          expect(res.status).toBe(200)
        }),
      )
      let state = (await list()).find((l: any) => l.name === name)
      expect(state.holders.length).toBe(3)
      expect(state.queue.map((q: any) => q.position)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9,
      ])
      const order = state.queue.map((q: any) => q.agent)
      // holders release at random, with waits and acquires in between
      const granted: string[] = []
      while (state) {
        const held = state.holders.map((h: any) => h.agent) as string[]
        const out = held[Math.floor(Math.random() * held.length)]!
        await Promise.all([
          (async () => {
            await jitter()
            await lock(tokens[out]!, name, "release")
          })(),
          (async () => {
            await jitter()
            await list()
          })(),
        ])
        const next = (await list()).find((l: any) => l.name === name)
        if (next) {
          expect(next.holders.length).toBeLessThanOrEqual(3)
          for (const h of next.holders)
            if (!held.includes(h.agent)) granted.push(h.agent)
        }
        state = next
      }
      expect(granted).toEqual(order)
      expect(await most(name)).toBe(3)
    }
  }, 60_000)

  test("acquires racing releases: never more holders than places", async () => {
    const tokens: string[] = []
    for (let i = 0; i < 8; i++)
      tokens.push(await registered(t, HOST, `ses_w${i}`, `race:${i}`))
    for (const tok of tokens.slice(0, 2))
      await lock(tok, "pair", "acquire", { ttl: "1h", max: 2 })
    await Promise.all([
      ...tokens.slice(2).map(async (tok) => {
        await Bun.sleep(Math.random() * 50)
        // max each time: when both holders leave first, the lock is gone and
        // the next acquire makes it again
        await lock(tok, "pair", "acquire", { ttl: "1h", max: 2 })
      }),
      ...tokens.slice(0, 2).map(async (tok) => {
        await Bun.sleep(Math.random() * 50)
        await lock(tok, "pair", "release")
      }),
    ])
    const state = (await list()).find((l: any) => l.name === "pair")
    expect(state.holders.length).toBe(2)
    expect(state.queue.length).toBe(4)
    expect(await most("pair")).toBe(2)
  }, 30_000)
})
