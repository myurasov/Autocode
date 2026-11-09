/*
 * The CLI commands that call the API: info, agents, hosts, token, settings and
 * history.
 */

import { apiCall, shownVersion } from "@autocode/shared"
import { CliError, type Parsed } from "./args.ts"
import { connect } from "./connect.ts"

// Owner commands (and the agent commands scripts use), each a thin wrapper over
// the API. --json prints the API's own data; otherwise a plain table.

// A time to the minute in this machine's zone, with the zone's name (the
// review of 0b2: a time without its zone is ambiguous).
export function local(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(d)
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? ""
  return (
    `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")} ` +
    p("timeZoneName")
  )
}

export function table(rows: string[][], header: string[]): string {
  const all = [header, ...rows]
  const widths = header.map((_, i) =>
    Math.max(...all.map((r) => (r[i] ?? "").length)),
  )
  return all
    .map((r) =>
      r
        .map((cell, i) =>
          i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0),
        )
        .join("  "),
    )
    .join("\n")
}

function print(args: Parsed, data: unknown, text: () => string) {
  console.log(
    args.switches.has("json") ? JSON.stringify(data, null, 2) : text(),
  )
}

export async function info(args: Parsed): Promise<number> {
  const { url } = connect(args)
  const res = await apiCall(
    url,
    undefined,
    "GET",
    "/v1/info",
    undefined,
    10_000,
  )
  print(
    args,
    res,
    () => `server ${res.id}, autocode ${shownVersion(res.version)}, at ${url}`,
  )
  return 0
}

export async function agents(args: Parsed): Promise<number> {
  const [sub, ...rest] = args.words
  const c = connect(args)
  if (sub === "rm") {
    const id = rest[0]
    if (!id) throw new CliError("usage: autocode agents rm <agent>", 2)
    const res = await c.call("DELETE", `/v1/agents/${encodeURIComponent(id)}`)
    print(args, res, () => `unregistered ${id}`)
    return 0
  }
  if (sub === "register") {
    const id = rest[0]
    const session = args.flags.session
    if (!id || !session)
      throw new CliError(
        "usage: autocode agents register <agent> --session <session> [--force]",
        2,
      )
    const res = await c.call("POST", "/v1/agents", {
      id,
      session,
      force: args.switches.has("force"),
      ...(args.flags.description === undefined
        ? {}
        : { description: args.flags.description }),
    })
    print(args, res, () => `${res.agent.id} is now ${res.agent.session}`)
    return 0
  }
  const pattern = sub
  const res = await c.call(
    "GET",
    `/v1/agents${pattern ? `?match=${encodeURIComponent(pattern)}` : ""}`,
  )
  print(args, res.agents, () => {
    if (!res.agents.length)
      return pattern ? `no agents match ${pattern}` : "no agents"
    const owner = res.agents[0]?.session !== undefined
    return owner
      ? table(
          res.agents.map((a: any) => [
            a.id,
            a.status,
            a.machine,
            a.cost ? dollars(a.cost.today_usd) : "",
            a.cost ? share(a.cost.context_share) : "",
            local(a.last_active),
            a.description,
          ]),
          [
            "ID",
            "STATUS",
            "MACHINE",
            "TODAY",
            "CONTEXT",
            "LAST ACTIVE",
            "DESCRIPTION",
          ],
        )
      : table(
          res.agents.map((a: any) => [
            a.id,
            a.status,
            local(a.last_active),
            a.description,
          ]),
          ["ID", "STATUS", "LAST ACTIVE", "DESCRIPTION"],
        )
  })
  return 0
}

export async function hosts(args: Parsed): Promise<number> {
  const res = await connect(args).call("GET", "/v1/hosts")
  print(args, res.hosts, () => {
    if (!res.hosts.length) return "no hosts yet: no plugin has connected"
    return table(
      res.hosts.map((h: any) => [
        h.id,
        h.machine,
        h.directory,
        h.online ? "yes" : "no",
        [h.process_kind, h.process_pid].filter(Boolean).join(" "),
        h.shell_values === true ? "yes" : h.shell_values === false ? "no" : "",
        shownVersion(h.opencode_version ?? ""),
        local(h.last_seen),
      ]),
      [
        "ID",
        "MACHINE",
        "FOLDER",
        "ONLINE",
        "PROCESS",
        "SHELL VALUES",
        "OPENCODE",
        "LAST SEEN",
      ],
    )
  })
  return 0
}

