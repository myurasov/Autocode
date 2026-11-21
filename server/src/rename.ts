/*
 * Renaming an agent in place (spec, Agents and Registration; 1.1.0, the
 * owner, 2026-11-20: two renames done as unregister and register restarted
 * the spend count, lost the agent's own settings and wakes, closed an unread
 * report and left a message to the old ID refused). The agent stays what it
 * is; every column that holds its ID moves in one transaction:
 *   agents.id; wakes.agent_id and set_by; queue.agent_id and fired_by;
 *   injections.agent_id; lock_entries.agent_id; asks.agent_id, answered_by,
 *   routed (agent:<id>) and job_def; inbox.agent_id; messages.to_id of the
 *   ones that still wait; costs, cost_totals and wake_stats (added to what
 *   the new ID had); settings (the agent's own, and agent:<id> values);
 *   jobs.name (<id>:<name>), created_by and dest; runs.job, started_by and
 *   bill_to.
 * History keeps the old ID and gets agent.renamed. The old ID forwards
 * (agent_aliases): a message to it and a fire by it reach the new ID, until
 * somebody registers the old ID again or history_days pass.
 */

import type { Database } from "bun:sqlite"
import { AutocodeError, checkId, isReservedId } from "@autocode/shared"
import type { History } from "./history.ts"

// The live ID that an old one forwards to, if any.
export function aliasOf(db: Database, id: string): string | undefined {
  return (
    db.query("SELECT new_id FROM agent_aliases WHERE old_id = ?").get(id) as {
      new_id: string
    } | null
  )?.new_id
}

// An ID is registered (anew): it is that agent's, and forwards no more.
export function dropAlias(db: Database, id: string) {
  db.query("DELETE FROM agent_aliases WHERE old_id = ?").run(id)
}

// Aliases go with the history.
export function trimAliases(db: Database, before: number) {
  db.query("DELETE FROM agent_aliases WHERE at < ?").run(before)
}

// One ID of a comma list (a job's destination) replaced.
const inList = (list: string, from: string, to: string) =>
  list
    .split(",")
    .map((part) => (part.trim() === from ? to : part))
    .join(",")

// `agent:<from>` values of a settings object, replaced; whether any was.
function reroute(values: any, from: string, to: string): boolean {
  let changed = false
  for (const [key, value] of Object.entries(values ?? {}))
    if (value === `agent:${from}`) {
      values[key] = `agent:${to}`
      changed = true
    }
  return changed
}

