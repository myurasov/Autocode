/*
 * `autocode plugin install` and `uninstall`: the plugin bundle into OpenCode's
 * global plugin folder, and the machine's client config (client.json in the
 * Autocode home) with the server URL and tokens.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { apiCall, shownVersion } from "@autocode/shared"
import { CliError, type Parsed } from "./args.ts"
import { writeClientConfig } from "./connect.ts"
import bundle from "./generated/plugin.ts"

export function opencodeConfigDir(flag?: string): string {
  if (flag) return flag
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "opencode",
  )
}

function pluginBundle(): string {
  if (!bundle)
    throw new CliError(
      "this autocode has no plugin bundle inside; build it with " +
        "bun packages/cli/build.ts",
    )
  return bundle
}

function secret(args: Parsed, name: string): string | undefined {
  const file = args.flags[`${name}-file`]
  if (file) return readFileSync(file, "utf8").trim()
  return args.flags[name]
}

export async function pluginInstall(args: Parsed): Promise<number> {
  const url = args.flags.url
  const consumer = secret(args, "consumer-token")
  if (!url || !consumer)
    throw new CliError(
      "usage: autocode plugin install --url <server url> " +
        "--consumer-token <token> | --consumer-token-file <file> " +
        "[--server-id <id>] " +
        "[--admin-token <token> | --admin-token-file <file>] " +
        "[--opencode-config-dir <dir>]",
      2,
    )
  const info = await apiCall(url, undefined, "GET", "/v1/info", undefined, 5000)
  const expected = args.flags["server-id"]
  if (expected && info.id !== expected)
    throw new CliError(`the server at ${url} is ${info.id}, not ${expected}`)
  await apiCall(url, consumer, "GET", "/v1/whoami", undefined, 5000).then(
    (who) => {
      if (who.kind !== "consumer")
        throw new CliError(
          `the token given as consumer token is a ${who.kind} token`,
        )
    },
    (err) => {
      throw new CliError(
        `the server refused the consumer token: ${(err as Error).message}`,
      )
    },
  )
  const dir = join(
    opencodeConfigDir(args.flags["opencode-config-dir"]),
    "plugins",
    "autocode",
  )
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "index.js.new"), pluginBundle())
  renameSync(join(dir, "index.js.new"), join(dir, "index.js"))
  const config = writeClientConfig({
    url: url.replace(/\/+$/, ""),
    consumer_token: consumer,
    server_id: expected,
    admin_token: secret(args, "admin-token"),
  })
  console.log(`plugin installed in ${dir}`)
  console.log(
    `client config ${config} points at ${info.id} ` +
      `${shownVersion(info.version)} (${url})`,
  )
  console.log(
    "OpenCode loads it with each workspace folder; restart running " +
      "OpenCode servers to pick it up",
  )
  return 0
}

export async function pluginUninstall(args: Parsed): Promise<number> {
  const dir = join(
    opencodeConfigDir(args.flags["opencode-config-dir"]),
    "plugins",
    "autocode",
  )
  const existed = existsSync(dir)
  rmSync(dir, { recursive: true, force: true })
  console.log(existed ? `removed ${dir}` : `no plugin at ${dir}`)
  return 0
}
