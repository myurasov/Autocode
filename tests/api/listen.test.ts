/*
 * Where the server listens: the listen setting's names, and a Tailscale address
 * that appears only after the start (a server started at boot before Tailscale
 * is up).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type RunningServer,
  type ServerOptions,
  startServer,
} from "@autocode/server"
import { PRESET_ADMIN, PRESET_CONSUMER } from "../helpers/server.ts"
import { fetchJson, until } from "../helpers/wait.ts"

const servers: RunningServer[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

async function start(options: Partial<ServerOptions>) {
  const dataDir = mkdtempSync(join(tmpdir(), "autocode-listen-"))
  dirs.push(dataDir)
  const server = await startServer({
    dataDir,
    id: "listen-test",
    maintenanceEvery: 0,
    presetTokens: { admin: PRESET_ADMIN, consumer: PRESET_CONSUMER },
    log: () => {},
    ...options,
  })
  servers.push(server)
  return server
}

describe("listening", () => {
  test("names and a shared port, as in the listen setting: localhost is 127.0.0.1, duplicates are bound once", async () => {
    const port = await freePort()
    const server = await start({
      listen: [`localhost,127.0.0.1:${port}`],
      tailscale: () => undefined,
    })
    expect(server.urls).toEqual([`http://127.0.0.1:${port}`])
    expect((await fetchJson(`${server.url}/v1/info`)).id).toBe("listen-test")
  })

  test("a Tailscale address that is missing at the start is listened on as soon as it appears", async () => {
    let address: string | undefined
    const lines: string[] = []
    const server = await start({
      listen: ["localhost,tailscale:0"],
      tailscale: () => address,
      rebindEveryMs: 50,
      log: (line) => lines.push(line),
    })
    expect(server.urls.length).toBe(1)
    expect(lines.join("\n")).toContain("no Tailscale address yet")
    address = "127.0.0.1"
    await until(() => server.urls.length === 2, {
      timeoutMs: 5000,
      what: "the Tailscale address to be bound",
    })
    expect((await fetchJson(`${server.urls[1]}/v1/info`)).id).toBe(
      "listen-test",
    )
    expect(lines.join("\n")).toContain(`listening on ${server.urls[1]}`)
  })
})