export async function token(args: Parsed): Promise<number> {
  const [sub, id] = args.words
  if (sub !== "rotate" || !id)
    throw new CliError("usage: autocode token rotate <agent>", 2)
  const res = await connect(args).call(
    "POST",
    `/v1/agents/${encodeURIComponent(id)}/token/rotate`,
  )
  print(
    args,
    res,
    () =>
      `rotated the token of ${id} (session ${res.session}); its plugin ` +
      "gets the new one",
  )
  return 0
}

export async function settings(args: Parsed): Promise<number> {
  const [sub, key, raw] = args.words
  const c = connect(args)
  const agent = args.flags.agent
  const match = args.flags.match
  if (agent && match) throw new CliError("use either --agent or --match", 2)

  if (sub === "set" || sub === "unset") {
    if (!key || (sub === "set" && raw === undefined))
      throw new CliError(
        `usage: autocode settings ${sub} ` +
          `<key>${sub === "set" ? " <value>" : ""} ` +
          "[--agent <id> | --match <pattern>]",
        2,
      )
    const v = sub === "set" ? (raw as string) : null
    let body: Record<string, unknown>
    if (agent) body = { agents: { [agent]: { [key]: v } } }
    else if (match) {
      const current = await c.call("GET", "/v1/settings")
      const rules: { match: string; settings: Record<string, unknown> }[] =
        current.rules
      const rule = rules.find((r) => r.match === match)
      if (sub === "set") {
        if (rule) rule.settings[key] = v
        else rules.push({ match, settings: { [key]: v } })
      } else if (rule) {
        delete rule.settings[key]
        if (!Object.keys(rule.settings).length)
          rules.splice(rules.indexOf(rule), 1)
      }
      body = { rules }
    } else body = { server: { [key]: v } }
    const res = await c.call("PATCH", "/v1/settings", body)
    const scope = agent
      ? `for ${agent}`
      : match
        ? `for ${match}`
        : "server-wide"
    print(args, res, () =>
      sub === "set" ? `set ${key} ${scope}` : `cleared ${key} ${scope}`,
    )
    return 0
  }
  if (sub)
    throw new CliError(
      "usage: autocode settings [set <key> <value> | unset <key>] " +
        "[--agent <id> | --match <pattern>]",
      2,
    )

  if (agent) {
    const res = await c.call(
      "GET",
      `/v1/settings?agent=${encodeURIComponent(agent)}`,
    )
    print(args, res, () =>
      table(
        Object.keys(res.values).map((k) => [
          k,
          String(res.values[k]),
          res.sources[k],
        ]),
        ["KEY", "VALUE", "FROM"],
      ),
    )
    return 0
  }
  const res = await c.call("GET", "/v1/settings")
  print(args, res, () => {
    const lines = [
      table(
        Object.keys(res.defaults).map((k) => [
          k,
          String(res.defaults[k]),
          k in res.server ? "server" : "default",
          res.schema[k]?.scope ?? "",
        ]),
        ["KEY", "VALUE", "FROM", "SCOPE"],
      ),
    ]
    lines.push(
      "",
      res.rules.length ? "rules (first match wins):" : "rules: none",
    )
    res.rules.forEach((r: any, i: number) => {
      lines.push(
        `  ${i + 1}. ${r.match}: ${Object.entries(r.settings)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`,
      )
    })
    const ids = Object.keys(res.agents)
    lines.push(
      "",
      ids.length ? "agents' own values:" : "agents' own values: none",
    )
    for (const id of ids)
      lines.push(
        `  ${id}: ${Object.entries(res.agents[id])
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`,
      )
    return lines.join("\n")
  })
  return 0
}