export function renameAgent(
  d: { db: Database; history: History; now: () => number },
  from: string,
  toInput: unknown,
  by: "owner" | "self",
): string {
  const { db } = d
  const row = db
    .query("SELECT id, session_id FROM agents WHERE id = ?")
    .get(from) as { id: string; session_id: string } | null
  if (!row) throw new AutocodeError("not_registered", `no agent ${from}`, 404)
  const to = checkId(toInput, "agent ID")
  if (isReservedId(to))
    throw new AutocodeError(
      "reserved_id",
      to.startsWith("job:")
        ? `${to} is reserved: IDs that start with job: name a job's costs`
        : `${to} is reserved`,
    )
  if (to === from)
    throw new AutocodeError("bad_request", `${from} is its ID already`)
  if (db.query("SELECT 1 FROM agents WHERE id = ?").get(to))
    throw new AutocodeError(
      "id_taken",
      `${to} belongs to another agent; unregister that one first`,
      409,
    )
  if (db.query("SELECT 1 FROM runs WHERE id = ?").get(from))
    throw new AutocodeError(
      "bad_request",
      `${from} is a job's run: a run keeps its ID`,
    )
  // the jobs it set are named <id>:<name>: their new names must be free
  const jobs = (
    db
      .query("SELECT name FROM jobs WHERE created_by = ? ORDER BY name")
      .all(from) as { name: string }[]
  ).map((j) => ({
    old: j.name,
    new: j.name.startsWith(`${from}:`)
      ? `${to}:${j.name.slice(from.length + 1)}`
      : j.name,
  }))
  for (const j of jobs)
    if (
      j.new !== j.old &&
      db.query("SELECT 1 FROM jobs WHERE name = ?").get(j.new)
    )
      throw new AutocodeError(
        "job_exists",
        `the job ${j.old} would become ${j.new}, which exists already`,
        409,
      )

  const run = (sql: string, ...args: (string | number)[]) =>
    db.query(sql).run(...args)
  db.transaction(() => {
    // wakes and the queue refer to agents.id: checked when all have moved
    db.exec("PRAGMA defer_foreign_keys = ON")
    run("UPDATE agents SET id = ? WHERE id = ?", to, from)
    for (const [table, column] of [
      ["wakes", "agent_id"],
      ["wakes", "set_by"],
      ["queue", "agent_id"],
      ["queue", "fired_by"],
      ["injections", "agent_id"],
      ["lock_entries", "agent_id"],
      ["asks", "agent_id"],
      ["asks", "answered_by"],
      ["inbox", "agent_id"],
      ["jobs", "created_by"],
      ["runs", "started_by"],
      ["runs", "bill_to"],
    ] as const)
      run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, to, from)
    run(
      "UPDATE asks SET routed = ? WHERE routed = ?",
      `agent:${to}`,
      `agent:${from}`,
    )
    // what still waits for it goes to it; what was read stays as it was
    run(
      "UPDATE messages SET to_id = ? WHERE to_id = ? AND state = 'queued'",
      to,
      from,
    )
    // its spend, added to what the new ID spent before (an ID used before)
    run(
      `INSERT INTO costs (agent_id, day, usd, steps)
         SELECT ?, day, usd, steps FROM costs WHERE agent_id = ?
       ON CONFLICT (agent_id, day) DO UPDATE SET
         usd = usd + excluded.usd, steps = steps + excluded.steps`,
      to,
      from,
    )
    run("DELETE FROM costs WHERE agent_id = ?", from)
    run(
      `INSERT INTO cost_totals (agent_id, usd, steps, first_day)
         SELECT ?, usd, steps, first_day FROM cost_totals WHERE agent_id = ?
       ON CONFLICT (agent_id) DO UPDATE SET
         usd = usd + excluded.usd, steps = steps + excluded.steps,
         first_day = MIN(first_day, excluded.first_day)`,
      to,
      from,
    )
    run("DELETE FROM cost_totals WHERE agent_id = ?", from)
    run(
      `INSERT INTO wake_stats
         (agent_id, name, day, due, skipped, turns, usd, steps)
         SELECT ?, name, day, due, skipped, turns, usd, steps
         FROM wake_stats WHERE agent_id = ?
       ON CONFLICT (agent_id, name, day) DO UPDATE SET
         due = due + excluded.due, skipped = skipped + excluded.skipped,
         turns = turns + excluded.turns, usd = usd + excluded.usd,
         steps = steps + excluded.steps`,
      to,
      from,
    )
    run("DELETE FROM wake_stats WHERE agent_id = ?", from)
    // the jobs it set, their runs' records, and where results go
    for (const j of jobs) {
      if (j.new === j.old) continue
      run("UPDATE jobs SET name = ? WHERE name = ?", j.new, j.old)
      run("UPDATE runs SET job = ? WHERE job = ?", j.new, j.old)
      run(
        "UPDATE runs SET bill_to = ? WHERE bill_to = ?",
        `job:${j.new}`,
        `job:${j.old}`,
      )
    }
    for (const j of db
      .query("SELECT name, dest FROM jobs WHERE dest LIKE ?")
      .all(`%${from}%`) as { name: string; dest: string }[]) {
      const dest = inList(j.dest, from, to)
      if (dest !== j.dest)
        run("UPDATE jobs SET dest = ? WHERE name = ?", dest, j.name)
    }
    // its open proposals of jobs carry the job's name and destination
    for (const k of db
      .query(
        "SELECT id, job_def FROM asks WHERE agent_id = ? " +
          "AND job_def IS NOT NULL",
      )
      .all(to) as { id: string; job_def: string }[])
      try {
        const def = JSON.parse(k.job_def)
        if (typeof def.name === "string" && def.name.startsWith(`${from}:`))
          def.name = `${to}:${def.name.slice(from.length + 1)}`
        if (typeof def.to === "string") def.to = inList(def.to, from, to)
        run(
          "UPDATE asks SET job_def = ? WHERE id = ?",
          JSON.stringify(def),
          k.id,
        )
      } catch {}
    // settings: its own values (one the new ID already has stays), and
    // the values that route asks to it
    for (const s of db
      .query("SELECT scope, key, value FROM settings")
      .all() as { scope: string; key: string; value: string }[]) {
      let value: any
      try {
        value = JSON.parse(s.value)
      } catch {
        continue
      }
      let changed = false
      if (s.scope === "server" && value === `agent:${from}`) {
        value = `agent:${to}`
        changed = true
      } else if (s.scope === "rules" && Array.isArray(value)) {
        for (const rule of value)
          if (reroute(rule?.settings, from, to)) changed = true
      } else if (s.scope === "agent") changed = reroute(value, from, to)
      if (changed)
        run(
          "UPDATE settings SET value = ? WHERE scope = ? AND key = ?",
          JSON.stringify(value),
          s.scope,
          s.key,
        )
    }
    const own = db
      .query("SELECT value FROM settings WHERE scope = 'agent' AND key = ?")
      .get(from) as { value: string } | null
    if (own) {
      const had = db
        .query("SELECT value FROM settings WHERE scope = 'agent' AND key = ?")
        .get(to) as { value: string } | null
      const merged = {
        ...JSON.parse(own.value),
        ...(had ? JSON.parse(had.value) : {}),
      }
      run(
        "DELETE FROM settings WHERE scope = 'agent' AND key IN (?, ?)",
        from,
        to,
      )
      run(
        "INSERT INTO settings (scope, key, value) VALUES ('agent', ?, ?)",
        to,
        JSON.stringify(merged),
      )
    }
    // the old ID forwards to the new one, and so does what forwarded to it;
    // the new ID is an agent's own again
    run("UPDATE agent_aliases SET new_id = ? WHERE new_id = ?", to, from)
    run("DELETE FROM agent_aliases WHERE old_id = ?", to)
    run(
      "INSERT INTO agent_aliases (old_id, new_id, at) VALUES (?, ?, ?) " +
        "ON CONFLICT (old_id) DO UPDATE SET new_id = excluded.new_id, " +
        "at = excluded.at",
      from,
      to,
      d.now(),
    )
  })()
  d.history.record("agent.renamed", {
    agent: to,
    session: row.session_id,
    data: { from, to, by },
  })
  return to
}
