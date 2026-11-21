/*
 * What OpenCode's background service runs as on a machine (spec, OpenCode
 * Plugin: Restart): the path of its binary and its environment. A plugin that
 * runs in that service writes them to opencode-service.json in the machine's
 * Autocode home (mode 0600; the file stays on the machine), and the server
 * reads them when it must start the service again, so that it starts as the
 * owner's shells started it and not with the bare environment of a systemd
 * user service (no ~/.opencode/bin on its PATH).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"

export interface ServiceRecord {
  exec: string
  env: Record<string, string>
  written_at: string
}

/*
 * Variables of one login session, one systemd unit or one start of the
 * service: a service started later gets its starter's own for these.
 */
const LEFT_OUT: RegExp[] = [
  /^SSH_/,
  /^XDG_SESSION_/,
  /^XDG_RUNTIME_DIR$/,
  /^DBUS_SESSION_BUS_ADDRESS$/,
  /^DISPLAY$/,
  /^WAYLAND_DISPLAY$/,
  /^XAUTHORITY$/,
  /^TMUX/,
  /^STY$/,
  /^WINDOWID$/,
  /^PWD$/,
  /^OLDPWD$/,
  /^SHLVL$/,
  /^_$/,
  /^INVOCATION_ID$/,
  /^JOURNAL_STREAM$/,
  /^MANAGERPID$/,
  /^SYSTEMD_EXEC_PID$/,
  /^MEMORY_PRESSURE_/,
  /^NOTIFY_SOCKET$/,
  /^OPENCODE_PTY_HANDOFF$/,
]

// The environment a later start of the service gets from this one.
export function keptEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of Object.keys(env).sort()) {
    const value = env[name]
    if (typeof value !== "string") continue
    if (LEFT_OUT.some((pattern) => pattern.test(name))) continue
    out[name] = value
  }
  return out
}

// The record's file: in the Autocode home (AUTOCODE_HOME, else ~/.autocode).
export function serviceRecordPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(
    env.AUTOCODE_HOME || join(homedir(), ".autocode"),
    "opencode-service.json",
  )
}

/*
 * Writes the record, whole or not at all, readable by its owner only; true
 * when the file changed. Nothing for a binary that is not a file at an
 * absolute path.
 */
export function writeServiceRecord(
  exec: string,
  env: Record<string, string | undefined>,
  path: string = serviceRecordPath(env),
  now: () => number = Date.now,
): boolean {
  if (!isAbsolute(exec) || !existsSync(exec)) return false
  const kept = keptEnvironment(env)
  const before = readServiceRecord(path)
  if (
    before &&
    before.exec === exec &&
    JSON.stringify(before.env) === JSON.stringify(kept)
  )
    return false
  const record: ServiceRecord = {
    exec,
    env: kept,
    written_at: new Date(now()).toISOString(),
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const next = `${path}.new`
  writeFileSync(next, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  chmodSync(next, 0o600)
  renameSync(next, path)
  return true
}

// The record, when the file holds one whose binary still exists.
export function readServiceRecord(
  path: string = serviceRecordPath(),
): ServiceRecord | undefined {
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"))
    if (typeof raw?.exec !== "string" || !isAbsolute(raw.exec)) return undefined
    if (!existsSync(raw.exec)) return undefined
    if (!raw.env || typeof raw.env !== "object") return undefined
    return {
      exec: raw.exec,
      env: keptEnvironment(raw.env),
      written_at: typeof raw.written_at === "string" ? raw.written_at : "",
    }
  } catch {
    return undefined
  }
}
