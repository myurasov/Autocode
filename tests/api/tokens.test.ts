/*
 * Tokens: the owner's admin and consumer tokens, made at the first start and
 * saved in 0600 files, with only hashes in the database; the 401 and 403
 * answers; and the session tokens the plugin gets for its sessions.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  call,
  hello,
  sessionToken,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

const running: TestServer[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const t of running.splice(0)) await t.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autocode-tokens-"))
  dirs.push(dir)
  return join(dir, "data")
}

async function start(options: Parameters<typeof testServer>[0]) {
  const t = await testServer(options)
  running.push(t)
  return t
}

const TOKEN = /^ac[acs]_[A-Za-z0-9_-]{43}$/

describe("owner tokens", () => {
  test("the first start creates admin and consumer tokens, saved 0600 in a 0700 folder and shown once", async () => {
    const dir = freshDir()
    const t = await start({ dataDir: dir, presets: false })
    const admin = t.server.firstStartTokens?.admin ?? ""
    const consumer = t.server.firstStartTokens?.consumer ?? ""
    expect(admin).toMatch(TOKEN)
    expect(consumer).toMatch(TOKEN)
    expect(admin.startsWith("aca_")).toBe(true)
    expect(consumer.startsWith("acc_")).toBe(true)
    expect(readFileSync(join(dir, "admin.token"), "utf8").trim()).toBe(admin)
    expect(readFileSync(join(dir, "consumer.token"), "utf8").trim()).toBe(
      consumer,
    )
    expect(statSync(join(dir, "admin.token")).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, "consumer.token")).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect((await call(t.url, admin, "GET", "/v1/agents")).status).toBe(200)
    // the database and SQLite's own files beside it are the owner's alone too
    for (const file of ["autocode.db", "autocode.db-wal", "autocode.db-shm"])
      expect(
        `${file} ${(statSync(join(dir, file)).mode & 0o777).toString(8)}`,
      ).toBe(`${file} 600`)
  })

  test("the database holds only hashes of tokens, also after a rotation", async () => {
    const dir = freshDir()
    const t = await start({ dataDir: dir, presets: false })
    await hello(t, "m:1")
    const old = await sessionToken(t, "m:1", "ses_abc")
    expect(
      (await call(t.url, old, "POST", "/v1/agents", { id: "a:rot" })).status,
    ).toBe(201)
    expect(
      (await call(t.url, t.admin, "POST", "/v1/agents/a:rot/token/rotate"))
        .status,
    ).toBe(200)
    // the plugin polls, fetches its new token and acknowledges, as a real
    // plugin does
    const polled = await call(
      t.url,
      t.consumer,
      "GET",
      "/v1/hosts/m:1/next?wait=1&instance=inst-m:1",
    )
    const instruction = polled.body.instructions.find(
      (i: any) => i.type === "token",
    )
    const fresh = await sessionToken(t, "m:1", "ses_abc")
    await call(t.url, t.consumer, "POST", "/v1/hosts/m:1/events", {
      events: [
        {
          type: "ack",
          id: instruction.id,
          ok: true,
          result: { renewed: true },
        },
      ],
    })
    await t.server.checkpoint()
    const raw = readFileSync(join(dir, "autocode.db")).toString("latin1")
    for (const token of [t.admin, t.consumer, old, fresh])
      expect(raw.includes(token)).toBe(false)
    expect(/ac[acs]_[A-Za-z0-9_-]{43}/.test(raw)).toBe(false)
    expect(
      JSON.stringify(t.server.db.query("SELECT * FROM instructions").all()),
    ).not.toMatch(/ac[acs]_/)
  })

  test("a first start that cannot save the token files commits nothing, so the next start makes working ones", async () => {
    const dir = freshDir()
    const { startServer } = await import("@autocode/server")
    const options = {
      dataDir: dir,
      id: "t",
      listen: ["127.0.0.1:0"],
      maintenanceEvery: 0,
      log: () => {},
    }
    mkdirSync(join(dir, "admin.token"), { recursive: true })
    await expect(startServer(options)).rejects.toThrow()
    rmSync(join(dir, "admin.token"), { recursive: true, force: true })
    const server = await startServer(options)
    try {
      const admin = readFileSync(join(dir, "admin.token"), "utf8").trim()
      expect(server.firstStartTokens?.admin).toBe(admin)
      expect((await call(server.url, admin, "GET", "/v1/agents")).status).toBe(
        200,
      )
    } finally {
      await server.stop()
    }
  })

  test("when only one owner token is missing, only that one is made; the other's file is left alone", async () => {
    const dir = freshDir()
    const first = await testServer({ dataDir: dir, presets: false })
    const admin = first.admin
    first.server.db
      .query("UPDATE tokens SET revoked_at = 1 WHERE kind = 'consumer'")
      .run()
    await first.server.stop()
    const second = await start({ dataDir: dir, presets: false })
    expect(second.server.firstStartTokens?.admin).toBeUndefined()
    const consumer = second.server.firstStartTokens?.consumer ?? ""
    expect(consumer).toMatch(TOKEN)
    expect(readFileSync(join(dir, "admin.token"), "utf8").trim()).toBe(admin)
    expect(readFileSync(join(dir, "consumer.token"), "utf8").trim()).toBe(
      consumer,
    )
    expect((await call(second.url, admin, "GET", "/v1/agents")).status).toBe(
      200,
    )
    expect((await call(second.url, consumer, "GET", "/v1/hosts")).status).toBe(
      200,
    )
  })

  test("maintenance drops revoked tokens and acknowledged instructions after a day", async () => {
    const t = await start({ dataDir: freshDir() })
    await hello(t, "m:1")
    const old = await sessionToken(t, "m:1", "ses_1")
    await call(t.url, old, "POST", "/v1/agents", { id: "a:b" })
    await call(t.url, t.admin, "POST", "/v1/agents/a:b/token/rotate")
    const polled = await call(
      t.url,
      t.consumer,
      "GET",
      "/v1/hosts/m:1/next?wait=1&instance=inst-m:1",
    )
    await call(t.url, t.consumer, "POST", "/v1/hosts/m:1/events", {
      events: polled.body.instructions.map((i: any) => ({
        type: "ack",
        id: i.id,
        ok: true,
      })),
    })
    const count = (sql: string) =>
      (t.server.db.query(sql).get() as { n: number }).n
    t.server.maintenance()
    expect(
      count("SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NOT NULL"),
    ).toBe(1)
    // the rotation's instruction, and the registration's notice (tier 0b)
    expect(polled.body.instructions.map((i: any) => i.type).sort()).toEqual([
      "registration",
      "token",
    ])
    expect(count("SELECT COUNT(*) AS n FROM instructions")).toBe(2)
    t.clock.advance(25 * 3600_000)
    t.server.maintenance()
    expect(
      count("SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NOT NULL"),
    ).toBe(0)
    expect(count("SELECT COUNT(*) AS n FROM instructions")).toBe(0)
  })

  test("a later start creates nothing new and shows nothing; the old tokens still work", async () => {
    const dir = freshDir()
    const first = await testServer({ dataDir: dir, presets: false })
    const admin = first.admin
    await first.server.stop()
    const second = await start({ dataDir: dir, presets: false })
    expect(second.server.firstStartTokens).toBeUndefined()
    expect((await call(second.url, admin, "GET", "/v1/agents")).status).toBe(
      200,
    )
  })

  test("preset tokens (for automation) are used at the first start; malformed presets are refused", async () => {
    const t = await start({ dataDir: freshDir() })
    expect((await call(t.url, t.admin, "GET", "/v1/agents")).status).toBe(200)
    const { startServer } = await import("@autocode/server")
    await expect(
      startServer({
        dataDir: freshDir(),
        id: "x",
        listen: ["127.0.0.1:0"],
        presetTokens: { admin: "short" },
        log: () => {},
      }),
    ).rejects.toThrow(/admin token/)
  })
})

describe("authentication", () => {
  test("no token is 401, a wrong kind is 403, an unknown token is 401", async () => {
    const t = await start({})
    expect((await call(t.url, undefined, "GET", "/v1/agents")).status).toBe(401)
    expect((await call(t.url, "aca_nope", "GET", "/v1/agents")).status).toBe(
      401,
    )
    expect(
      (await call(t.url, t.consumer, "PATCH", "/v1/settings", { server: {} }))
        .status,
    ).toBe(403)
    expect(
      (await call(t.url, t.admin, "POST", "/v1/hosts/m:1/hello", {})).status,
    ).toBe(403)
  })
})

describe("session tokens", () => {
  test("the plugin gets a token for a session; it authenticates that session", async () => {
    const t = await start({})
    await hello(t, "m:1")
    const token = await sessionToken(t, "m:1", "ses_one")
    expect(token).toMatch(TOKEN)
    expect(token.startsWith("acs_")).toBe(true)
    const me = await call(t.url, token, "GET", "/v1/me")
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ registered: false, session: "ses_one" })
  })

  test("a session token is refused on owner and plugin routes", async () => {
    const t = await start({})
    await hello(t, "m:1")
    const token = await sessionToken(t, "m:1", "ses_one")
    expect(
      (await call(t.url, token, "PATCH", "/v1/settings", { server: {} }))
        .status,
    ).toBe(403)
    expect(
      (await call(t.url, token, "POST", "/v1/hosts/m:1/hello", {})).status,
    ).toBe(403)
  })

  test("asking again (a plugin restart) adds a token; the earlier one keeps working", async () => {
    const t = await start({})
    await hello(t, "m:1")
    const one = await sessionToken(t, "m:1", "ses_one")
    const two = await sessionToken(t, "m:1", "ses_one")
    expect(one).not.toBe(two)
    expect((await call(t.url, one, "GET", "/v1/me")).status).toBe(200)
    expect((await call(t.url, two, "GET", "/v1/me")).status).toBe(200)
  })

  // The owner, 2026-11-05: older session tokens are cleaned up; a running
  // job keeps the token it started with, so only unused ones go.
  test("a session token unused for 30 days is revoked; one in use is kept", async () => {
    const t = await start({})
    await hello(t, "m:1")
    const old = await sessionToken(t, "m:1", "ses_one")
    const used = await sessionToken(t, "m:1", "ses_one")
    const DAY = 86_400_000
    for (let day = 0; day < 29; day++) {
      t.clock.advance(DAY)
      expect((await call(t.url, used, "GET", "/v1/me")).status).toBe(200)
    }
    t.clock.advance(2 * DAY)
    t.server.maintenance()
    expect((await call(t.url, old, "GET", "/v1/me")).status).toBe(401)
    expect((await call(t.url, used, "GET", "/v1/me")).status).toBe(200)
    // the owner's tokens never expire this way
    expect((await call(t.url, t.admin, "GET", "/v1/info")).status).toBe(200)
    expect((await call(t.url, t.consumer, "GET", "/v1/hosts")).status).toBe(200)
  })

  test("a token for a session needs a host that said hello, and valid IDs", async () => {
    const t = await start({})
    const res = await call(
      t.url,
      t.consumer,
      "POST",
      "/v1/hosts/m:9/sessions/ses_x/token",
      {},
    )
    expect(res.status).toBe(404)
    await hello(t, "m:1")
    const bad = await call(
      t.url,
      t.consumer,
      "POST",
      "/v1/hosts/m:1/sessions/bad%20id/token",
      {},
    )
    expect(bad.status).toBe(400)
  })
})
