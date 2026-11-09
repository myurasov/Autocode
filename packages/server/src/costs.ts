/*
 * Tier 0e: costs, the daily cap, compaction, cut turns and expiry (spec,
 * Costs and Caps; Context Size; Retries and Resume; Expiry and History).
 * The plugin reports each model step's cost and context (session.step.ended);
 * they add up per agent and day in the server's zone. At cap_warn of
 * daily_usd the agent gets one notice a day; past the cap, once its turn
 * ends, it is paused ("cap") and the owner alerted, until the next day, a
 * higher cap or a resume. A session whose last context passed compact_at
 * (or that asked) is compacted before its next injection. A turn that was
 * running when its OpenCode went away is "cut" and gets a resume prompt.
 * An agent expire_after its last turn is unregistered. Tier 0g: what the
 * owner and the agent see of it (view, list, days): today, the total (kept
 * in cost_totals past trims and unregistering), the cap and what is left,
 * the context and its share of the compaction threshold.
 */
import type { Database } from "bun:sqlite"
import { parseDuration, resolveSettings, wallTime } from "@autocode/shared"
import type { History } from "./history.ts"
import type { Inbox } from "./messages.ts"
import type { SettingsStore } from "./settings-store.ts"

const MAX_STEP_USD = 1000
const MAX_COMPACT = 500_000

export interface CostNotice {
  agent: string
  subject: string
  text: string
}

const usd = (n: number) => `$${n.toFixed(2)}`
// to a millionth of a dollar
const round = (n: number) => Math.round(n * 1e6) / 1e6

// A compaction due: the context, the threshold (0 when the agent asked) and
// whether the agent was told (tier 0g).
export interface CompactDue {
  context: number
  limit: number
  notified: boolean
}

export interface CostView {
  today_usd: number
  total_usd: number
  daily_usd: number | "off"
  left_usd: number | null
  context: number | null
  context_limit: number | null
  compact_at: number | null
  context_share: number | null
}

export class Costs {
  constructor(
    private readonly db: Database,
    private readonly history: History,
    private readonly settings: SettingsStore,
    private readonly inbox: Inbox,
    private readonly now: () => number,
    private readonly notify: (n: CostNotice) => void,
    // the agent's session runs a turn now
    private readonly busy: (agent: string) => boolean,
  ) {}

  private values(agent: string) {
    return resolveSettings(this.settings.layers(), agent).values
  }

