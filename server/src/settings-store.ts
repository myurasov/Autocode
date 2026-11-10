/*
 * Settings on the server: keeps the server-wide values, pattern rules and
 * agents' own values in the database, shows them with their schema, resolves
 * one agent's values, and applies changes.
 */

import type { Database } from "bun:sqlite"
import {
  AutocodeError,
  builtinDefaults,
  checkId,
  normalizeLayers,
  record,
  resolveSettings,
  SETTINGS,
  type SettingsLayers,
  type SettingValue,
  settingDef,
} from "@autocode/shared"

/*
 * Settings rows: scope 'server' (key -> value), scope 'rules' (key '' -> the
 * list of {match, settings}), scope 'agent' (key = agent ID -> that agent's
 * values).
 */
export class SettingsStore {
  constructor(private readonly db: Database) {}

  /*
   * The stored layers. A setting no longer known (one the simplifications
   * removed, like total_usd) is left out, so it never blocks a change.
   */
  layers(): SettingsLayers {
    const out: SettingsLayers = {
      server: record(),
      rules: [],
      agents: record(),
    }
    const known = (values: Record<string, unknown>) => {
      const kept = record<SettingValue>()
      for (const [k, v] of Object.entries(values ?? {}))
        if (settingDef(k)) kept[k] = v as SettingValue
      return kept
    }
    for (const row of this.db
      .query("SELECT scope, key, value FROM settings")
      .all() as any[]) {
      const value = JSON.parse(row.value)
      if (row.scope === "server") {
        if (settingDef(row.key)) out.server[row.key] = value
      } else if (row.scope === "rules")
        out.rules = (Array.isArray(value) ? value : []).map((r: any) => ({
          ...r,
          settings: known(r?.settings),
        }))
      else if (row.scope === "agent") out.agents[row.key] = known(value)
    }
    return out
  }

  value(key: string): SettingValue {
    return this.layers().server[key] ?? builtinDefaults()[key] ?? ""
  }

  view() {
    const layers = this.layers()
    const schema: Record<string, unknown> = {}
    for (const [key, def] of Object.entries(SETTINGS))
      schema[key] = {
        kind: def.kind,
        scope: def.scope,
        default:
          typeof def.default === "function" ? def.default() : def.default,
        ...(def.values ? { values: def.values } : {}),
        help: def.help,
      }
    return {
      defaults: { ...builtinDefaults(), ...layers.server },
      ...layers,
      schema,
    }
  }

  resolved(agent: string) {
    checkId(agent, "agent ID")
    return { agent, ...resolveSettings(this.layers(), agent) }
  }

  // Applies a change atomically; null clears a value (or all of an agent's
  // values). Returns the normalized change.
  patch(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new AutocodeError(
        "bad_request",
        "the body must be an object with server, rules and/or agents",
      )
    const change = body as Record<string, any>
    for (const key of Object.keys(change))
      if (!["server", "rules", "agents"].includes(key))
        throw new AutocodeError("bad_request", `unknown field ${key}`)
    const current = this.layers()
    const next: SettingsLayers = {
      server: Object.assign(record<SettingValue>(), current.server),
      rules: current.rules,
      agents: Object.assign(
        record<Record<string, SettingValue>>(),
        current.agents,
      ),
    }
    if (change.server !== undefined) {
      if (
        typeof change.server !== "object" ||
        Array.isArray(change.server) ||
        change.server === null
      )
        throw new AutocodeError(
          "bad_request",
          "server must be an object of settings",
        )
      for (const [key, value] of Object.entries(change.server)) {
        if (value === null) delete next.server[key]
        else next.server[key] = value as SettingValue
      }
    }
    if (change.rules !== undefined) {
      if (!Array.isArray(change.rules))
        throw new AutocodeError(
          "bad_request",
          "rules must be a list of {match, settings}",
        )
      next.rules = change.rules
    }
    if (change.agents !== undefined) {
      if (
        typeof change.agents !== "object" ||
        Array.isArray(change.agents) ||
        change.agents === null
      )
        throw new AutocodeError(
          "bad_request",
          "agents must be an object of agent IDs",
        )
      for (const [id, values] of Object.entries(change.agents)) {
        checkId(id, "agent ID")
        if (values === null) {
          delete next.agents[id]
          continue
        }
        if (typeof values !== "object" || Array.isArray(values))
          throw new AutocodeError(
            "bad_request",
            `agents.${id} must be an object of settings or null`,
          )
        const merged = Object.assign(
          record<SettingValue>(),
          Object.hasOwn(next.agents, id) ? next.agents[id] : undefined,
        )
        for (const [key, value] of Object.entries(
          values as Record<string, unknown>,
        )) {
          if (value === null) delete merged[key]
          else merged[key] = value as SettingValue
        }
        if (Object.keys(merged).length) next.agents[id] = merged
        else delete next.agents[id]
      }
    }
    const normalized = normalizeLayers(next)
    this.db.transaction(() => {
      this.db.run("DELETE FROM settings")
      const insert = this.db.prepare(
        "INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)",
      )
      for (const [key, value] of Object.entries(normalized.server))
        insert.run("server", key, JSON.stringify(value))
      if (normalized.rules.length)
        insert.run("rules", "", JSON.stringify(normalized.rules))
      for (const [id, values] of Object.entries(normalized.agents))
        insert.run("agent", id, JSON.stringify(values))
    })()
    const recorded: Record<string, unknown> = {}
    if (change.server !== undefined) recorded.server = change.server
    if (change.rules !== undefined) recorded.rules = normalized.rules
    if (change.agents !== undefined) recorded.agents = change.agents
    return recorded
  }
}
