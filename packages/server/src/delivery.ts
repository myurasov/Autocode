/*
 * The injection queue and the scheduler (spec, Wakes: Delivery and Debounce;
 * Messages: Delivery): what waits for each agent, merged by wake name or text;
 * checks run by the plugin before a wake is injected; at most one injection
 * per min_interval, only while the session is idle, its host online and the
 * agent not paused; each injection one prompt with the [autocode] header, in
 * which what agents wrote is quoted.
 */

import type { Database } from "bun:sqlite"
import { parseDuration, resolveSettings } from "@autocode/shared"
import type { History } from "./history.ts"
import type { Hosts } from "./hosts.ts"
import type { Loader } from "./loader.ts"
import type { Inbox, Messages } from "./messages.ts"
import type { SettingsStore } from "./settings-store.ts"
import type { WakeItem, Wakes } from "./wakes.ts"

// How long a sent check may go unanswered beyond its own limit.
const CHECK_GRACE_MS = 120_000
// How long an injected prompt may go without starting a turn.
const NO_TURN_MS = 120_000
const DAY = 86_400_000

// OpenCode's prompt IDs start with msg_; ours grow with time, and a repeat of
// one is harmless.
function promptId(now: number): string {
  const time = Math.max(0, Math.floor(now)).toString(16).padStart(12, "0")
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 12)
  return `msg_${time}${random}`
}

const who = (id: string) =>
  id === "owner" ? "the owner" : id === "autocode" ? "Autocode" : `agent ${id}`

// What others wrote goes into a prompt quoted, so no line of it can pass for
// one of Autocode's own.
export const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")

export class Delivery {
  constructor(
    private readonly db: Database,
    private readonly history: History,
    private readonly hosts: Hosts,
    private readonly settings: SettingsStore,
    private readonly wakes: Wakes,
    private readonly messages: () => Messages,
    private readonly inbox: Inbox,
    private readonly now: () => number,
    private readonly loader?: Loader,
  ) {}

  private values(agent: string) {
    return resolveSettings(this.settings.layers(), agent).values
  }

