/*
 * The server's start-up configuration: its ID (from --id, config.json in the
 * data folder, or the host name), the data folder, and the machine's Tailscale
 * address.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { AutocodeError, isValidId } from "@autocode/shared"

// A host name as a server ID: characters outside the ID rules become "-".
export function deriveServerId(host: string): string {
  const id = host
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255)
  return id || "autocode"
}

export interface ServerConfigFile {
  id?: string
}

export function readConfigFile(dataDir: string): ServerConfigFile {
  const path = join(dataDir, "config.json")
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ServerConfigFile
  } catch (err) {
    throw new AutocodeError(
      "bad_config",
      `cannot read ${path}: ${(err as Error).message}`,
      500,
    )
  }
}

// --id, then the config file, then the host name.
export function resolveServerId(
  flag: string | undefined,
  dataDir: string,
  host: string,
): string {
  const fromFile = readConfigFile(dataDir).id
  const id = flag ?? fromFile ?? deriveServerId(host)
  const source = flag
    ? "--id"
    : fromFile
      ? `${join(dataDir, "config.json")}`
      : "the host name"
  if (!isValidId(id))
    throw new AutocodeError(
      "bad_id",
      `the server ID from ${source} must be 1 to 255 characters ` +
        "from letters, digits, -, _, . and :, and not only dots " +
        `(got ${JSON.stringify(id)})`,
      500,
    )
  return id
}

// The data folder is made 0700 when it is created; a folder that exists (say
// `--data .`) keeps its mode.
export function ensureDataDir(dataDir: string) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 })
}

// The machine's Tailscale address (100.64.0.0/10), if it has one.
export function tailscaleAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces()))
    for (const addr of list ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue
      const [a, b] = addr.address.split(".").map(Number)
      if (a === 100 && (b ?? 0) >= 64 && (b ?? 0) <= 127) return addr.address
    }
  return undefined
}
