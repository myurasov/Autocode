/*
 * Starts an Autocode server in-process on an empty data folder, for API tests.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type RunningServer, startServer } from "@autocode/server"

export class FakeClock {
  constructor(public t = Date.parse("2026-10-28T12:00:00Z")) {}
  now = () => this.t
  advance(ms: number) {
    this.t += ms
  }
}

export interface TestServer {
  server: RunningServer
  url: string
  dataDir: string
  clock: FakeClock
  admin: string
  consumer: string
  stop: () => Promise<void>
}

export const PRESET_ADMIN = "aca_test_admin_token_0000000000000000000000"
export const PRESET_CONSUMER = "acc_test_consumer_token_000000000000000000"

export async function testServer(
  options: {
    id?: string
    dataDir?: string
    clock?: FakeClock
    pollWait?: number
    offlineAfter?: number
    takeoverGraceMs?: number
    presets?: boolean
  } = {},
): Promise<TestServer> {
  const dataDir =
    options.dataDir ?? mkdtempSync(join(tmpdir(), "autocode-api-"))
  const clock = options.clock ?? new FakeClock()
  const server = await startServer({
    dataDir,
    id: "id" in options ? options.id : "api-test",
    listen: ["127.0.0.1:0"],
    clock,
    pollWait: options.pollWait ?? 1,
    offlineAfter: options.offlineAfter ?? 3,
    takeoverGraceMs: options.takeoverGraceMs,
    maintenanceEvery: 0,
    presetTokens:
      options.presets === false
        ? undefined
        : { admin: PRESET_ADMIN, consumer: PRESET_CONSUMER },
    log: () => {},
  })
  return {
    server,
    url: server.url,
    dataDir,
    clock,
    admin:
      options.presets === false
        ? (server.firstStartTokens?.admin ?? "")
        : PRESET_ADMIN,
    consumer:
      options.presets === false
        ? (server.firstStartTokens?.consumer ?? "")
        : PRESET_CONSUMER,
    stop: async () => {
      await server.stop()
      if (!options.dataDir) rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

export interface Reply {
  status: number
  body: any
}

export async function call(
  url: string,
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply> {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers["content-type"] = "application/json"
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  let parsed: any = text
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {}
  return { status: res.status, body: parsed }
}

// Plays a plugin: says hello as a host and gets session tokens.
export async function hello(
  t: TestServer,
  host: string,
  extra: Record<string, unknown> = {},
): Promise<Reply> {
  return call(
    t.url,
    t.consumer,
    "POST",
    `/v1/hosts/${encodeURIComponent(host)}/hello`,
    {
      instance: `inst-${host}`,
      machine: host.split(":")[0],
      directory: "/work",
      opencode: { version: "2.2.0" },
      plugin: { version: "0.1.0" },
      ...extra,
    },
  )
}

export async function sessionToken(
  t: TestServer,
  host: string,
  session: string,
): Promise<string> {
  const res = await call(
    t.url,
    t.consumer,
    "POST",
    `/v1/hosts/${encodeURIComponent(host)}/sessions/${session}/token`,
    {
      instance: `inst-${host}`,
      directory: "/work",
    },
  )
  if (res.status !== 200)
    throw new Error(
      `token request failed: ${res.status} ${JSON.stringify(res.body)}`,
    )
  return res.body.token
}
