/*
 * The plugin's own log (OpenCode's output belongs to the TUI): logs/plugin.log
 * in the Autocode home, so ~/.autocode/logs/plugin.log by default, rolled over
 * at 1 MB. Writing the log never throws.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { autocodeHome } from "./config.ts"

export function logPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(autocodeHome(env), "logs", "plugin.log")
}

export function log(line: string) {
  try {
    const file = logPath()
    // Folders made here are private, like the rest of the Autocode home.
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    try {
      if (statSync(file).size > 1_000_000) renameSync(file, `${file}.1`)
    } catch {}
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}
