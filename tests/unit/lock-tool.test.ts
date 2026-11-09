/*
 * What agents are told about locks (tier 0c): autocode_lock's description
 * says enough to use it first; acquire, renew, release and list say what
 * happened and when a hold ends, in the server's zone and from now; status
 * says what the agent holds and where it waits; the guide's locks part
 * explains them. There is no mode=wait (the owner, 2026-11-07).
 */
import { describe, expect, test } from "bun:test"
import { guideText, helpText, TOPICS } from "../../packages/plugin/src/guide.ts"
import {
  LOCK_TOOL,
  runLock,
  runMe,
  TOOLS,
} from "../../packages/plugin/src/tools.ts"

const FACTS = {
  serverId: "api-test",
  url: "http://server:4848",
  shellValues: true,
  tools: TOOLS,
}

// 12:00 UTC is 05:00 PDT
const ME = {
  registered: true,
  session: "ses_a",
  agent: { id: "team:a", description: "", status: "idle", machine: "m1" },
  server: {
    id: "api-test",
    time: "2026-10-28T12:00:00.000Z",
    timezone: "America/Los_Angeles",
  },
  settings: { min_interval: "1m", max_tool_wait: "5m" },
  wakes: { count: 0, next: null },
  waiting: 0,
  locks: { held: [], queued: [] },
}

// held by another agent, team:b
const OTHERS = (over: Record<string, unknown> = {}) => ({
  ...LOCK,
  holders: [{ ...LOCK.holders[0], agent: "team:b" }],
  ...over,
})

const LOCK = {
  name: "gpu-0",
  max: 1,
  created_at: "2026-10-28T12:00:00.000Z",
  holders: [
    {
      agent: "team:a",
      since: "2026-10-28T12:00:00.000Z",
      expires: "2026-10-28T12:10:00.000Z",
      ttl: "10m",
    },
  ],
  queue: [],
}

// A fake server: answers by "METHOD path" (a function gets the body), and
// records the calls with their bodies.
function server(answers: Record<string, unknown>) {
  const calls: { key: string; body: any }[] = []
  const call = async (method: string, path: string, body?: unknown) => {
    const key = `${method} ${path.split("?")[0]}`
    calls.push({ key: `${method} ${path}`, body })
    if (!(key in answers)) throw new Error(`unexpected ${key}`)
    const a = answers[key]
    return (typeof a === "function" ? a(body) : a) as any
  }
  return { call, calls }
}

describe("autocode_lock's description", () => {
  test("names every action and mode, the required ttl, notices and the guide", () => {
    expect(TOOLS).toContain(LOCK_TOOL)
    const d = LOCK_TOOL.description
    for (const word of [
      "acquire",
      "renew",
      "release",
      "list",
      "try",
      "queue",
      "ttl",
      "max",
      "notice",
      "topic=locks",
    ])
      expect(d, word).toContain(word)
    // the owner, 2026-11-07: no mode=wait (queue and its notice)
    expect(LOCK_TOOL.input.properties).not.toHaveProperty("seconds")
    expect((LOCK_TOOL.input.properties as any).mode.enum).toEqual([
      "queue",
      "try",
    ])
    for (const [name, prop] of Object.entries(LOCK_TOOL.input.properties))
      if (name !== "action")
        expect((prop as any).description, name).toBeTruthy()
  })
})

