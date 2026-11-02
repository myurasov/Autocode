/*
 * The server's ID (from --id, else the config file, else the host name) as GET
 * /v1/info shows it; also /v1/whoami, /openapi.json and the API's 404 for an
 * unknown route.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { deriveServerId } from "@autocode/server/config"
import { VERSION } from "@autocode/shared"
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

function dataDir(config?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "autocode-info-"))
  dirs.push(dir)
  if (config) writeFileSync(join(dir, "config.json"), JSON.stringify(config))
  return dir
}

async function start(options: Parameters<typeof testServer>[0]) {
  const t = await testServer(options)
  running.push(t)
  return t
}

describe("server ID and GET /v1/info", () => {
  test("GET /v1/info answers anyone with the server ID and version", async () => {
    const t = await start({ id: "from-flag" })
    const res = await call(t.url, undefined, "GET", "/v1/info")
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: "from-flag", version: VERSION })
  })

  test("--id wins over the config file", async () => {
    const t = await start({
      id: "from-flag",
      dataDir: dataDir({ id: "from-config" }),
    })
    expect((await call(t.url, undefined, "GET", "/v1/info")).body.id).toBe(
      "from-flag",
    )
  })

  test("without --id the config file's ID is used", async () => {
    const t = await start({
      id: undefined,
      dataDir: dataDir({ id: "from-config" }),
    })
    expect((await call(t.url, undefined, "GET", "/v1/info")).body.id).toBe(
      "from-config",
    )
  })

  test("without either, the ID is derived from the host name", async () => {
    const t = await start({ id: undefined, dataDir: dataDir() })
    expect((await call(t.url, undefined, "GET", "/v1/info")).body.id).toBe(
      deriveServerId(hostname()),
    )
  })

  test("a host name becomes a valid ID: other characters turn into -, and an empty one falls back", () => {
    expect(deriveServerId("myspark3")).toBe("myspark3")
    expect(deriveServerId("Misha's MacBook Pro.local")).toBe(
      "Misha-s-MacBook-Pro.local",
    )
    expect(deriveServerId("--")).toBe("autocode")
    expect(deriveServerId("x".repeat(300)).length).toBe(255)
  })

  test("a bad ID in --id or the config file stops the start with a clear error", async () => {
    await expect(
      testServer({ id: "bad id", dataDir: dataDir() }),
    ).rejects.toThrow(/server ID/)
    await expect(
      testServer({ id: undefined, dataDir: dataDir({ id: "bad/id" }) }),
    ).rejects.toThrow(/server ID/)
  })

  test("GET /v1/whoami tells a session token's kind and session", async () => {
    const t = await start({})
    await hello(t, "m:1")
    const token = await sessionToken(t, "m:1", "ses_who")
    expect((await call(t.url, token, "GET", "/v1/whoami")).body).toEqual({
      kind: "session",
      session: "ses_who",
    })
  })

  test("GET /v1/whoami tells a token's kind (and a session token's session)", async () => {
    const t = await start({})
    expect((await call(t.url, t.admin, "GET", "/v1/whoami")).body).toEqual({
      kind: "admin",
    })
    expect((await call(t.url, t.consumer, "GET", "/v1/whoami")).body).toEqual({
      kind: "consumer",
    })
    expect((await call(t.url, undefined, "GET", "/v1/whoami")).status).toBe(401)
  })

  test("GET /openapi.json describes the routes", async () => {
    const t = await start({})
    const spec = (await call(t.url, undefined, "GET", "/openapi.json")).body
    expect(spec.openapi).toStartWith("3.")
    expect(Object.keys(spec.paths)).toContain("/v1/agents")
    expect(Object.keys(spec.paths)).toContain("/v1/hosts/{host}/next")
  })

  test("an unknown route answers 404 in the API's error shape", async () => {
    const t = await start({})
    const res = await call(t.url, undefined, "GET", "/v1/nope")
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("not_found")
  })
})
