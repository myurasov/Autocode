/*
 * The settings definitions: each setting's kind, scope, default and help, the
 * checks that normalize a value, and the resolution of an agent's values from
 * the settings layers.
 */

import { formatDuration, parseDuration } from "./durations.ts"
import { AutocodeError } from "./errors.ts"
import { isReservedId, isValidId } from "./ids.ts"
import { matchesPattern, parsePattern } from "./patterns.ts"

// Server-wide defaults, overridable by rules for ID patterns (first match wins)
// and per agent. Keys with scope "server" exist only server-wide.

export type SettingValue = string | number | boolean
type Kind =
  | "mode"
  | "duration"
  | "int"
  | "enum"
  | "text"
  | "usd"
  | "percent"
  | "compact"
  | "bool"
  | "timezone"
  | "listen"

export interface SettingDef {
  kind: Kind
  scope: "agent" | "server"
  default: SettingValue | (() => SettingValue)
  values?: readonly string[]
  min?: number
  help: string
}

export const SETTINGS: Record<string, SettingDef> = {
  min_interval: {
    kind: "duration",
    scope: "agent",
    default: "1m",
    help: "at most one injection per session this often",
  },
  // Tier 0d: who handles an ask; also agent:<id> (another agent) and
  // job:<name> (a run of a job, tier 0f).
  question_mode: {
    kind: "mode",
    scope: "agent",
    default: "ask",
    values: ["ask", "auto"],
    help:
      "questions go to the owner (ask), are answered at once (auto), or go " +
      "to agent:<id> or job:<name>",
  },
  auto_answer_text: {
    kind: "text",
    scope: "agent",
    default:
      "Act according to your best judgement " +
      "and safe practices to achieve my goals.",
    help: "the answer given in auto question mode",
  },
  permission_mode: {
    kind: "mode",
    scope: "agent",
    default: "ask",
    values: ["ask", "approve"],
    help:
      "permission prompts go to the owner (ask), are approved once " +
      "(approve), or go to agent:<id> or job:<name>",
  },
  approval_mode: {
    kind: "mode",
    scope: "agent",
    default: "ask",
    values: ["ask", "approve"],
    help:
      "approvals go to the owner (ask), are approved at once (approve), or " +
      "go to agent:<id> or job:<name>",
  },
  // The owner, 2026-11-09 (rc2): whether an agent may set jobs of its own:
  // ask (an approval of the owner with the whole definition), approve (at
  // once) or off.
  job_mode: {
    kind: "enum",
    scope: "agent",
    default: "ask",
    values: ["ask", "approve", "off"],
    help:
      "jobs an agent sets: an approval of the owner first (ask), set at once " +
      "(approve), or refused (off)",
  },
  compact_at: {
    kind: "compact",
    scope: "agent",
    default: "50% max 500000",
    help:
      "compact between turns past this context size: tokens, a " +
      "percentage of the window (with max N, at most N tokens), or off",
  },
  check_timeout: {
    kind: "duration",
    scope: "agent",
    default: "60s",
    help: "a wake's check is stopped after this long",
  },
  check_output: {
    kind: "int",
    scope: "agent",
    default: 2000,
    min: 0,
    help: "characters of a check's output put into the prompt",
  },
  max_tool_wait: {
    kind: "duration",
    scope: "agent",
    default: "5m",
    help: "the longest a tool waits inside a turn",
  },
  daily_usd: {
    kind: "usd",
    scope: "agent",
    default: "off",
    help: "the agent's cap per day, in dollars, or off",
  },
  cap_warn: {
    kind: "percent",
    scope: "agent",
    default: "90%",
    help: "warn the agent at this share of a cap",
  },
  // Tier 0b3 (the owner, 2026-11-04): a failed turn is retried every
  // retry_interval, at most retry_attempts times (0: no limit).
  retry_interval: {
    kind: "duration",
    scope: "agent",
    default: "1m",
    help: "wait this long after a failed turn before a retry prompt",
  },
  retry_attempts: {
    kind: "int",
    scope: "agent",
    default: 0,
    min: 0,
    help: "the most retries of failed turns in a row (0: no limit)",
  },
  expire_after: {
    kind: "duration",
    scope: "agent",
    default: "14d",
    help: "unregister an agent this long after its session's last turn",
  },
  history_days: {
    kind: "int",
    scope: "server",
    default: 30,
    min: 1,
    help: "days of history kept",
  },
  timezone: {
    kind: "timezone",
    scope: "server",
    default: () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    help: "the server's time zone (days for caps, the default for cron)",
  },
  listen: {
    kind: "listen",
    scope: "server",
    default: "localhost,tailscale:4848",
    help: "addresses and port to listen on (used at start)",
  },
}