describe("autocode_lock", () => {
  test("acquire granted: until when, and how to renew", async () => {
    const { call, calls } = server({
      "GET /v1/me": ME,
      "POST /v1/locks/gpu-0/acquire": {
        granted: true,
        expires: "2026-10-28T12:10:00.000Z",
        lock: LOCK,
      },
    })
    expect(
      await runLock({ action: "acquire", name: "gpu-0", ttl: "10m" }, call),
    ).toBe(
      'You hold lock "gpu-0" until 2026-10-28 05:10 PDT (in 10m). Renew it ' +
        "before then (action=renew); release it when you are done.",
    )
    expect(calls[0]).toEqual({
      key: "POST /v1/locks/gpu-0/acquire",
      body: { ttl: "10m", mode: "queue" },
    })
  })

  test("acquire queued: the place in the queue, who holds it, and the notice to come", async () => {
    const { call } = server({
      "GET /v1/me": ME,
      "POST /v1/locks/gpu-0/acquire": {
        granted: false,
        position: 2,
        lock: OTHERS({ max: 2, queue: [{ agent: "team:c" }, {}] }),
      },
    })
    expect(
      await runLock(
        { action: "acquire", name: "gpu-0", ttl: "1h", max: 2 },
        call,
      ),
    ).toBe(
      'Lock "gpu-0" (2 places) is held by team:b; you are number 2 in ' +
        "the queue. When it is yours, a notice comes: [autocode] lock " +
        '"gpu-0" granted (your ttl counts from then). Release it to leave ' +
        "the queue.",
    )
  })

  test("acquire try refused, and needing a name and ttl", async () => {
    const { call } = server({})
    expect(await runLock({ action: "acquire", name: "gpu-0" }, call)).toBe(
      "error: acquire needs a name and a ttl (how long you hold it, like " +
        "10m or 6h)",
    )
    expect(await runLock({ action: "renew" } as any, call)).toBe(
      "error: renew needs the lock's name",
    )
  })

  test("renew, release, and list", async () => {
    const { call } = server({
      "GET /v1/me": ME,
      "POST /v1/locks/gpu-0/renew": {
        expires: "2026-10-28T13:00:00.000Z",
        lock: LOCK,
      },
      "POST /v1/locks/gpu-0/release": { released: "held" },
      "POST /v1/locks/sem/release": { released: "queued" },
      "GET /v1/locks": {
        locks: [
          {
            ...LOCK,
            queue: [
              {
                agent: "team:b",
                position: 1,
                since: "2026-10-28T12:00:00.000Z",
                ttl: "10m",
              },
            ],
          },
          { ...LOCK, name: "sem", max: 3, holders: [] },
        ],
      },
    })
    expect(
      await runLock({ action: "renew", name: "gpu-0", ttl: "1h" }, call),
    ).toBe('Renewed: you hold lock "gpu-0" until 2026-10-28 06:00 PDT (in 1h).')
    expect(await runLock({ action: "release", name: "gpu-0" }, call)).toBe(
      'Released lock "gpu-0".',
    )
    expect(await runLock({ action: "release", name: "sem" }, call)).toBe(
      'Left the queue of lock "sem".',
    )
    expect(await runLock({ action: "list", pattern: "gpu*" }, call)).toBe(
      [
        "Server time 2026-10-28 05:00 PDT (America/Los_Angeles).",
        "gpu-0 (mutex): held by team:a (you) until 2026-10-28 05:10 PDT " +
          "(in 10m); queued: team:b",
        "sem (3 places): free",
      ].join("\n"),
    )
    const empty = server({ "GET /v1/me": ME, "GET /v1/locks": { locks: [] } })
    expect(await runLock({ action: "list" }, empty.call)).toBe(
      "No locks. The first acquire creates one.",
    )
  })
})

describe("status and the guide", () => {
  test("status says what you hold and where you wait", async () => {
    const { call } = server({
      "GET /v1/me": {
        ...ME,
        locks: {
          held: [
            { name: "gpu-0", max: 1, expires: "2026-10-28T12:10:00.000Z" },
          ],
          queued: [{ name: "sem", max: 2, position: 3 }],
        },
      },
    })
    expect(await runMe({ action: "status" }, call)).toContain(
      'Locks: you hold "gpu-0" (until 2026-10-28 05:10 PDT, in 10m); ' +
        'you wait for "sem" (number 3 in the queue). See autocode_lock list.',
    )
  })

  test("the guide's locks part: modes, ttl and renewal, notices, capacity, unregister", () => {
    expect(TOPICS).toContain("locks")
    const part = helpText(FACTS, "locks").replace(/\s+/g, " ")
    for (const answer of [
      "mode=try",
      "mode=queue",
      "a `ttl` is required",
      "renew",
      '`[autocode] lock "gpu-0" granted`',
      '`[autocode] lock "gpu-0" expired`',
      "arrival order",
      "another capacity is refused",
      "Unregistering releases",
    ])
      expect(part, answer).toContain(answer)
    expect(part).not.toContain("mode=wait")
    expect(guideText(FACTS)).toContain("## Locks")
  })
})

// Found by the 0c review (2026-11-05).
describe("review findings", () => {
  test("the clock not answering does not turn a grant into an error", async () => {
    const { call } = server({
      "POST /v1/locks/gpu-0/acquire": {
        granted: true,
        expires: "2026-10-28T12:10:00.000Z",
        lock: LOCK,
      },
    })
    expect(
      await runLock({ action: "acquire", name: "gpu-0", ttl: "10m" }, call),
    ).toStartWith('You hold lock "gpu-0" until ')
  })

  test("the texts say what is true: another max refused; unregister frees locks", async () => {
    const max = (LOCK_TOOL.input.properties as any).max.description
    expect(max).toContain("another capacity is refused")
    const { call } = server({ "DELETE /v1/me": { unregistered: "team:a" } })
    expect(await runMe({ action: "unregister" }, call)).toBe(
      "Unregistered team:a; your wakes are removed and your locks released.",
    )
  })
})
