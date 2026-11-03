/*
 * Files for messages (spec, Agent Tools: Files): `send` reads a file inside
 * the agent's folder (text as text, anything else as base64 with a mime type
 * from its name); `read` writes a binary message to a path inside the folder.
 * A path that leads outside the folder is refused.
 */

import { lstatSync, realpathSync } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import type { Files } from "./tools.ts"

const MAX = 32_000

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".json": "application/json",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".parquet": "application/vnd.apache.parquet",
}

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream"
}

function inside(folder: string, target: string): boolean {
  const rel = relative(folder, target)
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  )
}

// The real path of `path` (relative to the folder), refused outside it.
function within(folder: string, path: string, mustExist: boolean): string {
  const root = realpathSync(folder)
  const target = resolve(root, path)
  const outside = () => new Error(`${path} is outside your folder (${root})`)
  // the path as written, then where its links lead
  if (!inside(root, target)) throw outside()
  let real = target
  if (mustExist) real = realpathSync(target)
  else {
    // the parent must exist inside the folder; the file itself may be new
    let parent = dirname(target)
    for (;;) {
      try {
        real = resolve(realpathSync(parent), relative(parent, target))
        break
      } catch {
        const up = dirname(parent)
        if (up === parent) throw new Error(`no folder for ${path}`)
        parent = up
      }
    }
  }
  if (!inside(root, real)) throw outside()
  return real
}

export function folderFiles(folder: () => string): Files {
  return {
    async read(path) {
      const real = within(folder(), path, true)
      // a text of 32,000 characters takes at most 4 bytes each
      const size = (await stat(real)).size
      if (size > MAX * 4)
        throw new Error(
          `${path} is ${size} bytes; a message holds ${MAX} characters`,
        )
      const bytes = new Uint8Array(await readFile(real))
      let text: string | undefined
      if (!bytes.includes(0))
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        } catch {}
      if (text !== undefined) {
        if (text.length > MAX)
          throw new Error(
            `${path} has ${text.length} characters; a message holds ${MAX}`,
          )
        return { text }
      }
      const data = Buffer.from(bytes).toString("base64")
      if (data.length > MAX)
        throw new Error(
          `${path} is ${bytes.length} bytes (${data.length} in base64); ` +
            `a message holds ${MAX} characters, about 24 KB`,
        )
      return { data, mime: mimeOf(real) }
    },
    async write(path, base64) {
      const real = within(folder(), path, false)
      // never through a link, which could lead outside the folder
      let link = false
      try {
        link = lstatSync(real).isSymbolicLink()
      } catch {}
      if (link) throw new Error(`${path} is a link; give another path`)
      await mkdir(dirname(real), { recursive: true })
      await writeFile(real, Buffer.from(base64, "base64"))
      return real
    },
  }
}