export type SettingsValues = Record<string, SettingValue>

export function builtinDefaults(): SettingsValues {
  const out: SettingsValues = {}
  for (const [key, def] of Object.entries(SETTINGS))
    out[key] = typeof def.default === "function" ? def.default() : def.default
  return out
}

function fail(key: string, message: string): never {
  throw new AutocodeError("bad_setting", `${key}: ${message}`)
}

// The definition of a setting, or undefined: never a member of Object.prototype
// ("constructor", "toString").
export function settingDef(key: string): SettingDef | undefined {
  return Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : undefined
}

// An object without a prototype, so that any key (an agent ID such as
// "__proto__") is an ordinary own key.
export function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

export interface ListenAddress {
  host: string
  port: number
}

const HOST_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/

/*
 * "localhost,tailscale:4848" or "127.0.0.1:4848,0.0.0.0:4849": names separated
 * by commas, each with its own port or the port of the next name that has one.
 * Names: localhost, tailscale, IPv4 addresses and host names.
 */
export function parseListen(text: string): ListenAddress[] {
  const entries = text.split(",").map((e) => e.trim())
  const out: ListenAddress[] = []
  let port: number | undefined
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] ?? ""
    const at = entry.lastIndexOf(":")
    const host = at >= 0 ? entry.slice(0, at) : entry
    if (at >= 0) {
      const digits = entry.slice(at + 1)
      if (!/^\d{1,5}$/.test(digits) || Number(digits) > 65535)
        throw new AutocodeError(
          "bad_listen",
          `bad port in ${JSON.stringify(entry)}`,
        )
      port = Number(digits)
    }
    if (port === undefined)
      throw new AutocodeError(
        "bad_listen",
        `${JSON.stringify(text)} needs a port at the end`,
      )
    if (!host.split(".").every((label) => HOST_LABEL.test(label)))
      throw new AutocodeError(
        "bad_listen",
        `${JSON.stringify(host)} is not a host name or IPv4 address`,
      )
    out.unshift({ host, port })
  }
  return out
}

function percent(key: string, text: string): string {
  const m = /^(\d{1,3})%$/.exec(text)
  const n = Number(m?.[1])
  if (!m || n < 1 || n > 100)
    fail(
      key,
      `expected a percentage from 1% to 100% (got ${JSON.stringify(text)})`,
    )
  return `${n}%`
}

export function normalizeSetting(key: string, value: unknown): SettingValue {
  const def = settingDef(key)
  if (!def) fail(key, "no such setting")
  const text = typeof value === "string" ? value.trim() : value
  switch (def.kind) {
    case "duration": {
      try {
        return formatDuration(parseDuration(text as string | number))
      } catch {
        return fail(
          key,
          "expected a duration like 90s, 5m or 1h30m " +
            `(got ${JSON.stringify(value)})`,
        )
      }
    }
    case "int": {
      const n =
        typeof text === "number"
          ? text
          : /^\d+$/.test(String(text))
            ? Number(text)
            : Number.NaN
      if (!Number.isInteger(n) || n < (def.min ?? 0))
        fail(key, `expected a whole number of at least ${def.min ?? 0}`)
      return n
    }
    case "enum":
      if (!def.values?.includes(String(text)))
        fail(key, `expected one of ${def.values?.join(", ")}`)
      return String(text)
    case "mode": {
      const value = String(text)
      if (def.values?.includes(value)) return value
      const m = /^(agent|job):(.+)$/.exec(value)
      if (m && isValidId(m[2]!) && !isReservedId(m[2]!)) return value
      return fail(
        key,
        `expected ${def.values?.join(", ")}, agent:<id> or job:<name>`,
      )
    }
    case "text":
      if (typeof text !== "string" || !text || text.length > 2000)
        fail(key, "expected text of 1 to 2000 characters")
      return text
    case "usd": {
      if (text === "off") return "off"
      const n =
        typeof text === "number"
          ? text
          : /^\$?\d+(\.\d+)?$/.test(String(text))
            ? Number(String(text).replace(/^\$/, ""))
            : Number.NaN
      if (!Number.isFinite(n) || n < 0)
        fail(
          key,
          "expected a dollar amount like 12.50 or $12.50, or off " +
            `(got ${JSON.stringify(value)})`,
        )
      return n
    }
    case "percent":
      return percent(key, String(text))
    case "compact": {
      if (text === "off") return "off"
      if (typeof text === "number" || /^\d+$/.test(String(text))) {
        const n = Number(text)
        // OpenCode's system prompt and tools alone are about 10k tokens
        if (!Number.isInteger(n) || n < 10_000)
          fail(key, "expected at least 10000 tokens")
        return n
      }
      const m = /^(\d{1,3}%)(?:\s+max\s+(\d+))?$/.exec(String(text))
      if (!m)
        fail(
          key,
          "expected tokens, a percentage (50%), a percentage with a cap " +
            "(50% max 500000), or off",
        )
      const p = percent(key, m[1] ?? "")
      return m[2] ? `${p} max ${Number(m[2])}` : p
    }
    case "bool":
      if (text === true || text === "true" || text === "on") return true
      if (text === false || text === "false" || text === "off") return false
      return fail(key, "expected true or false")
    case "timezone":
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: String(text) })
        return String(text)
      } catch {
        return fail(key, `unknown time zone ${JSON.stringify(value)}`)
      }
    case "listen": {
      let addresses: ListenAddress[] = []
      try {
        addresses = parseListen(String(text))
      } catch (err) {
        fail(
          key,
          `${(err as Error).message}; expected names and a port, ` +
            "like localhost,tailscale:4848",
        )
      }
      if (addresses.some((a) => a.port < 1))
        fail(key, "ports go from 1 to 65535")
      return String(text)
    }
  }
}