  // Today in the server's zone, YYYY-MM-DD.
  day(at = this.now()): string {
    const tz = String(this.settings.value("timezone")) || "UTC"
    const w = wallTime(at, tz)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${w.year}-${pad(w.month)}-${pad(w.day)}`
  }

  // An agent's spend over all days (a run's cost, which may cross midnight),
  // to a millionth of a dollar: kept past trims and an unregistering.
  total(agent: string): number {
    const usd =
      (
        this.db
          .query("SELECT usd FROM cost_totals WHERE agent_id = ?")
          .get(agent) as any
      )?.usd ?? 0
    return round(usd)
  }

  // Every ID that ever spent anything (some may be unregistered now).
  spenders(): string[] {
    return (
      this.db
        .query("SELECT agent_id FROM cost_totals ORDER BY agent_id")
        .all() as any[]
    ).map((r) => r.agent_id)
  }

  // Whether an ID has ever spent anything (it may be unregistered now).
  known(agent: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM cost_totals WHERE agent_id = ?")
      .get(agent)
  }

  // An agent's spend per day, newest first (the days history_days keeps).
  days(agent: string): { day: string; usd: number; steps: number }[] {
    return (
      this.db
        .query(
          "SELECT day, usd, steps FROM costs WHERE agent_id = ? " +
            "ORDER BY day DESC",
        )
        .all(agent) as any[]
    ).map((r) => ({ day: r.day, usd: round(r.usd), steps: r.steps }))
  }

  today(agent: string): number {
    return (
      (
        this.db
          .query("SELECT usd FROM costs WHERE agent_id = ? AND day = ?")
          .get(agent, this.day()) as any
      )?.usd ?? 0
    )
  }

  private cap(agent: string): number | null {
    const v = this.values(agent).daily_usd
    return v === "off" || v === undefined || v === null ? null : Number(v)
  }

  /*
   * What the owner and the agent see (tier 0g): today, the total, the cap and
   * what is left of it today, the last step's context, the model's window,
   * the compaction threshold in tokens and the context's share of it (a
   * percentage to one decimal).
   */
  view(agent: string): CostView {
    const row = this.db
      .query("SELECT context_tokens, context_limit FROM agents WHERE id = ?")
      .get(agent) as any
    const today = round(this.today(agent))
    const cap = this.cap(agent)
    const context: number | null = row?.context_tokens ?? null
    const window: number | null = row?.context_limit ?? null
    const threshold = this.threshold(agent, window)
    return {
      today_usd: today,
      total_usd: this.total(agent),
      daily_usd: (this.values(agent).daily_usd as number | "off") ?? "off",
      left_usd: cap === null ? null : round(Math.max(0, cap - today)),
      context,
      context_limit: window,
      compact_at: threshold,
      context_share:
        context === null || threshold === null || threshold <= 0
          ? null
          : Math.round((context / threshold) * 1000) / 10,
    }
  }

  /*
   * compact_at in tokens for an agent whose model has this window: a number,
   * a share of the window (with its own cap or MAX_COMPACT), or null (off, or
   * a share without a known window).
   */
  threshold(agent: string, window: number | null): number | null {
    const setting = this.values(agent).compact_at
    if (setting === "off" || setting === undefined || setting === null)
      return null
    if (typeof setting === "number") return setting
    const m = /^(\d+)%(?:\s+max\s+(\d+))?$/.exec(String(setting))
    if (!m || !window) return null
    return Math.min(
      Math.floor((window * Number(m[1])) / 100),
      m[2] ? Number(m[2]) : MAX_COMPACT,
    )
  }

  // Step IDs already counted (a batch sent again after a lost reply).
  private readonly counted = new Map<string, number>()

  // A model step of an agent's session (the plugin's cost event).
  step(agent: string, event: any) {
    const amount = Number(event.usd)
    if (
      typeof event.usd !== "number" ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      amount > MAX_STEP_USD
    )
      return
    if (typeof event.step === "string" && event.step) {
      if (this.counted.has(event.step)) return
      this.counted.set(event.step, this.now())
      if (this.counted.size > 5000)
        for (const k of [...this.counted.keys()].slice(0, 1000))
          this.counted.delete(k)
    }
    // a Subagent's step carries no context of the agent's own session
    const context =
      event.context === undefined || event.context === null
        ? Number.NaN
        : Number(event.context)
    const limit = Number(event.limit)
    const day = this.day()
    this.db
      .query(
        `INSERT INTO costs (agent_id, day, usd, steps) VALUES (?, ?, ?, 1)
         ON CONFLICT (agent_id, day) DO UPDATE SET usd = usd + excluded.usd,
           steps = steps + 1`,
      )
      .run(agent, day, amount)
    this.db
      .query(
        `INSERT INTO cost_totals (agent_id, usd, steps, first_day)
         VALUES (?, ?, 1, ?)
         ON CONFLICT (agent_id) DO UPDATE SET usd = usd + excluded.usd,
           steps = steps + 1`,
      )
      .run(agent, amount, day)
    // the compaction's own step reads the old conversation: not the context
    const compacting = !!(
      this.db
        .query("SELECT compacting FROM agents WHERE id = ?")
        .get(agent) as any
    )?.compacting
    if (Number.isInteger(context) && context >= 0 && !compacting)
      this.db
        .query(
          "UPDATE agents SET context_tokens = ?, context_limit = ? " +
            "WHERE id = ?",
        )
        .run(
          context,
          Number.isInteger(limit) && limit > 0 ? limit : null,
          agent,
        )
    // the agent's model: its own session's last step (a Subagent's step,
    // with no context of the agent's, may run another model)
    const model = typeof event.model === "string" ? event.model.trim() : ""
    if (model && model.length <= 200 && Number.isInteger(context))
      this.db
        .query("UPDATE agents SET model = ? WHERE id = ?")
        .run(model, agent)
    this.warn(agent)
  }

  // The notice at cap_warn, once a day.
  private warn(agent: string) {
    const cap = this.cap(agent)
    if (cap === null || cap <= 0) return
    const share = parseFloat(String(this.values(agent).cap_warn)) / 100
    const spent = this.today(agent)
    const day = this.day()
    const row = this.db
      .query("SELECT cap_warned FROM agents WHERE id = ?")
      .get(agent) as any
    if (spent < cap * share || row?.cap_warned === day || spent > cap) return
    this.db
      .query("UPDATE agents SET cap_warned = ? WHERE id = ?")
      .run(day, agent)
    this.history.record("cap.warned", {
      agent,
      data: { spent, cap },
    })
    try {
      this.notify({
        agent,
        subject: "cost warning",
        text:
          `You have spent ${usd(spent)} today of your daily cap of ` +
          `${usd(cap)} (cap_warn ${this.values(agent).cap_warn}). Past the ` +
          "cap you are paused after your turn until tomorrow (in the " +
          "server's zone) or until the owner raises it. Finish what " +
          "matters, and keep your state in files.",
      })
    } catch {}
  }

  /*
   * A turn ended: past the cap, the agent is paused, once a day (the owner's
   * resume holds for the rest of the day: cap_override).
   */
  turnEnded(agent: string) {
    const cap = this.cap(agent)
    if (cap === null) return
    const spent = this.today(agent)
    if (spent <= cap) return
    const row = this.db
      .query("SELECT paused, cap_day, cap_override FROM agents WHERE id = ?")
      .get(agent) as any
    const day = this.day()
    if (!row || row.paused || row.cap_override === day) return
    this.db
      .query("UPDATE agents SET paused = 'cap', cap_day = ? WHERE id = ?")
      .run(day, agent)
    this.history.record("cap.reached", { agent, data: { spent, cap } })
    this.inbox.open("alert", {
      agent,
      title: `${agent} reached its daily cap (${usd(spent)} of ${usd(cap)})`,
      body:
        "It is paused until tomorrow (the server's zone), or until you " +
        "raise daily_usd or resume it.",
    })
  }

  // A cap's pause ends with a new day or a higher cap.
  tick() {
    for (const row of this.db
      .query("SELECT id, cap_day FROM agents WHERE paused = 'cap'")
      .all() as any[]) {
      const cap = this.cap(row.id)
      if (
        row.cap_day !== this.day() ||
        cap === null ||
        this.today(row.id) <= cap
      ) {
        this.db
          .query("UPDATE agents SET paused = '', cap_day = NULL WHERE id = ?")
          .run(row.id)
        this.history.record("cap.lifted", { agent: row.id })
      }
    }
  }

  /*
   * Whether a session should be compacted before its next injection: it
   * asked, or its last step's context passed compact_at.
   */
  compactDue(agent: string): CompactDue | null {
    const row = this.db
      .query(
        "SELECT context_tokens, context_limit, compact_wanted, compacting, " +
          "compact_notified FROM agents WHERE id = ?",
      )
      .get(agent) as any
    if (!row) return null
    // a compaction went out and no injection since
    if (row.compacting) return null
    if (row.compact_wanted)
      return { context: row.context_tokens ?? 0, limit: 0, notified: true }
    const context = row.context_tokens
    const limit = this.threshold(agent, row.context_limit ?? null)
    if (context === null || context === undefined || limit === null) {
      this.forgetNotice(agent, row)
      return null
    }
    if (context <= limit) {
      // below the threshold again (a raised compact_at): the notice is void
      this.forgetNotice(agent, row)
      return null
    }
    return { context, limit, notified: !!row.compact_notified }
  }

  private forgetNotice(agent: string, row: any) {
    if (row.compact_notified)
      this.db
        .query("UPDATE agents SET compact_notified = 0 WHERE id = ?")
        .run(agent)
  }

  /*
   * Tier 0g (the owner, 2026-11-08): the prompt that says a compaction comes
   * next, so the agent brings its work to a stable state first. The
   * compaction goes when the turn it starts ends.
   */
  compactNotice(due: CompactDue): { header: string; text: string } {
    const n = (x: number) => x.toLocaleString("en-US")
    return {
      header: "compaction next",
      text:
        `Your session's context is ${n(due.context)} tokens, past its ` +
        `compaction threshold of ${n(due.limit)} (compact_at). When this ` +
        "turn ends, Autocode compacts this session: a summary replaces the " +
        "conversation so far. Before you end this turn, bring your work to a " +
        "stable state (finish or pause the step you are in; nothing half " +
        "done) and write down in files what you need to go on: the task, " +
        "where you are, decisions, open points and where your notes are. " +
        "What waits for you comes after the compaction.",
    }
  }

  compactNoticed(agent: string, due: CompactDue) {
    this.db
      .query("UPDATE agents SET compact_notified = 1 WHERE id = ?")
      .run(agent)
    this.history.record("session.compact.noticed", {
      agent,
      data: { context: due.context, limit: due.limit },
    })
  }

  /*
   * A compaction went out: the context starts over; until the next injection
   * no other compaction comes, and the compaction's own steps (which read the
   * whole old conversation) do not count as the context.
   */
  compacted(agent: string, due: CompactDue) {
    this.db
      .query(
        "UPDATE agents SET compact_wanted = 0, context_tokens = NULL, " +
          "compacting = 1, compact_notified = 0 WHERE id = ?",
      )
      .run(agent)
    this.history.record("session.compacted", {
      agent,
      data: { context: due.context, limit: due.limit },
    })
  }

  // autocode_me compact: after the current turn.
  wantCompact(agent: string) {
    this.db
      .query("UPDATE agents SET compact_wanted = 1 WHERE id = ?")
      .run(agent)
    this.history.record("session.compact.asked", { agent })
  }

  // An injection went out: compactions may come again.
  injected(agent: string) {
    this.db.query("UPDATE agents SET compacting = 0 WHERE id = ?").run(agent)
  }

  /*
   * A turn ended: a cut found at the hello just before was no cut (the
   * plugin's outbox held its end); the cap's pause.
   */
  uncut(agent: string) {
    const row = this.db
      .query("SELECT cut_at FROM agents WHERE id = ?")
      .get(agent) as any
    if (!row?.cut_at) return
    this.db.query("UPDATE agents SET cut_at = NULL WHERE id = ?").run(agent)
    this.history.record("turn.uncut", { agent })
  }

  // A turn that was running when its OpenCode went away.
  cut(agent: string) {
    this.db
      .query("UPDATE agents SET cut_at = ? WHERE id = ?")
      .run(this.now(), agent)
    this.history.record("turn.cut", { agent })
  }

  // The resume prompt a cut turn is due for, once.
  resumeNote(agent: string) {
    const row = this.db
      .query("SELECT cut_at FROM agents WHERE id = ?")
      .get(agent) as any
    if (!row?.cut_at) return null
    return {
      header: "resume",
      text:
        "Your last turn was cut off (its OpenCode server restarted). " +
        "Continue where you left off.",
    }
  }

  resumed(agent: string) {
    this.db.query("UPDATE agents SET cut_at = NULL WHERE id = ?").run(agent)
    this.history.record("turn.resumed", { agent })
  }

  // Agents whose session's last turn ended expire_after ago.
  expired(): string[] {
    const out: string[] = []
    for (const row of this.db
      .query(
        `SELECT a.id, s.idle_since, a.registered_at FROM agents a
         JOIN sessions s ON s.id = a.session_id
         WHERE s.busy = 0 AND a.paused NOT IN ('owner', 'stop-all')
           AND NOT EXISTS (SELECT 1 FROM asks k WHERE k.agent_id = a.id
                           AND k.state = 'open')`,
      )
      .all() as any[]) {
      const after = parseDuration(String(this.values(row.id).expire_after))
      const last = row.idle_since ?? row.registered_at
      if (after > 0 && this.now() - last > after && !this.busy(row.id))
        out.push(row.id)
    }
    return out
  }

  trim(days: number) {
    this.db
      .query("DELETE FROM costs WHERE day < ?")
      .run(this.day(this.now() - Math.max(days, 31) * 86_400_000))
  }
}
