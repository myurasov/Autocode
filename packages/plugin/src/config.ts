/*
 * What the plugin knows about its machine: the Autocode home (where an install
 * keeps its files), the client config that `autocode plugin install` wrote
 * there, the host ID of a plugin instance, and its OpenCode process.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { machineName, slug } from "@autocode/shared"

export { machineName }

/*
 * The machine's client config, written by `autocode plugin install`: the server
 * URL, the consumer token and, optionally, the server ID the plugin should
 * insist on.
 */
export interface ClientConfig {
  url: string
  consumer_token: string
  server_id?: string
}

// Everything of an install lives in one folder: AUTOCODE_HOME, else
// ~/.autocode.
export function autocodeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AUTOCODE_HOME || join(homedir(), ".autocode")
}

// The client config file: AUTOCODE_CONFIG, else client.json in the Autocode
// home.
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AUTOCODE_CONFIG || join(autocodeHome(env), "client.json")
}

export function readClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): ClientConfig | undefined {
  const path = configPath(env)
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"))
    if (
      typeof raw?.url !== "string" ||
      typeof raw?.consumer_token !== "string" ||
      !raw.consumer_token
    )
      return undefined
    return {
      url: raw.url.replace(/\/+$/, ""),
      consumer_token: raw.consumer_token,
      server_id: raw.server_id || undefined,
    }
  } catch {
    return undefined
  }
}

/*
 * A plugin instance's host ID: stable for one machine, one OpenCode data folder
 * and one workspace folder, so the server keeps knowing the same host across
 * OpenCode restarts.
 */
export function hostId(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dataDir = join(
    env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
  )
  const hash = createHash("sha256")
    .update(`${dataDir}\n${directory}`)
    .digest("hex")
    .slice(0, 8)
  return `${machineName()}:${slug(basename(directory) || "root", 40)}:${hash}`
}

// OpenCode's documented global flags that take a value.
const VALUE_FLAGS = new Set(["--log-level", "--server", "--completions"])

/*
 * The OpenCode process this plugin instance runs in: its ID, and its kind from
 * its documented command line, read the Node way (the arguments start at
 * argv[2]): the background service (`opencode serve --service`) or `opencode
 * serve` (which a TUI or `opencode run` also starts for itself when it does
 * not use the service); anything else is "other".
 */
export function processOf(
  argv: string[] = process.argv,
  pid: number = process.pid,
): { pid: number; kind: string } {
  const args = argv.slice(2)
  let command: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""
    if (VALUE_FLAGS.has(arg)) i++
    else if (!arg.startsWith("-")) {
      command = arg
      break
    }
  }
  if (command !== "serve") return { pid, kind: "other" }
  return { pid, kind: args.includes("--service") ? "service" : "serve" }
}
