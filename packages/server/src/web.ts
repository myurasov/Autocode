/*
 * The web UI's request handler, which the server tries before the API: it
 * serves the app's files with safety and cache headers, and leaves API paths to
 * the API.
 */

import { existsSync, statSync } from "node:fs"
import { join, normalize, sep } from "node:path"

/*
 * The web UI's static files: from a folder (development) or embedded in the
 * binary (a map of URL path to file). Any GET outside the API that names no
 * file gets the app's index.html, so the app's own pages load directly.
 */
export interface WebFiles {
  dir?: string
  files?: Record<string, string>
}

// No other site may frame the app (it acts with the signed-in token), and no
// file is type-sniffed.
const SAFETY = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
}

export function webHandler(
  web: WebFiles | undefined,
): ((req: Request) => Response | undefined) | undefined {
  if (!web?.dir && !web?.files) return undefined
  const root = web.dir ? normalize(web.dir) : undefined

  const lookup = (path: string): string | undefined => {
    if (web.files) return web.files[path]
    if (!root) return undefined
    const file = normalize(join(root, path))
    if (
      file !== root &&
      !file.startsWith(root.endsWith(sep) ? root : root + sep)
    )
      return undefined
    try {
      return existsSync(file) && statSync(file).isFile() ? file : undefined
    } catch {
      return undefined
    }
  }

  return (req) => {
    if (req.method !== "GET" && req.method !== "HEAD") return undefined
    let path: string
    try {
      path = decodeURIComponent(new URL(req.url).pathname)
    } catch {
      return undefined
    }
    if (path.startsWith("/v1/") || path === "/v1" || path === "/openapi.json")
      return undefined
    const named = path === "/" ? undefined : lookup(path)
    const file = named ?? lookup("/index.html")
    if (!file) return undefined
    /*
     * The app's page is never cached, whatever path asked for it (the binary's
     * embedded files have other names); its assets have content hashes in their
     * names and are cached for an hour.
     */
    const page = !named || path === "/index.html"
    const cache = page ? "no-cache" : "public, max-age=3600"
    return new Response(Bun.file(file), {
      headers: { "cache-control": cache, ...SAFETY },
    })
  }
}
