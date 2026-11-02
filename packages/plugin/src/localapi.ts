/*
 * OpenCode's local API, as the plugin reaches it from inside its own OpenCode
 * server, through what OpenCode publishes only: the background service from
 * @opencode/client's discover() (its registration file is the published
 * discovery contract), or `opencode serve` from its documented --port,
 * --hostname and password variables. Either is used only when its /api/info
 * names this process. The one call the plugin makes there sets a session's
 * shell environment (PUT /api/session/{id}/environment, which replaces the
 * environment that session's shells start with).
 */
import { discover } from "@opencode/client/service"

export interface LocalApi {
  url: string
  // The Basic credentials OpenCode wants (user "opencode"), when it has any.
  authorization?: string
}

function basic(password: string, username = "opencode"): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

// A command-line flag's value: `--name value` or `--name=value`.
function flag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""
    if (arg === `--${name}`) return args[i + 1]
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
  }
  return undefined
}

/*
 * `opencode serve`'s local API from its documented flags and password
 * (OPENCODE_PASSWORD first, as OpenCode reads it): none without a password,
 * or without --port (it may have moved past a busy port).
 */
export function serveApiOf(
  argv: string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): LocalApi | undefined {
  const args = argv.slice(2)
  if (!args.includes("serve")) return undefined
  const password = env.OPENCODE_PASSWORD || env.OPENCODE_SERVER_PASSWORD
  const port = Number(flag(args, "port"))
  if (!password || !Number.isInteger(port) || port <= 0 || port > 65_535)
    return undefined
  let host = flag(args, "hostname") || "127.0.0.1"
  if (["0.0.0.0", "::", "[::]"].includes(host)) host = "127.0.0.1"
  else if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`
  return { url: `http://${host}:${port}`, authorization: basic(password) }
}

// Whether the API answers, and as this very process (/api/info's pid).
async function isThisProcess(
  api: LocalApi,
  pid: number,
  timeoutMs = 3000,
): Promise<boolean> {
  try {
    const res = await fetch(`${api.url}/api/info`, {
      headers: api.authorization ? { authorization: api.authorization } : {},
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return false
    const info = (await res.json()) as { pid?: unknown }
    return info?.pid === pid
  } catch {
    return false
  }
}

// This OpenCode server's local API: the background service, else `opencode
// serve`; none when neither answers as this process.
export async function findLocalApi(
  options: {
    argv?: string[]
    env?: Record<string, string | undefined>
    pid?: number
  } = {},
): Promise<LocalApi | undefined> {
  const pid = options.pid ?? process.pid
  const service = await discover().catch(() => undefined)
  const candidates: (LocalApi | undefined)[] = [
    service && {
      url: service.url.replace(/\/+$/, ""),
      authorization: service.auth
        ? basic(service.auth.password, service.auth.username)
        : undefined,
    },
    serveApiOf(options.argv, options.env),
  ]
  for (const api of candidates)
    if (api && (await isThisProcess(api, pid))) return api
  return undefined
}

/*
 * A session's shell environment: OpenCode's own (the values that are set)
 * plus the session's values, which win.
 */
export function shellVariables(
  base: Record<string, string | undefined>,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base))
    if (typeof value === "string") out[key] = value
  return { ...out, ...values }
}

export async function setEnvironment(
  api: LocalApi,
  session: string,
  variables: Record<string, string>,
  timeoutMs = 5000,
): Promise<void> {
  const res = await fetch(
    `${api.url}/api/session/${encodeURIComponent(session)}/environment`,
    {
      method: "PUT",
      headers: {
        ...(api.authorization ? { authorization: api.authorization } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({ variables }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  )
  if (!res.ok)
    throw new Error(
      `OpenCode's local API answered ${res.status} ` +
        `to setting ${session}'s environment`,
    )
}
