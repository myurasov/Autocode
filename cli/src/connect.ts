/*
 * Where the CLI finds its server and token: flags (--token, or --token-file
 * for a token kept in a file), then the environment (the plugin sets
 * AUTOCODE_URL and AUTOCODE_TOKEN in agent shells), then the client config
 * file, then the server's own admin token file; in an agent's shell only
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

/*
 * The token for the owner's commands, outside an agent's shell: the client
 * config's admin token; else, for a server on this machine, the server's own
 * admin.token (so the owner's commands work there after a plain `plugin
 * install`, whose config holds only the consumer token); else the config's
 * consumer token; else that file.
 */
export function ownerToken(
  config: ClientConfigFile,
  at: { url: string; file?: string },
): string | undefined {
  if (config.admin_token) return config.admin_token
  let own = false
  try {
    const host = new URL(at.url).hostname.replace(/^\[|\]$/g, "")
    own = host === "127.0.0.1" || host === "localhost" || host === "::1"
  } catch {
    // not a URL: the request fails later and says so
  }
  if (own && at.file) return at.file
  return config.consumer_token ?? at.file
}

export interface Connection {
  url: string
  token?: string
  call: (
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ) => Promise<any>
}

// OpenCode names the session in its shells, and the plugin adds
// AUTOCODE_SESSION: such a shell is an agent's.
export function inAgentShell(): boolean {
  return Boolean(
    process.env.OPENCODE_SESSION_ID || process.env.AUTOCODE_SESSION,
  )
}

/*
 * --token-file FILE (1.1.0-rc7): the token is the file's content, without
 * the white space around it, so that it does not show in the machine's
 * process list as --token "$(cat FILE)" does. From here on it counts as
 * --token. No message says what a file holds.
 */
export function tokenFromFile(args: Parsed): void {
  const file = args.flags["token-file"]
  if (file === undefined) return
  if (args.flags.token !== undefined)
    throw new CliError("give --token or --token-file, not both", 2)
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (err) {
    const code = (err as { code?: string }).code
    const why =
      code === "ENOENT"
        ? "no such file"
        : code === "EISDIR"
          ? "it is a folder"
          : code === "EACCES"
            ? "permission denied"
            : "it cannot be read"
    throw new CliError(`cannot read the token file ${file}: ${why}`, 1)
  }
  const token = text.trim()
  if (!token) throw new CliError(`the token file ${file} is empty`, 1)
  if (/\s/.test(token))
    throw new CliError(
      `the token file ${file} must hold one token and nothing else`,
      1,
    )
  args.flags.token = token
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
    const file = join(autocodeHome(), "admin.token")
    token = ownerToken(config, {
      url,
      file: existsSync(file) ? readFileSync(file, "utf8").trim() : undefined,
    })
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
    call: async (method, path, body, timeoutMs) => {
      if (!token && agentShell)
        throw new CliError(
          "this shell belongs to an OpenCode session but has no " +
            "AUTOCODE_TOKEN, so it cannot act as the agent: in the " +
            "conversation, use the autocode_* tools instead (the plugin " +
            "puts the token into shells when it can reach the server; a " +
            "new shell may have it), or pass --token",
          1,
        )
      checked ??= check()
      await checked
      return apiCall(url, token, method, path, body, timeoutMs)
    },
  }
}
