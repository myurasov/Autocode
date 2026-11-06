/*
 * Locks and semaphores (spec, Locks and Semaphores; tier 0c), the queue logic
 * on its own: an in-memory store and a fake clock. The first acquire creates
 * a lock with its capacity; another capacity is refused; try, queue in
 * arrival order; a ttl is required; renew, release, expiry with a notice;
 * empty locks are removed; unregistering releases everything.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { History } from "@autocode/server/history"
import { type LockNotice, Locks } from "@autocode/server/locks"
import { openStore } from "@autocode/server/store"

const MIN = 60_000
let t: number
let locks: Locks
let notices: LockNotice[]
let db: ReturnType<typeof openStore>

const agents = ["team:a", "team:b", "team:c", "team:d"]

beforeEach(() => {
  t = Date.parse("2026-10-28T12:00:00Z")
  db = openStore(":memory:")
  db.query(
    "INSERT INTO hosts (id, machine, directory, instance, online, " +
      "first_seen, last_seen) VALUES ('m:1', 'm', '/w', 'i', 1, 0, 0)",
  ).run()
  for (const [n, id] of agents.entries()) {
    db.query(
      "INSERT INTO sessions (id, host_id, directory, created_at, " +
        "last_seen) VALUES (?, 'm:1', '/w', 0, 0)",
    ).run(`ses_${n}`)
    db.query(
      "INSERT INTO agents (id, description, session_id, registered_at, " +
        "last_active) VALUES (?, '', ?, 0, 0)",
    ).run(id, `ses_${n}`)
  }
  notices = []
  locks = new Locks(
    db,
    new History(db, () => t),
    () => t,
    (n) => notices.push(n),
  )
})

const holders = (name: string) =>
  locks.get(name)?.holders.map((h) => h.agent) ?? []
const line = (name: string) => locks.get(name)?.queue.map((q) => q.agent) ?? []

describe("acquire", () => {
  test("the first acquire creates the lock (a mutex by default) and holds it until its ttl", () => {
    const r = locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    expect(r).toMatchObject({ granted: true, lock: { name: "gpu-0", max: 1 } })
    expect(locks.get("gpu-0")).toMatchObject({
      name: "gpu-0",
      max: 1,
      holders: [
        {
          agent: "team:a",
          since: "2026-10-28T12:00:00.000Z",
          expires: "2026-10-28T12:10:00.000Z",
        },
      ],
      queue: [],
    })
  })

  test("a ttl is required, and a name follows the ID rules", () => {
    expect(() => locks.acquire("team:a", "gpu-0", {} as any)).toThrow(/ttl/)
    expect(() => locks.acquire("team:a", "gpu-0", { ttl: "soon" })).toThrow(
      /duration/,
    )
    expect(() => locks.acquire("team:a", "gpu-0", { ttl: "0s" })).toThrow(/ttl/)
    expect(() => locks.acquire("team:a", "a b", { ttl: "1m" })).toThrow(
      /lock name/,
    )
    expect(locks.get("gpu-0")).toBeUndefined()
  })

  test("max makes a semaphore; another capacity is refused; left out it takes the lock's", () => {
    locks.acquire("team:a", "gpu", { ttl: "1h", max: 2 })
    expect(locks.acquire("team:b", "gpu", { ttl: "1h" }).granted).toBe(true)
    expect(holders("gpu")).toEqual(["team:a", "team:b"])
    expect(() => locks.acquire("team:c", "gpu", { ttl: "1h", max: 3 })).toThrow(
      /capacity 2/,
    )
    expect(() =>
      locks.acquire("team:c", "other", { ttl: "1h", max: 0 }),
    ).toThrow(/max/)
  })

  test("try: now or refused, with who holds it", () => {
    locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    expect(() =>
      locks.acquire("team:b", "gpu-0", { ttl: "10m", mode: "try" }),
    ).toThrow(/held by team:a/)
    expect(line("gpu-0")).toEqual([])
  })

  test("queue: in arrival order, with each one's place", () => {
    locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    t += 1000
    expect(locks.acquire("team:b", "gpu-0", { ttl: "10m" })).toMatchObject({
      granted: false,
      position: 1,
    })
    t += 1000
    expect(locks.acquire("team:c", "gpu-0", { ttl: "10m" })).toMatchObject({
      granted: false,
      position: 2,
    })
    expect(line("gpu-0")).toEqual(["team:b", "team:c"])
    // nobody jumps the queue, even when a place is free
    locks.acquire("team:d", "sem", { ttl: "10m", max: 2 })
    expect(holders("sem")).toEqual(["team:d"])
  })

  test("again by its holder: renewed to the new ttl; by one in the queue: it keeps its place", () => {
    locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    locks.acquire("team:b", "gpu-0", { ttl: "10m" })
    locks.acquire("team:c", "gpu-0", { ttl: "10m" })
    t += MIN
    const again = locks.acquire("team:a", "gpu-0", { ttl: "1h" })
    expect(again).toMatchObject({ granted: true })
    expect(locks.get("gpu-0")?.holders[0]?.expires).toBe(
      "2026-10-28T13:01:00.000Z",
    )
    expect(locks.acquire("team:c", "gpu-0", { ttl: "10m" })).toMatchObject({
      granted: false,
      position: 2,
    })
  })
})

describe("release, renew, expiry", () => {
  test("release hands the lock to the oldest in the queue, with a notice; the ttl counts from the grant", () => {
    locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    locks.acquire("team:b", "gpu-0", { ttl: "30m" })
    locks.acquire("team:c", "gpu-0", { ttl: "10m" })
    t += 5 * MIN
    locks.release("team:a", "gpu-0")
    expect(holders("gpu-0")).toEqual(["team:b"])
    expect(locks.get("gpu-0")?.holders[0]?.expires).toBe(
      "2026-10-28T12:35:00.000Z",
    )
    expect(line("gpu-0")).toEqual(["team:c"])
    expect(notices).toEqual([
      {
        agent: "team:b",
        kind: "granted",
        lock: "gpu-0",
        max: 1,
        expires: Date.parse("2026-10-28T12:35:00.000Z"),
        ttl: 30 * MIN,
      },
    ])
  })

  test("release by one in the queue leaves the queue; release of nothing is refused", () => {
    locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    locks.acquire("team:b", "gpu-0", { ttl: "10m" })
    expect(locks.release("team:b", "gpu-0")).toEqual({ released: "queued" })
    expect(line("gpu-0")).toEqual([])
    expect(() => locks.release("team:c", "gpu-0")).toThrow(/does not hold/)
    expect(() => locks.release("team:c", "nothing")).toThrow(/no lock/)
  })

  test("a lock with no holders and no queue is removed", () => {
    locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    locks.release("team:a", "gpu-0")
    expect(locks.get("gpu-0")).toBeUndefined()
    expect(locks.list()).toEqual([])
    // created again, with a new capacity
    locks.acquire("team:a", "gpu-0", { ttl: "10m", max: 3 })
    expect(locks.get("gpu-0")?.max).toBe(3)
  })

  test("renew: the hold's ttl from now (the one it was taken with by default); only a holder", () => {
    locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    locks.acquire("team:b", "gpu-0", { ttl: "10m" })
    t += 8 * MIN
    expect(locks.renew("team:a", "gpu-0").expires).toBe(
      "2026-10-28T12:18:00.000Z",
    )
    expect(locks.renew("team:a", "gpu-0", "1h").expires).toBe(
      "2026-10-28T13:08:00.000Z",
    )
    expect(() => locks.renew("team:b", "gpu-0")).toThrow(/does not hold/)
  })

  test("an expired hold is freed: its former holder is told, the next in the queue gets it", () => {
    locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    locks.acquire("team:b", "gpu-0", { ttl: "10m" })
    t += 10 * MIN - 1
    locks.tick()
    expect(holders("gpu-0")).toEqual(["team:a"])
    t += 1
    locks.tick()
    expect(holders("gpu-0")).toEqual(["team:b"])
    expect(notices.map((n) => [n.agent, n.kind])).toEqual([
      ["team:a", "expired"],
      ["team:b", "granted"],
    ])
    t += 10 * MIN
    locks.tick()
    expect(locks.get("gpu-0")).toBeUndefined()
  })

  test("a semaphore grants as many as come free, in order", () => {
    locks.acquire("team:a", "sem", { ttl: "10m", max: 2 })
    locks.acquire("team:b", "sem", { ttl: "20m" })
    locks.acquire("team:c", "sem", { ttl: "10m" })
    locks.acquire("team:d", "sem", { ttl: "10m" })
    t += 10 * MIN
    locks.tick()
    expect(holders("sem")).toEqual(["team:b", "team:c"])
    expect(line("sem")).toEqual(["team:d"])
  })

  test("unregistering releases every hold and leaves every queue; the next get theirs", () => {
    locks.acquire("team:a", "x", { ttl: "10m" })
    locks.acquire("team:a", "y", { ttl: "10m" })
    locks.acquire("team:b", "x", { ttl: "10m" })
    locks.acquire("team:c", "y", { ttl: "10m" })
    locks.acquire("team:a", "z", { ttl: "10m" })
    locks.acquire("team:b", "z", { ttl: "10m" })
    locks.release("team:a", "z")
    locks.acquire("team:a", "z", { ttl: "10m" })
    notices = []
    locks.unregistered("team:a")
    expect(holders("x")).toEqual(["team:b"])
    expect(holders("y")).toEqual(["team:c"])
    expect(holders("z")).toEqual(["team:b"])
    expect(line("z")).toEqual([])
    expect(notices.map((n) => `${n.agent} ${n.lock}`).sort()).toEqual([
      "team:b x",
      "team:c y",
    ])
  })

  test("an agent's own view: what it holds and where it waits", () => {
    locks.acquire("team:a", "x", { ttl: "10m" })
    locks.acquire("team:b", "x", { ttl: "10m" })
    locks.acquire("team:b", "y", { ttl: "10m" })
    expect(locks.of("team:b")).toEqual({
      held: [{ name: "y", expires: "2026-10-28T12:10:00.000Z", max: 1 }],
      queued: [{ name: "x", position: 1, max: 1 }],
    })
  })

  test("list: by pattern, sorted by name", () => {
    for (const name of ["gpu:b", "gpu:a", "data:x"])
      locks.acquire("team:a", name, { ttl: "10m" })
    expect(locks.list().map((l) => l.name)).toEqual([
      "data:x",
      "gpu:a",
      "gpu:b",
    ])
    expect(locks.list("gpu:*").map((l) => l.name)).toEqual(["gpu:a", "gpu:b"])
  })

  // Found by the 0c review (2026-11-05).
  test("a hold past its ttl counts as free before the tick: no renew, no re-acquire ahead of the queue", () => {
    locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    locks.acquire("team:b", "gpu-0", { ttl: "10m" })
    t += 10 * MIN
    expect(() => locks.renew("team:a", "gpu-0")).toThrow(/does not hold/)
    expect(holders("gpu-0")).toEqual(["team:b"])
    expect(notices.map((n) => [n.agent, n.kind])).toEqual([
      ["team:a", "expired"],
      ["team:b", "granted"],
    ])
    t += 10 * MIN
    // again by its holder after the ttl: a new acquire, not a renewal
    locks.acquire("team:c", "solo", { ttl: "1m" })
    t += 2 * MIN
    expect(locks.acquire("team:d", "solo", { ttl: "1m" }).granted).toBe(true)
    expect(holders("solo")).toEqual(["team:d"])
  })

  test("acquire by one in the queue takes its new ttl; try by one in the queue is refused", () => {
    locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    locks.acquire("team:b", "gpu-0", { ttl: "10m" })
    locks.acquire("team:b", "gpu-0", { ttl: "2h" })
    expect(locks.get("gpu-0")?.queue[0]?.ttl).toBe("2h")
    expect(() =>
      locks.acquire("team:b", "gpu-0", { ttl: "2h", mode: "try" }),
    ).toThrow(/held by team:a/)
    expect(line("gpu-0")).toEqual(["team:b"])
  })

  test("a notice that cannot be sent does not stop the others", () => {
    const sent: string[] = []
    const flaky = new Locks(
      db,
      new History(db, () => t),
      () => t,
      (n) => {
        if (n.agent === "team:a") throw new Error("gone")
        sent.push(`${n.agent} ${n.kind}`)
      },
    )
    flaky.acquire("team:a", "gpu-0", { ttl: "10m" })
    flaky.acquire("team:b", "gpu-0", { ttl: "10m" })
    flaky.release("team:a", "gpu-0", "owner")
    expect(sent).toEqual(["team:b granted"])
  })

  test("the owner taking an agent out of the queue tells it", () => {
    locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    locks.acquire("team:b", "gpu-0", { ttl: "10m" })
    locks.release("team:b", "gpu-0", "owner")
    expect(notices).toEqual([
      expect.objectContaining({
        agent: "team:b",
        kind: "removed",
        lock: "gpu-0",
      }),
    ])
  })

  test("close ends the waits", async () => {
    locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    locks.acquire("team:b", "gpu-0", { ttl: "10m" })
    const started = Date.now()
    const waiting = locks.wait("team:b", "gpu-0", 20_000)
    locks.close()
    expect(await waiting).toMatchObject({ held: false, position: 1 })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("entries of agents that are gone are cleared at the start", () => {
    locks.acquire("team:a", "gpu-0", { ttl: "10m" })
    locks.acquire("team:b", "gpu-0", { ttl: "10m" })
    db.query("PRAGMA foreign_keys = OFF").run()
    db.query("DELETE FROM agents WHERE id = 'team:a'").run()
    locks.sweep()
    expect(holders("gpu-0")).toEqual(["team:b"])
  })
})
