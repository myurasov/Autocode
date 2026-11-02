/*
 * The server serves the web UI's static files, with the app's index for any
 * other page path.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "@autocode/server"
import { FakeClock, PRESET_ADMIN, PRESET_CONSUMER } from "../helpers/server.ts"

const dirs: string[] = []
const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const s of stops.splice(0)) await s()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function withWeb(
  web: { dir?: string; files?: Record<string, string> } | undefined,
) {
  const dataDir = mkdtempSync(join(tmpdir(), "autocode-web-data-"))
  dirs.push(dataDir)
  const server = await startServer({
    dataDir,
    id: "web",
    listen: ["127.0.0.1:0"],
    clock: new FakeClock(),
    maintenanceEvery: 0,
    presetTokens: { admin: PRESET_ADMIN, consumer: PRESET_CONSUMER },
    web,
    log: () => {},
  })
  stops.push(() => server.stop())
  return server.url
}

function site(): string {
  const dir = mkdtempSync(join(tmpdir(), "autocode-web-"))
  dirs.push(dir)
  writeFileSync(join(dir, "index.html"), "<html>app</html>")
  mkdirSync(join(dir, "assets"))
  writeFileSync(join(dir, "assets", "main.js"), "console.log(1)")
  return dir
}

describe("web UI files", () => {
  test("/ is the app; files are served with their types; other page paths get the app too", async () => {
    const url = await withWeb({ dir: site() })
    const root = await fetch(`${url}/`)
    expect(root.status).toBe(200)
    expect(root.headers.get("content-type")).toContain("text/html")
    expect(await root.text()).toBe("<html>app</html>")
    const js = await fetch(`${url}/assets/main.js`)
    expect(js.headers.get("content-type")).toContain("javascript")
    expect(await js.text()).toBe("console.log(1)")
    expect(await (await fetch(`${url}/agents`)).text()).toBe("<html>app</html>")
  })

  test("API paths never fall back to the app, and paths cannot leave the folder", async () => {
    const url = await withWeb({ dir: site() })
    const api = await fetch(`${url}/v1/nope`)
    expect(api.status).toBe(404)
    expect(((await api.json()) as any).error.code).toBe("not_found")
    const outside = await fetch(`${url}/..%2f..%2fetc/passwd`)
    expect(await outside.text()).toBe("<html>app</html>")
  })

  test("embedded files (the compiled binary, which renames them: index-hesr7jyr.html) work the same way", async () => {
    const dir = site()
    writeFileSync(join(dir, "index-hesr7jyr.html"), "<html>app</html>")
    writeFileSync(join(dir, "main-0ab12cd3.js"), "console.log(1)")
    const url = await withWeb({
      files: {
        "/index.html": join(dir, "index-hesr7jyr.html"),
        "/assets/main.js": join(dir, "main-0ab12cd3.js"),
      },
    })
    expect(await (await fetch(`${url}/`)).text()).toBe("<html>app</html>")
    const js = await fetch(`${url}/assets/main.js`)
    expect(await js.text()).toBe("console.log(1)")
    expect(js.headers.get("cache-control")).toBe("public, max-age=3600")
    // the app's page is never cached, also when asked for by name
    for (const path of ["/", "/index.html", "/settings"]) {
      const page = await fetch(`${url}${path}`)
      await page.text()
      expect(`${path} ${page.headers.get("cache-control")}`).toBe(
        `${path} no-cache`,
      )
    }
  })

  test("the app cannot be framed by another site (clickjacking), and nothing is type-sniffed", async () => {
    const url = await withWeb({ dir: site() })
    for (const path of ["/", "/settings", "/assets/main.js"]) {
      const res = await fetch(`${url}${path}`)
      await res.text()
      expect(res.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      )
      expect(res.headers.get("x-frame-options")).toBe("DENY")
      expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    }
  })

  test("without web files, / answers 404 in the API's error shape", async () => {
    const url = await withWeb(undefined)
    expect((await fetch(`${url}/`)).status).toBe(404)
  })
})
