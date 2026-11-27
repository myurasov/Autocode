/*
 * The CLI commands that call the API: info, agents, hosts, token, settings and
 * history.
 */

import { apiCall, MIN_OPENCODE, shownVersion } from "@autocode/shared"
import { CliError, type Parsed } from "./args.ts"
import {
  clientConfigPath,
  connect,
  readClientConfig,
  writeClientConfig,
} from "./connect.ts"

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
    () =>
      `server ${res.id}, autocode ${shownVersion(res.version)}, ` +
      (res.opencode_min
        ? `for OpenCode ${shownVersion(res.opencode_min)} or later, `
        : "") +
      `at ${url}`,
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
  // in place (1.1.0): its wakes, messages, locks, spend, settings and jobs
  // come along; the old ID forwards
  if (sub === "rename") {
    const [from, to] = rest
    if (!from || !to)
      throw new CliError("usage: autocode agents rename <agent> <new-id>", 2)
    const res = await c.call(
      "POST",
      `/v1/agents/${encodeURIComponent(from)}/rename`,
      { id: to },
    )
    print(args, res, () => `renamed ${from} to ${res.agent.id}`)
    return 0
  }
  if (sub === "register") {
    const id = rest[0]
    const session = args.flags.session
    if (!id || !session)
      throw new CliError(
        "usage: autocode agents register AGENT --session SESSION " +
          "[--description TEXT] [--force]",
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
  const [sub, ...rest] = args.words
  // an offline host's record, at once (1.0.1); the others go by themselves
  if (sub === "rm") {
    const id = rest[0]
    if (!id) throw new CliError("usage: autocode hosts rm <host>", 2)
    const res = await connect(args).call(
      "DELETE",
      `/v1/hosts/${encodeURIComponent(id)}`,
    )
    print(args, res, () => `removed ${id}`)
    return 0
  }
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
        shownVersion(h.opencode_version ?? "") +
          // older than the minimum (the owner, 2026-11-17)
          (h.opencode_supported === false
            ? ` (too old: needs ${shownVersion(
                h.opencode_needs ?? MIN_OPENCODE,
              )} or later)`
            : ""),
        // the plugin's version, beside OpenCode's
        shownVersion(h.plugin_version ?? ""),
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
        "PLUGIN",
        "LAST SEEN",
      ],
    )
  })
  return 0
}