export interface SettingRule {
  match: string
  settings: Record<string, SettingValue>
}

export interface SettingsLayers {
  server: Record<string, SettingValue>
  rules: SettingRule[]
  agents: Record<string, Record<string, SettingValue>>
}

export interface ResolvedSettings {
  values: SettingsValues
  sources: Record<string, string>
}

export function resolveSettings(
  layers: SettingsLayers,
  id: string,
): ResolvedSettings {
  const values = builtinDefaults()
  const sources: Record<string, string> = {}
  for (const key of Object.keys(values)) sources[key] = "default"
  for (const [key, value] of Object.entries(layers.server)) {
    if (!settingDef(key)) continue
    values[key] = value
    sources[key] = "server"
  }
  const index = layers.rules.findIndex((rule) => matchesPattern(rule.match, id))
  const rule = layers.rules[index]
  if (rule)
    for (const [key, value] of Object.entries(rule.settings)) {
      if (settingDef(key)?.scope !== "agent") continue
      values[key] = value
      sources[key] = `rule ${index + 1} (${rule.match})`
    }
  const own = Object.hasOwn(layers.agents, id) ? layers.agents[id] : undefined
  for (const [key, value] of Object.entries(own ?? {})) {
    if (settingDef(key)?.scope !== "agent") continue
    values[key] = value
    sources[key] = "agent"
  }
  return { values, sources }
}

/*
 * Checks a whole layer set and returns it normalized; refuses server-wide keys
 * outside the server layer. The returned objects have no prototype, so every
 * key is an ordinary own key.
 */
export function normalizeLayers(layers: SettingsLayers): SettingsLayers {
  const server = record<SettingValue>()
  for (const [key, value] of Object.entries(layers.server ?? {}))
    server[key] = normalizeSetting(key, value)
  const rules = (layers.rules ?? []).map((rule) => {
    if (!rule || typeof rule.match !== "string")
      fail("rules", "each rule needs a match pattern")
    parsePattern(rule.match)
    const settings = record<SettingValue>()
    for (const [key, value] of Object.entries(rule.settings ?? {})) {
      if (settingDef(key)?.scope === "server")
        fail(key, "is server-wide and cannot be set for a pattern")
      settings[key] = normalizeSetting(key, value)
    }
    return { match: rule.match, settings }
  })
  const agents = record<Record<string, SettingValue>>()
  for (const [id, values] of Object.entries(layers.agents ?? {})) {
    const out = record<SettingValue>()
    for (const [key, value] of Object.entries(values ?? {})) {
      if (settingDef(key)?.scope === "server")
        fail(key, "is server-wide and cannot be set for an agent")
      out[key] = normalizeSetting(key, value)
    }
    agents[id] = out
  }
  return { server, rules, agents }
}
