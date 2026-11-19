/*
 * Host records expire (1.0.1; the owner, 2026-11-19: "lets implement fix for
 * stale host records": a server held 299 of them, 4 online, every folder
 * OpenCode had ever opened). A host that has been offline for
 * host_expire_after (a day) is forgotten with its sessions, their tokens
 * and its queued instructions, unless an agent, a job or a run still needs
 * it; a folder that comes back is a host again. The owner removes one
 * offline host at once.
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  call,
  hello,
  registered,
  sessionToken,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

const running: TestServer[] = []
afterEach(async () => {
  for (const t of running.splice(0)) await t.stop()
})

async function start() {
  const t = await testServer({ offlineAfter: 3 })
  running.push(t)
  return t
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

const owner = (t: TestServer, method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)

const hostIds = async (t: TestServer) =>
  (await owner(t, "GET", "/v1/hosts")).body.hosts.map((h: any) => h.id)

// Every host has gone quiet: the upkeep marks them offline.
async function offline(t: TestServer) {
  t.clock.advance(5_000)
  t.server.maintenance()
}

const JOB = {
  description: "Summarizes the day's mail",
  model: "fake/main",
  prompt: "Summarize today's mail in five lines.",
  trigger: "fire-only",
  to: "owner",
}

describe("a host's record expires", () => {
  test("a host offline for a day is forgotten, with its sessions and their tokens; when its folder comes back it is a host again", async () => {
    const t = await start()
    await hello(t, "m:1")
    // a hello says whether it made the host's record: the plugin's kept
    // session tokens are dead when it did
    const review = () => hello(t, "m:2", { directory: "/tmp/review-1" })
    expect((await review()).body.created).toBe(true)
    expect((await review()).body.created).toBe(false)
    const token = await sessionToken(t, "m:2", "ses_2")
    expect((await call(t.url, token, "GET", "/v1/whoami")).status).toBe(200)
    await offline(t)
    const lastSeen = new Date(t.clock.now() - 5_000).toISOString()
    // an hour short of a day: both are still there, offline; m:1 is heard
    // from again
    t.clock.advance(DAY - HOUR)
    await hello(t, "m:1")
    t.server.maintenance()
    expect(await hostIds(t)).toEqual(["m:1", "m:2"])
    // a day and an hour: m:2 goes; m:1, offline for two hours, stays
    t.clock.advance(2 * HOUR)
    t.server.maintenance()
    expect(await hostIds(t)).toEqual(["m:1"])
    const removed = (await owner(t, "GET", "/v1/history?kind=host.removed"))
      .body.history
    expect(removed.map((h: any) => [h.host, h.data])).toEqual([
      [
        "m:2",
        {
          by: "expired",
          machine: "m",
          directory: "/tmp/review-1",
          last_seen: lastSeen,
        },
      ],
    ])
    // its sessions went with it, and their tokens
    expect((await call(t.url, token, "GET", "/v1/whoami")).status).toBe(401)
    // nothing is left that a second upkeep would trip over
    t.server.maintenance()
    expect(await hostIds(t)).toEqual(["m:1"])
    // the folder is opened again: a host again, first seen now, and its
    // session gets a new token
    expect((await review()).body.created).toBe(true)
    const back = (await owner(t, "GET", "/v1/hosts")).body.hosts.find(
      (h: any) => h.id === "m:2",
    )
    expect(back).toMatchObject({
      online: true,
      directory: "/tmp/review-1",
      first_seen: new Date(t.clock.now()).toISOString(),
    })
    const again = await sessionToken(t, "m:2", "ses_2")
    expect(again).not.toBe(token)
    expect((await call(t.url, again, "GET", "/v1/whoami")).body).toEqual({
      kind: "session",
      session: "ses_2",
    })
  })

  test("not while an agent is registered there, a job is set on it, or a run still runs there", async () => {
    const t = await start()
    for (const host of ["a:1", "j:1", "r:1", "z:1"]) await hello(t, host)
    await registered(t, "a:1", "ses_a", "team:a")
    expect(
      (await owner(t, "PUT", "/v1/jobs/mail", { ...JOB, host: "j:1" })).status,
    ).toBe(201)
    // a run that waits for its host, of a job that is deleted under it
    await owner(t, "PUT", "/v1/jobs/once", { ...JOB, host: "r:1" })
    expect((await owner(t, "POST", "/v1/jobs/once/run")).status).toBeLessThan(
      300,
    )
    t.server.tick()
    expect((await owner(t, "DELETE", "/v1/jobs/once")).status).toBe(200)
    await offline(t)
    t.clock.advance(8 * DAY)
    t.server.maintenance()
    expect(await hostIds(t)).toEqual(["a:1", "j:1", "r:1"])
    // the agent and the job go: so do their hosts, offline all that time
    await owner(t, "DELETE", "/v1/agents/team:a")
    await owner(t, "DELETE", "/v1/jobs/mail")
    t.server.maintenance()
    expect(await hostIds(t)).toEqual(["r:1"])
  })

  test("host_expire_after sets how long; 0 keeps every record; it is the server's, not an agent's", async () => {
    const t = await start()
    const set = (value: unknown) =>
      owner(t, "PATCH", "/v1/settings", {
        server: { host_expire_after: value },
      })
    const view = (await owner(t, "GET", "/v1/settings")).body
    expect(view.defaults.host_expire_after).toBe("1d")
    expect(view.schema.host_expire_after).toMatchObject({
      kind: "duration",
      scope: "server",
    })
    await hello(t, "m:1")
    await offline(t)
    expect((await set("0")).status).toBe(200)
    t.clock.advance(20 * DAY)
    t.server.maintenance()
    expect(await hostIds(t)).toEqual(["m:1"])
    expect((await set("soon")).status).toBe(400)
    expect(
      (
        await owner(t, "PATCH", "/v1/settings", {
          agents: { "team:a": { host_expire_after: "1h" } },
        })
      ).status,
    ).toBe(400)
    // an hour: the host, offline for twenty days, goes at the next upkeep
    expect((await set("1h")).status).toBe(200)
    t.server.maintenance()
    expect(await hostIds(t)).toEqual([])
  })

  test("a host that is refused as too old stays while it keeps asking", async () => {
    const t = await start()
    const old = () => hello(t, "mac:1", { opencode: { version: "2.2.0" } })
    expect((await old()).status).toBe(426)
    for (let day = 0; day < 9; day++) {
      t.clock.advance(DAY)
      await old()
      t.server.maintenance()
    }
    expect(await hostIds(t)).toEqual(["mac:1"])
    // it stops asking: gone a day later
    t.clock.advance(DAY + HOUR)
    t.server.maintenance()
    expect(await hostIds(t)).toEqual([])
  })
})

describe("the owner removes a host", () => {
  test("DELETE /v1/hosts/{host}: an offline host at once; not an online one, one in use, or for the consumer token", async () => {
    const t = await start()
    await hello(t, "m:1")
    await hello(t, "a:1")
    await registered(t, "a:1", "ses_a", "team:a")
    const online = await owner(t, "DELETE", "/v1/hosts/m:1")
    expect([online.status, online.body.error.code]).toEqual([
      409,
      "host_online",
    ])
    await offline(t)
    expect(
      (await call(t.url, t.consumer, "DELETE", "/v1/hosts/m:1")).status,
    ).toBe(403)
    const used = await owner(t, "DELETE", "/v1/hosts/a:1")
    expect([used.status, used.body.error.code]).toEqual([409, "host_in_use"])
    expect(used.body.error.message).toContain("team:a")
    const gone = await owner(t, "DELETE", "/v1/hosts/m:1")
    expect([gone.status, gone.body]).toEqual([200, { removed: "m:1" }])
    expect(await hostIds(t)).toEqual(["a:1"])
    const removed = (await owner(t, "GET", "/v1/history?kind=host.removed"))
      .body.history
    expect(removed.map((h: any) => [h.host, h.data.by])).toEqual([
      ["m:1", "owner"],
    ])
    const again = await owner(t, "DELETE", "/v1/hosts/m:1")
    expect([again.status, again.body.error.code]).toEqual([404, "unknown_host"])
  })
})