export async function token(args: Parsed): Promise<number> {
  const [sub, id] = args.words
  const kinds = (["admin", "consumer"] as const).filter((name) =>
    args.switches.has(name),
  )
  // one thing at a time: an agent, or one of the owner's two tokens (not
  // both, and no --admin=value: the review before 1.0.0)
  if (
    sub !== "rotate" ||
    kinds.length + (id ? 1 : 0) !== 1 ||
    args.flags.admin !== undefined ||
    args.flags.consumer !== undefined
  )
    throw new CliError(
      "usage: autocode token rotate AGENT | --admin | --consumer",
      2,
    )
  /*
   * The owner's own tokens (a leaked one): the server makes a new one and
   * keeps it in its data folder; it is never printed. This machine's client
   * config, when it holds that token, gets the new one.
   */
  const kind = kinds[0]
  if (kind) {
    const c = connect(args)
    const res = await c.call("POST", `/v1/tokens/${kind}/rotate`)
    const key = `${kind}_token` as const
    const config = readClientConfig()
    /*
     * This machine's client config gets the new token only when it holds
     * that kind of token for this very server (the review before 1.0.0: with
     * --url it took another server's token, and this machine's hosts were
     * refused from then on).
     */
    const same =
      (config.url ?? "").replace(/\/+$/, "") === c.url.replace(/\/+$/, "")
    const lines = [
      `new ${kind} token: saved on the server in ${res.file} ` +
        "(mode 0600); the old one no longer works",
    ]
    let failed: string | undefined
    if (config[key] && typeof res.token === "string") {
      if (!same)
        lines.push(
          `${clientConfigPath()} on this machine is for another server: ` +
            "left as it is",
        )
      else
        try {
          lines.push(
            `updated ${writeClientConfig({ [key]: res.token })} ` +
              "on this machine",
          )
        } catch (err) {
          failed =
            `could not update ${clientConfigPath()}: ` +
            `${(err as Error).message}; it still holds the old ${kind} ` +
            "token: run autocode plugin install again on this machine"
        }
    }
    lines.push(
      kind === "consumer"
        ? "next: on every other machine run autocode plugin install again " +
            "with the new token; a running OpenCode picks the new token up " +
            "from its client config within a minute"
        : "next: sign in to the web UI again; on other machines whose " +
            "client config holds the admin token, run autocode plugin " +
            "install again with --admin-token-file",
    )
    print(args, { kind: res.kind, file: res.file }, () => lines.join("\n"))
    if (failed) throw new CliError(failed, 1)
    return 0
  }
  const res = await connect(args).call(
    "POST",
    `/v1/agents/${encodeURIComponent(id ?? "")}/token/rotate`,
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

// "7 DAYS", "1 DAY".
const daysText = (n: number) => `${n} DAY${n === 1 ? "" : "S"}`
// "day" for one, "7 days" for more: after "last".
const daysWord = (n: number) => (n === 1 ? "day" : `${n} days`)

// Tier 0g: money to the cent, tokens with separators, a share to a tenth.
const dollars = (n: unknown) => `$${Number(n).toFixed(2)}`
const tokens = (n: unknown) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US")
const share = (n: unknown) =>
  n === null || n === undefined ? "—" : `${Number(n).toFixed(1)}%`
const cap = (k: any) => (k.daily_usd === "off" ? "off" : dollars(k.daily_usd))

/*
 * The spend by kind (1.1.0-rc7): a part's share of the dollars the split
 * knows, as a whole percentage; a dash without any.
 */
const part = (usd: unknown, of: unknown) =>
  Number(of) > 0 ? `${Math.round((Number(usd) / Number(of)) * 100)}%` : "—"
const KINDS: [string, string][] = [
  ["cache writes", "cache_write_usd"],
  ["cache reads", "cache_read_usd"],
  ["input", "input_usd"],
  ["output", "output_usd"],
]
// What of a split's dollars no kind has: steps that could not be split.
const unsplit = (s: any) =>
  Math.max(
    0,
    s.usd - s.cache_write_usd - s.cache_read_usd - s.input_usd - s.output_usd,
  )
// The four kinds' shares for the list; dashes where nothing was split.
function kindShares(s: any): string[] {
  const split = s.usd - unsplit(s)
  return KINDS.map(([, key]) => (split >= 0.005 ? part(s[key], s.usd) : "—"))
}
// "cache writes $0.20 (80%), ..., not split $0.10 (5%)": the kinds that the
// split has, and what is not split when that is a cent or more.
function kindsText(s: any): string {
  const rest = unsplit(s)
  const split = s.usd - rest
  return [
    ...(split >= 0.005 || rest < 0.005
      ? KINDS.map(
          ([name, key]) =>
            `${name} ${dollars(s[key])} (${part(s[key], s.usd)})`,
        )
      : []),
    ...(rest >= 0.005
      ? [`not split ${dollars(rest)} (${part(rest, s.usd)})`]
      : []),
  ].join(", ")
}
const left = (k: any) => (k.left_usd === null ? "—" : dollars(k.left_usd))

/*
 * Every agent's spend today and in total, its daily cap and what is left of
 * it, its context and its compaction threshold with the share used (tier 0g),
 * unregistered ones with spend too, filtered by --match, with the totals;
 * --days X: the total over the last X days;
 * `costs AGENT`: one agent's, with its spend per day. By kind (1.1.0-rc7):
 * the list shows each agent's shares of cache writes, cache reads, input
 * and output and its Subagents' dollars; `costs AGENT [--days X]` says the
 * split, the reload, the spend by what started the turn and each day's
 * kinds.
 */
export async function costs(args: Parsed): Promise<number> {
  const [agent, target] = args.words
  const c = connect(args)
  // costs account AGENT: what its session spent before it registered
  if (agent === "account" && target) {
    const res = await c.call(
      "POST",
      `/v1/agents/${encodeURIComponent(target)}/account`,
    )
    print(
      args,
      res,
      () =>
        `asked ${res.agent.id}'s OpenCode for what its session spent before ` +
        "it registered; History says cost.before when it is counted",
    )
    return 0
  }
  if (agent) {
    const period = args.flags.days as string | undefined
    const res = await c.call(
      "GET",
      `/v1/costs/${encodeURIComponent(agent)}` +
        (period ? `?days=${encodeURIComponent(period)}` : ""),
    )
    const k = res.cost
    // by kind and by what started the turn (1.1.0-rc7); an older server
    // says neither
    const s = res.split
    const over = res.period_days
      ? `last ${daysWord(res.period_days)}`
      : "all time"
    print(args, res, () =>
      [
        res.agent.startsWith("job:")
          ? `${res.agent} (a job's runs that no agent started)`
          : `${res.agent} (${res.registered ? "registered" : "not registered"})`,
        `today ${dollars(k.today_usd)}` +
          (k.daily_usd === "off"
            ? " (no daily cap)"
            : ` of ${cap(k)} (${left(k)} left)`) +
          `; in total ${dollars(k.total_usd)}` +
          // of it, its runs' (the owner, 2026-11-09)
          (k.runs_total_usd > 0
            ? ` (${dollars(k.runs_total_usd)} of it its runs')`
            : ""),
        k.context === null
          ? "context unknown yet"
          : `context ${tokens(k.context)} tokens` +
            (k.context_limit ? ` of ${tokens(k.context_limit)}` : "") +
            (k.compact_at
              ? `; threshold ${tokens(k.compact_at)}: ${share(k.context_share)}`
              : "; no compaction threshold"),
        ...(s
          ? [
              s.usd > 0
                ? `by kind, ${over}: ${kindsText(s)}`
                : `by kind, ${over}: nothing counted`,
              `Subagents ${dollars(s.subagents_usd)} ` +
                `(${part(s.subagents_usd, s.usd)}); reload ` +
                `${dollars(s.reload_usd)} (${part(s.reload_usd, s.usd)}) in ` +
                `${s.turns} turn${s.turns === 1 ? "" : "s"}` +
                (s.turns > 0
                  ? `, ${dollars(s.reload_usd / s.turns)} a turn`
                  : ""),
              "",
              res.causes?.length
                ? table(
                    res.causes.map((x: any) => [
                      x.cause,
                      String(x.turns),
                      dollars(x.usd),
                      x.turns > 0 ? dollars(x.usd / x.turns) : "—",
                      dollars(x.reload_usd),
                      dollars(x.subagents_usd),
                    ]),
                    [
                      "STARTED BY",
                      "TURNS",
                      "SPEND",
                      "PER TURN",
                      "RELOAD",
                      "SUBAGENTS",
                    ],
                  )
                : "no turns counted",
            ]
          : []),
        "",
        res.days.length
          ? table(
              res.days.map((d: any) => [
                d.day,
                dollars(d.usd),
                String(d.steps),
                ...(d.split
                  ? [
                      dollars(d.split.cache_write_usd),
                      dollars(d.split.cache_read_usd),
                      dollars(d.split.input_usd),
                      dollars(d.split.output_usd),
                      dollars(d.split.subagents_usd),
                    ]
                  : []),
              ]),
              [
                "DAY",
                "SPEND",
                "STEPS",
                ...(s ? ["WRITE", "READ", "IN", "OUT", "SUBAGENTS"] : []),
              ],
            )
          : "no spend kept",
        `days in ${res.timezone}`,
      ].join("\n"),
    )
    return 0
  }
  const match = args.flags.match as string | undefined
  const days = args.flags.days as string | undefined
  const q = new URLSearchParams()
  if (match) q.set("match", match)
  if (days) q.set("days", days)
  const res = await c.call("GET", `/v1/costs${q.size ? `?${q}` : ""}`)
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
                // by kind (1.1.0-rc7), as shares of what the split knows
                ...(a.split
                  ? [...kindShares(a.split), dollars(a.split.subagents_usd)]
                  : []),
              ]),
              // the totals of what is listed
              [
                res.days ? `TOTAL (${daysText(res.days)})` : "TOTAL",
                `(${t.agents})`,
                dollars(t.today_usd),
                "",
                "",
                dollars(t.total_usd),
                "",
                "",
                "",
                ...(t.split
                  ? [...kindShares(t.split), dollars(t.split.subagents_usd)]
                  : []),
              ],
            ],
            [
              "AGENT",
              "STATUS",
              "TODAY",
              "CAP",
              "LEFT",
              res.days ? daysText(res.days) : "TOTAL",
              "CONTEXT",
              "THRESHOLD",
              "SHARE",
              ...(t.split ? ["WRITE", "READ", "IN", "OUT", "SUBAGENTS"] : []),
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