  /*
   * Queues a wake for an agent. One that waits with the same name or the same
   * text takes the new one's text and place in line; a fire's text and its
   * skipped check stay. One whose check runs now keeps running: a fire turns
   * it into a fired item, anything else merges into it.
   */
  enqueueWake = (agent: string, item: WakeItem) => {
    const same = this.db
      .query(
        `SELECT * FROM queue
         WHERE agent_id = ? AND kind = 'wake' AND (wake = ? OR text = ?)
         ORDER BY id`,
      )
      .all(agent, item.wake, item.text) as any[]
    const [first, ...rest] = same
    if (!first) {
      this.db
        .query(
          `INSERT INTO queue (agent_id, kind, wake, text, check_cmd, fired_by,
             extra, created_at) VALUES (?, 'wake', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          agent,
          item.wake,
          item.text,
          item.check ?? null,
          item.fired_by ?? null,
          item.extra ?? null,
          this.now(),
        )
      return
    }
    const firedBy = item.fired_by ?? first.fired_by ?? null
    const extra = item.extra ?? first.extra ?? null
    if (first.check_instruction && !item.fired_by) {
      // its check runs: this run is the same one
    } else
      this.db
        .query(
          `UPDATE queue SET wake = ?, text = ?, check_cmd = ?, fired_by = ?,
             extra = ?, check_instruction = ?, check_sent_at = ?,
             check_output = ? WHERE id = ?`,
        )
        .run(
          item.wake,
          item.text,
          firedBy ? null : (item.check ?? null),
          firedBy,
          extra,
          firedBy ? null : first.check_instruction,
          firedBy ? null : first.check_sent_at,
          firedBy ? null : first.check_output,
          first.id,
        )
    for (const r of rest)
      this.db.query("DELETE FROM queue WHERE id = ?").run(r.id)
    for (const r of same)
      this.history.record("wake.merged", {
        agent,
        data: { name: r.wake, into: item.wake },
      })
  }

  // Messages are never merged: each copy waits for its own announcement.
  enqueueMessage = (agent: string, message: string) => {
    this.db
      .query(
        `INSERT INTO queue (agent_id, kind, message_id, created_at)
         VALUES (?, 'message', ?, ?)`,
      )
      .run(agent, message, this.now())
  }

  tick() {
    this.wakes.tick(this.enqueueWake)
    this.settle()
    this.watchdog()
    const agents = this.db
      .query("SELECT DISTINCT agent_id FROM queue ORDER BY agent_id")
      .all() as { agent_id: string }[]
    for (const { agent_id } of agents)
      try {
        this.deliver(agent_id)
      } catch (err) {
        this.history.record("scheduler.error", {
          agent: agent_id,
          data: { error: (err as Error).message },
        })
      }
  }

  // Puts an injection's wakes and messages back in line.
  private requeue(inj: any) {
    if (!this.db.query("SELECT 1 FROM agents WHERE id = ?").get(inj.agent_id))
      return
    const items = JSON.parse(inj.items ?? "[]") as any[]
    for (const it of items)
      if (it.kind === "wake") this.enqueueWake(inj.agent_id, it)
      else if (it.kind === "message") {
        this.messages().requeue(it.id)
        this.enqueueMessage(inj.agent_id, it.id)
      }
  }

  private close(inj: any, error: string | null) {
    this.db
      .query("UPDATE injections SET settled_at = ?, error = ? WHERE id = ?")
      .run(this.now(), error, inj.id)
    if (!error) return
    this.db
      .query(
        "UPDATE sessions SET busy = 0, inject_pending_at = NULL " +
          "WHERE id = ? AND inject_pending_at IS NOT NULL",
      )
      .run(inj.session_id)
    this.requeue(inj)
    this.history.record("injection.failed", {
      agent: inj.agent_id,
      session: inj.session_id,
      data: { id: inj.id, error },
    })
  }

  /*
   * Injections the plugin answered; a failed one, or one the plugin never
   * fetched within a day (or whose agent moved on), puts its items back.
   */
  private settle() {
    const open = this.db
      .query("SELECT * FROM injections WHERE settled_at IS NULL")
      .all() as any[]
    for (const inj of open) {
      const state = this.hosts.instruction(inj.instruction_id)
      if (state?.acked) {
        this.close(inj, state.ok ? null : (state.error ?? "failed"))
        continue
      }
      const moved = !this.db
        .query("SELECT 1 FROM agents WHERE id = ? AND session_id = ?")
        .get(inj.agent_id, inj.session_id)
      if (!state || moved || this.now() - inj.created_at > DAY) {
        if (state) this.hosts.cancel(inj.instruction_id)
        this.close(inj, state ? (moved ? "moved" : "lost") : "lost")
      }
    }
  }

  // A prompt that started no turn within two minutes frees its session.
  private watchdog() {
    const stuck = this.db
      .query(
        `SELECT s.id, a.id AS agent FROM sessions s
         LEFT JOIN agents a ON a.session_id = s.id
         WHERE s.inject_pending_at IS NOT NULL AND s.inject_pending_at < ?`,
      )
      .all(this.now() - NO_TURN_MS) as any[]
    for (const s of stuck) {
      this.db
        .query(
          "UPDATE sessions SET busy = 0, inject_pending_at = NULL WHERE id = ?",
        )
        .run(s.id)
      this.history.record("injection.no_turn", {
        agent: s.agent ?? null,
        session: s.id,
      })
    }
  }

  /*
   * Takes back what the plugin has not fetched yet for an agent (a pause, or
   * stop-all): injections go back in line, checks are sent again later.
   */
  cancelPending(agent: string) {
    const open = this.db
      .query(
        "SELECT * FROM injections WHERE agent_id = ? AND settled_at IS NULL",
      )
      .all(agent) as any[]
    for (const inj of open)
      if (this.hosts.cancel(inj.instruction_id)) {
        this.db
          .query("UPDATE injections SET settled_at = ?, error = ? WHERE id = ?")
          .run(this.now(), "cancelled", inj.id)
        this.db
          .query(
            "UPDATE sessions SET busy = 0, inject_pending_at = NULL " +
              "WHERE id = ?",
          )
          .run(inj.session_id)
        this.requeue(inj)
      }
    for (const q of this.db
      .query(
        "SELECT id, check_instruction FROM queue " +
          "WHERE agent_id = ? AND check_instruction IS NOT NULL",
      )
      .all(agent) as any[])
      if (this.hosts.cancel(q.check_instruction))
        this.db
          .query(
            "UPDATE queue SET check_instruction = NULL, check_sent_at = NULL " +
              "WHERE id = ?",
          )
          .run(q.id)
  }

  private deliver(agent: string) {
    const row = this.db
      .query(
        `SELECT a.id, a.paused, a.last_injection_at, a.session_id,
                s.busy, s.deleted_at, s.directory, s.host_id, h.online,
                h.machine, h.directory AS host_directory, h.process_kind
         FROM agents a JOIN sessions s ON s.id = a.session_id
         JOIN hosts h ON h.id = s.host_id WHERE a.id = ?`,
      )
      .get(agent) as any
    // an unloaded folder of this machine's background service is loaded again
    if (row && !row.online && !row.deleted_at && !row.paused)
      this.loader?.load({
        id: row.host_id,
        machine: row.machine,
        directory: row.host_directory,
        process_kind: row.process_kind,
      })
    if (!row || row.paused || !row.online || row.deleted_at || row.busy) return
    const values = this.values(agent)
    const now = this.now()
    const minInterval = parseDuration(String(values.min_interval))
    if (row.last_injection_at && now < row.last_injection_at + minInterval)
      return
    const timeout = parseDuration(String(values.check_timeout))
    const running = this.checks(row, values, timeout)
    const items = this.db
      .query("SELECT * FROM queue WHERE agent_id = ? ORDER BY id")
      .all(agent) as any[]
    if (!running) {
      if (items.length) this.inject(row, items, values)
      return
    }
    // checks still run: what does not wait for them goes once a message has
    // waited as long as a check may take
    const ready = items.filter((i) => !i.check_cmd)
    if (
      ready.some((i) => i.kind === "message" && now - i.created_at >= timeout)
    )
      this.inject(row, ready, values)
  }

  /*
   * Runs the checks of the waiting wakes (through the plugin), one per wake,
   * and applies their results; true while any still runs.
   */
  private checks(
    row: any,
    values: Record<string, unknown>,
    timeout: number,
  ): boolean {
    const items = this.db
      .query(
        "SELECT * FROM queue WHERE agent_id = ? AND kind = 'wake' " +
          "AND check_cmd IS NOT NULL ORDER BY id",
      )
      .all(row.id) as any[]
    const limit = Number(values.check_output) || 0
    let running = false
    for (const item of items) {
      if (!item.check_instruction) {
        const id = this.hosts.enqueue(row.host_id, "check", {
          session: row.session_id,
          directory: row.directory,
          command: item.check_cmd,
          timeout_ms: timeout,
          output_limit: limit,
        })
        this.db
          .query(
            "UPDATE queue SET check_instruction = ?, check_sent_at = ? " +
              "WHERE id = ?",
          )
          .run(id, this.now(), item.id)
        running = true
        continue
      }
      const state = this.hosts.instruction(item.check_instruction)
      // the limit counts from when the plugin fetched it (or it was made)
      const since =
        this.hosts.sentAt(item.check_instruction) ??
        item.check_sent_at ??
        this.now()
      const late = this.now() - since > timeout + CHECK_GRACE_MS
      if (state && !state.acked && !late) {
        running = true
        continue
      }
      if (state && !state.acked) this.hosts.cancel(item.check_instruction)
      const result: any = state?.acked && state.ok ? state.result : null
      const exit = result?.exit
      if (exit === 0) {
        const output = String(result.output ?? "").slice(0, limit)
        this.db
          .query(
            "UPDATE queue SET check_cmd = NULL, check_output = ? WHERE id = ?",
          )
          .run(output, item.id)
        this.wakes.checkRan(row.id, item.wake)
        continue
      }
      this.db.query("DELETE FROM queue WHERE id = ?").run(item.id)
      if (exit === 1) {
        this.wakes.checkRan(row.id, item.wake)
        this.history.record("wake.skipped", {
          agent: row.id,
          data: { name: item.wake },
        })
        continue
      }
      const failures = this.wakes.checkFailed(row.id, item.wake)
      const why = !state?.acked
        ? "no answer in time"
        : result?.timed_out
          ? "timed out"
          : !state.ok
            ? `could not run: ${state.error}`
            : `exit ${exit}`
      this.history.record("wake.check_failed", {
        agent: row.id,
        data: { name: item.wake, why, output: String(result?.output ?? "") },
      })
      // one alert per streak: the count goes back to 0 once a check runs
      if (failures === 3)
        this.inbox.open("alert", {
          agent: row.id,
          title:
            `Wake "${item.wake}" of ${row.id}: ` +
            "its check failed 3 times in a row",
          body: `Last: ${why}. ${String(result?.output ?? "").slice(0, 2000)}`,
        })
    }
    return running
  }

  private inject(row: any, items: any[], values: Record<string, unknown>) {
    // Wakes left with the same name or text: only the newest goes in.
    const seen = new Set<string>()
    const wakes = items
      .filter((i) => i.kind === "wake")
      .reverse()
      .filter((i) => {
        const keys = [`n:${i.wake}`, `t:${i.text}`]
        if (keys.some((k) => seen.has(k))) {
          this.history.record("wake.merged", {
            agent: row.id,
            data: { name: i.wake },
          })
          return false
        }
        for (const k of keys) seen.add(k)
        return true
      })
      .reverse()
    const messages = items
      .filter((i) => i.kind === "message")
      .map((i) => this.messages().row(i.message_id))
      .filter(Boolean)
    const reasons: string[] = wakes.map(
      (w) =>
        `wake "${w.wake}"` +
        (w.fired_by
          ? ` fired by ${w.fired_by === "owner" ? "the owner" : w.fired_by}`
          : ""),
    )
    if (messages.length)
      reasons.push(
        `${messages.length} message${messages.length > 1 ? "s" : ""}`,
      )
    const used = items.map((i) => i.id)
    if (!reasons.length) {
      for (const id of used)
        this.db.query("DELETE FROM queue WHERE id = ?").run(id)
      return
    }
    const inline = Number(values.inline_limit) || 0
    const sections: string[] = []
    for (const w of wakes) {
      const lines = [`Wake "${w.wake}":`, w.text]
      if (w.extra) lines.push(`Added by ${who(w.fired_by)}:`, quote(w.extra))
      if (w.check_output) lines.push("Its check said:", quote(w.check_output))
      sections.push(lines.join("\n"))
    }
    const shown: string[] = []
    const listed: string[] = []
    for (const m of messages) {
      const head =
        `Message ${m.id} from ${who(m.from_id)}` +
        (m.subject ? `, subject "${m.subject}"` : "") +
        (m.reply_to ? `, in reply to ${m.reply_to}` : "")
      if (!m.mime && m.size <= inline) {
        sections.push(`${head}:\n${quote(m.body)}`)
        shown.push(m.id)
      } else {
        sections.push(
          `${head}: ${m.mime ? `${m.mime}, ` : ""}${m.size} characters; ` +
            `read it with autocode_message read ${m.id}.`,
        )
        listed.push(m.id)
      }
    }
    const text = `[autocode] ${reasons.join(", ")}\n\n${sections.join("\n\n")}`
    const now = this.now()
    const id = promptId(now)
    const instruction = this.hosts.enqueue(row.host_id, "inject", {
      session: row.session_id,
      prompt_id: id,
      text,
    })
    const summary = {
      header: reasons,
      wakes: wakes.map((w) => w.wake),
      messages: messages.map((m) => m.id),
    }
    const kept = [
      ...wakes.map((w) => ({
        kind: "wake",
        wake: w.wake,
        text: w.text,
        fired_by: w.fired_by,
        extra: w.extra,
        check: null,
      })),
      ...messages.map((m) => ({ kind: "message", id: m.id })),
    ]
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO injections (id, agent_id, session_id, host_id, reasons,
             items, text, instruction_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          row.id,
          row.session_id,
          row.host_id,
          JSON.stringify(summary),
          JSON.stringify(kept),
          text,
          instruction,
          now,
        )
      for (const qid of used)
        this.db.query("DELETE FROM queue WHERE id = ?").run(qid)
      this.db
        .query("UPDATE agents SET last_injection_at = ? WHERE id = ?")
        .run(now, row.id)
      // busy until the plugin reports the turn (or none starts in time)
      this.db
        .query(
          "UPDATE sessions SET busy = 1, inject_pending_at = ? WHERE id = ?",
        )
        .run(now, row.session_id)
    })()
    for (const m of shown) this.messages().markRead(m, "read")
    for (const m of listed) this.messages().markRead(m, "delivered")
    this.history.record("injection.sent", {
      agent: row.id,
      session: row.session_id,
      host: row.host_id,
      data: { id, ...summary },
    })
  }

  // Settled injections (with the text they carried) go with the history.
  trim(days: number) {
    this.db
      .query(
        "DELETE FROM injections " +
          "WHERE settled_at IS NOT NULL AND created_at < ?",
      )
      .run(this.now() - days * DAY)
  }
}