// Tier 0g: money to the cent, tokens with separators, a share to a tenth.
const dollars = (n: unknown) => `$${Number(n).toFixed(2)}`
const tokens = (n: unknown) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US")
const share = (n: unknown) =>
  n === null || n === undefined ? "—" : `${Number(n).toFixed(1)}%`
const cap = (k: any) => (k.daily_usd === "off" ? "off" : dollars(k.daily_usd))
const left = (k: any) => (k.left_usd === null ? "—" : dollars(k.left_usd))

/*
 * Every agent's spend today and in total, its daily cap and what is left of
 * it, its context and its compaction threshold with the share used (tier 0g),
 * unregistered ones with spend too, filtered by --match, with the totals;
 * `costs AGENT`: one agent's, with its spend per day.
 */
export async function costs(args: Parsed): Promise<number> {
  const [agent] = args.words
  const c = connect(args)
  if (agent) {
    const res = await c.call("GET", `/v1/costs/${encodeURIComponent(agent)}`)
    const k = res.cost
    print(args, res, () =>
      [
        `${res.agent} (${res.registered ? "registered" : "not registered"})`,
        `today ${dollars(k.today_usd)}` +
          (k.daily_usd === "off"
            ? " (no daily cap)"
            : ` of ${cap(k)} (${left(k)} left)`) +
          `; in total ${dollars(k.total_usd)}`,
        k.context === null
          ? "context unknown yet"
          : `context ${tokens(k.context)} tokens` +
            (k.context_limit ? ` of ${tokens(k.context_limit)}` : "") +
            (k.compact_at
              ? `; threshold ${tokens(k.compact_at)}: ${share(k.context_share)}`
              : "; no compaction threshold"),
        "",
        res.days.length
          ? table(
              res.days.map((d: any) => [
                d.day,
                dollars(d.usd),
                String(d.steps),
              ]),
              ["DAY", "SPEND", "STEPS"],
            )
          : "no spend kept",
        `days in ${res.timezone}`,
      ].join("\n"),
    )
    return 0
  }
  const match = args.flags.match as string | undefined
  const res = await c.call(
    "GET",
    `/v1/costs${match ? `?match=${encodeURIComponent(match)}` : ""}`,
  )
  const t = res.totals
  print(args, res, () =>
    [
      res.agents.length
        ? table(
            [
              ...res.agents.map((a: any) => [
                a.agent,
                a.status,
                dollars(a.today_usd),
                cap(a),
                left(a),
                dollars(a.total_usd),
                tokens(a.context),
                tokens(a.compact_at),
                share(a.context_share),
              ]),
              // the totals of what is listed
              [
                "TOTAL",
                `(${t.agents})`,
                dollars(t.today_usd),
                "",
                "",
                dollars(t.total_usd),
                "",
                "",
                "",
              ],
            ],
            [
              "AGENT",
              "STATUS",
              "TODAY",
              "CAP",
              "LEFT",
              "TOTAL",
              "CONTEXT",
              "THRESHOLD",
              "SHARE",
            ],
          )
        : match
          ? `no agent matches ${match}`
          : "no agents",
      `days in ${res.timezone}; today ${res.day}`,
    ].join("\n"),
  )
  return 0
}

export async function history(args: Parsed): Promise<number> {
  const q = new URLSearchParams()
  for (const name of ["agent", "kind", "since", "until", "limit"])
    if (args.flags[name]) q.set(name, args.flags[name] as string)
  const res = await connect(args).call(
    "GET",
    `/v1/history${q.size ? `?${q}` : ""}`,
  )
  print(args, res.history, () => {
    if (!res.history.length) return "no history"
    return table(
      res.history.map((h: any) => {
        const where = [h.session, h.host].filter(Boolean).join(" ")
        const data = Object.keys(h.data ?? {}).length
          ? JSON.stringify(h.data)
          : ""
        return [
          local(h.at),
          h.kind,
          h.agent ?? "",
          [where, data].filter(Boolean).join(" "),
        ]
      }),
      ["TIME", "KIND", "AGENT", "DETAIL"],
    )
  })
  return 0
}
