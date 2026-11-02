/*
 * Where the CLI finds its server and token: flags, then the environment (the
 * plugin sets AUTOCODE_URL and AUTOCODE_TOKEN in agent shells), then the client
 * config file, then the server's own admin token file; in an agent's shell only
 * the first two. With an expected server ID, the server's ID is checked before
 * any token is sent. Also the Autocode home (AUTOCODE_HOME, else ~/.autocode),
 * which holds everything of an install, and the client config in it.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { apiCall } from "@autocode/shared"
import { CliError, type Parsed } from "./args.ts"

export interface ClientConfigFile {
  url?: string
  consumer_token?: string
  admin_token?: string
  server_id?: string
}

// The server's data and tokens, bin/, client.json and the plugin's logs/ all
// live here.
export function autocodeHome(): string {
  return process.env.AUTOCODE_HOME || join(homedir(), ".autocode")
}

export function clientConfigPath(): string {
  return process.env.AUTOCODE_CONFIG || join(autocodeHome(), "client.json")
}

export function readClientConfig(): ClientConfigFile {
  const path = clientConfigPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ClientConfigFile
  } catch {
    return {}
  }
}

export function writeClientConfig(update: ClientConfigFile): string {
  const path = clientConfigPath()
  const merged = {
    ...readClientConfig(),
    ...Object.fromEntries(
      Object.entries(update).filter(([, v]) => v !== undefined),
    ),
  }
  // A folder made here is 0700; one that exists keeps its mode (AUTOCODE_CONFIG
  // may point anywhere).
  if (!existsSync(dirname(path)))
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export interface Connection {
  url: string
  token?: string
  call: (method: string, path: string, body?: unknown) => Promise<any>
}

// OpenCode names the session in its shells, and the plugin adds
// AUTOCODE_SESSION: such a shell is an agent's.
function inAgentShell(): boolean {
  return Boolean(
    process.env.OPENCODE_SESSION_ID || process.env.AUTOCODE_SESSION,
  )
}

export function connect(args: Parsed): Connection {
  const config = readClientConfig()
  const envUrl = process.env.AUTOCODE_URL
  const url = args.flags.url ?? envUrl ?? config.url ?? "http://127.0.0.1:4848"
  /*
   * The server ID to expect: --server-id, else AUTOCODE_SERVER_ID (the plugin
   * sets it beside AUTOCODE_URL), else the client config's when the URL is the
   * config's.
   */
  const expected =
    args.flags["server-id"] ??
    (process.env.AUTOCODE_SERVER_ID || undefined) ??
    (args.flags.url || envUrl ? undefined : config.server_id)
  // In an agent's shell the CLI acts as that agent only: never with the owner's
  // or the consumer token.
  const agentShell = inAgentShell()
  let token = args.flags.token ?? process.env.AUTOCODE_TOKEN
  if (!token && !agentShell) {
    token = config.admin_token ?? config.consumer_token
    const file = join(autocodeHome(), "admin.token")
    if (!token && existsSync(file)) token = readFileSync(file, "utf8").trim()
  }
  let checked: Promise<void> | undefined
  const check = async () => {
    if (!expected) return
    const info = await apiCall(
      url,
      undefined,
      "GET",
      "/v1/info",
      undefined,
      10_000,
    )
    if (info?.id !== expected)
      throw new CliError(
        `the server at ${url} is ${info?.id}, not ${expected}; ` +
          "refusing to send it a token",
        1,
      )
  }
  return {
    url,
    token,
    call: async (method, path, body) => {
      if (!token && agentShell)
        throw new CliError(
          "this shell belongs to an OpenCode session but has no " +
            "AUTOCODE_TOKEN (the Autocode server could not be reached " +
            "when the shell started): run the command in a new shell, " +
            "or pass --token",
          1,
        )
      checked ??= check()
      await checked
      return apiCall(url, token, method, path, body)
    },
  }
}
