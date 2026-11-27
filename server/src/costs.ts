/*
 * Tier 0e: costs, the daily cap, compaction, cut turns and expiry (spec,
 * Costs and Caps; Context Size; Retries and Resume; Expiry and History).
 * The plugin reports each model step's cost and context (session.step.ended);
 * they add up per agent and day in the server's zone. At cap_warn of
 * daily_usd the agent gets one notice a day; past the cap, once its turn
 * ends, it is paused ("cap") and the owner alerted, until the next day, a
 * higher cap or a resume. A session whose last context passed compact_at
 * (or that asked) is compacted before its next injection; once that
 * compaction's turn succeeds, "compaction done" tells it to go on (the owner,
 * 2026-11-17: a session stopped after it with work left). A turn that was
 * running when its OpenCode went away is "cut" and gets a resume prompt.
 * An agent expire_after its last turn is unregistered. Tier 0g: what the
 * owner and the agent see of it (view, list, days): today, the total (kept
 * in cost_totals past trims and unregistering), the cap and what is left,
 * the context and its share of the compaction threshold.
 */
import type { Database } from "bun:sqlite"
import {
  compactFor,
  parseDuration,
  resolveSettings,
  wallTime,
} from "@autocode/shared"
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

// The calendar day n days before a day (YYYY-MM-DD), whatever its length.
export function dayBefore(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10)
}

// A compaction due: the context, the threshold (0 when the agent asked) and
// whether the agent was told (tier 0g).
export interface CompactDue {
  context: number
  limit: number
  notified: boolean
}

// How long the resume prompt waits for OpenCode's own resume of a cut turn.
export const RESUME_WAIT_MS = 5000

export interface CostView {
  today_usd: number
  total_usd: number
  // of which its runs' (the owner, 2026-11-09: the tooltip says so)
  runs_today_usd: number
  runs_total_usd: number
  daily_usd: number | "off"
  left_usd: number | null
  context: number | null
  context_limit: number | null
  compact_at: number | null
  context_share: number | null
}

export class Costs {
  // sessions whose earlier steps their plugin is reading now, with what it
  // reported so far
  private readonly accounting = new Map<
    string,
    { steps: number; usd: number; older: number; days: Set<string> }
  >()

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

  /*
   * Whom a run's steps count for (the owner, 2026-11-09, rc2): its bill_to,
   * an agent's ID or job:<name>; null for a session that is not a run.
   */
  billTo(agent: string): string | null {
    return (
      (this.db.query("SELECT bill_to FROM runs WHERE id = ?").get(agent) as any)
        ?.bill_to ?? null
    )
  }

  // A run's own spend over all its days: its cost on the Jobs page, run_usd.
  runCost(run: string): number {
    const usd =
      (
        this.db
          .query("SELECT SUM(usd) AS usd FROM run_costs WHERE run_id = ?")
          .get(run) as any
      )?.usd ?? 0
    return round(usd)
  }

  // Of an agent's spend, its runs' (today, in total).
  private runsSpend(agent: string): { today: number; total: number } {
    const r = this.db
      .query(
        `SELECT
           SUM(CASE WHEN c.day = ? THEN c.usd ELSE 0 END) AS today,
           SUM(c.usd) AS total
         FROM run_costs c JOIN runs r ON r.id = c.run_id
         WHERE r.bill_to = ?`,
      )
      .get(this.day(), agent) as any
    return { today: round(r?.today ?? 0), total: round(r?.total ?? 0) }
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

  // An agent's spend over its last `days` days, today included (calendar
  // days: a 25-hour day counts once).
  totalOver(agent: string, days: number): number {
    const from = dayBefore(this.day(), days - 1)
    const usd =
      (
        this.db
          .query(
            "SELECT SUM(usd) AS usd FROM costs WHERE agent_id = ? AND day >= ?",
          )
          .get(agent, from) as any
      )?.usd ?? 0
    return round(usd)
  }

  /*
   * An agent's last 7 days (the owner, 2026-11-09: the Costs tab's Last 7
   * Days), oldest first, today last, days without spend 0; up to 7: none
   * before its first day, none at all if it never spent.
   */
  week(agent: string): { day: string; usd: number }[] {
    const first = (
      this.db
        .query("SELECT first_day FROM cost_totals WHERE agent_id = ?")
        .get(agent) as any
    )?.first_day as string | undefined
    if (!first) return []
    const today = this.day()
    const spent = new Map(
      (
        this.db
          .query(
            "SELECT day, usd FROM costs WHERE agent_id = ? AND day >= ? " +
              "AND day <= ?",
          )
          .all(agent, dayBefore(today, 6), today) as any[]
      ).map((r) => [r.day as string, round(r.usd)] as const),
    )
    const week: { day: string; usd: number }[] = []
    for (let n = 6; n >= 0; n--) {
      const day = dayBefore(today, n)
      if (day >= first) week.push({ day, usd: spent.get(day) ?? 0 })
    }
    return week
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
    const runs = this.runsSpend(agent)
    return {
      today_usd: today,
      total_usd: this.total(agent),
      runs_today_usd: runs.today,
      runs_total_usd: runs.total,
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
   * a share of the window (at most its "max N" when it has one: the default
   * is "50% max 500000"), or null (off); of a value with thresholds for
   * models, the one that holds for the agent's model. A share alone is that share, not
   * capped (the owner, 2026-11-08: "90%" of a 1,000,000 window is 900,000).
   * Without a known window a share is its max, or MAX_COMPACT (the final
   * review: a long session must not go without compaction for want of it).
   */
  threshold(agent: string, window: number | null): number | null {
    const all = this.values(agent).compact_at
    if (all === undefined || all === null) return null
    /*
     * With thresholds for models (1.1.0-rc7), the one of the agent's model
     * now: the model of its own session's last step, or turn start.
     */
    const setting =
      typeof all === "string" && all.includes(",")
        ? compactFor(
            all,
            (
              this.db
                .query("SELECT model FROM agents WHERE id = ?")
                .get(agent) as { model: string | null } | null
            )?.model,
          )
        : all
    if (setting === "off") return null
    if (typeof setting === "number") return setting
    const m = /^(\d+)%(?:\s+max\s+(\d+))?$/.exec(String(setting))
    if (!m) return null
    const cap = m[2] ? Number(m[2]) : null
    if (!window) return cap ?? MAX_COMPACT
    const share = Math.floor((window * Number(m[1])) / 100)
    return cap === null ? share : Math.min(share, cap)
  }

  // A model step of an agent's session (the plugin's cost event): the
  // dollars it counted, or null for a step that did not count.
  step(agent: string, event: any): number | null {
    const amount = Number(event.usd)
    if (
      typeof event.usd !== "number" ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      amount > MAX_STEP_USD
    )
      return null
    // a step already counted (its batch sent again after a lost reply, or a
    // restart) counts once; the IDs are kept with the history
    if (typeof event.step === "string" && event.step) {
      const fresh = this.db
        .query("INSERT OR IGNORE INTO cost_steps (step, at) VALUES (?, ?)")
        .run(event.step.slice(0, 200), this.now()).changes
      if (!fresh) return null
    }
    // a Subagent's step carries no context of the agent's own session
    const context =
      event.context === undefined || event.context === null
        ? Number.NaN
        : Number(event.context)
    const limit = Number(event.limit)
    const day = this.day()
    // a run's step: its own spend, and it counts for its bill_to (the owner,
    // 2026-11-09: once, in one row)
    const billTo = this.billTo(agent)
    if (billTo)
      this.db
        .query(
          `INSERT INTO run_costs (run_id, day, usd, steps) VALUES (?, ?, ?, 1)
           ON CONFLICT (run_id, day) DO UPDATE SET usd = usd + excluded.usd,
             steps = steps + 1`,
        )
        .run(agent, day, amount)
    const payer = billTo ?? agent
    this.db
      .query(
        `INSERT INTO costs (agent_id, day, usd, steps) VALUES (?, ?, ?, 1)
         ON CONFLICT (agent_id, day) DO UPDATE SET usd = usd + excluded.usd,
           steps = steps + 1`,
      )
      .run(payer, day, amount)
    this.db
      .query(
        `INSERT INTO cost_totals (agent_id, usd, steps, first_day)
         VALUES (?, ?, 1, ?)
         ON CONFLICT (agent_id) DO UPDATE SET usd = usd + excluded.usd,
           steps = steps + 1`,
      )
      .run(payer, amount, day)
    // the compaction's own step reads the old conversation: not the context
    const compacting = !!(
      this.db
        .query("SELECT compacting FROM agents WHERE id = ?")
        .get(agent) as any
    )?.compacting
    // a step without the model's window keeps the last known one (the final
    // review: one such step had turned compaction off)
    if (Number.isInteger(context) && context >= 0 && !compacting)
      this.db
        .query(
          "UPDATE agents SET context_tokens = ?, " +
            "context_limit = COALESCE(?, context_limit) WHERE id = ?",
        )
        .run(
          context,
          Number.isInteger(limit) && limit > 0 ? limit : null,
          agent,
        )
    // the agent's model: its own session's last step (a Subagent's step,
    // with no context of the agent's, may run another model)
    const model = typeof event.model === "string" ? event.model.trim() : ""
    // each model's name by its ID, from any step (a Subagent's too), for
    // the jobs' models (the owner, 2026-11-17): "" forgets it
    if (
      model &&
      model.length <= 200 &&
      typeof event.model_name === "string" &&
      event.model_name.trim().length <= 100
    ) {
      const name = event.model_name.trim()
      if (name)
        this.db
          .query(
            "INSERT INTO model_names (model, name) VALUES (?, ?) " +
              "ON CONFLICT(model) DO UPDATE SET name = excluded.name",
          )
          .run(model, name)
      else this.db.query("DELETE FROM model_names WHERE model = ?").run(model)
    }
    if (model && model.length <= 200 && Number.isInteger(context)) {
      // another model: the last one's name is not its name
      this.db
        .query(
          "UPDATE agents SET model_name = CASE WHEN model IS ? " +
            "THEN model_name ELSE NULL END, model = ? WHERE id = ?",
        )
        .run(model, model, agent)
      // its name as OpenCode's model list has it (the owner, 2026-11-17:
      // "Fable 5.2" for claude-agent/fable): "" says the list has none; a
      // step that does not say it keeps the name
      if (typeof event.model_name === "string") {
        const name = event.model_name.trim()
        if (name.length <= 100)
          this.db
            .query("UPDATE agents SET model_name = ? WHERE id = ?")
            .run(name || null, agent)
      }
    }
    // and its effort, the model's variant (the owner, 2026-11-17): "" says
    // the model runs with none; a step that does not say it keeps the last
    if (typeof event.effort === "string" && Number.isInteger(context)) {
      const effort = event.effort.trim()
      if (effort.length <= 100)
        this.db
          .query("UPDATE agents SET effort = ? WHERE id = ?")
          .run(effort || null, agent)
    }
    this.warn(payer)
    return amount
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
   * resume holds for the rest of the day: cap_override). A run's turn: the
   * agent it counts for is paused once no turn of its own runs (the owner,
   * 2026-11-09: its runs' spend counts toward its cap).
   */
  turnEnded(agent: string, outcome = "succeeded") {
    const row = this.db
      .query("SELECT compacting, compact_instruction FROM agents WHERE id = ?")
      .get(agent) as any
    /*
     * The turn that ended is the compaction's only when OpenCode took the
     * compaction (its instruction was done); one it could not do, or has not
     * answered yet, leaves this turn someone else's (the review before
     * 1.0.0: "compaction done" came after the owner's own turn).
     */
    const took = row?.compact_instruction
      ? this.instruction(row.compact_instruction)
      : undefined
    const compacting =
      !!row?.compacting && (!row.compact_instruction || !!took?.ok)
    // the compaction's turn is over: steps count as the context again
    if (compacting || !row?.compact_instruction) this.injected(agent)
    if (compacting && outcome === "succeeded") this.compactDone(agent)
    const billTo = this.billTo(agent)
    if (billTo) {
      if (!billTo.startsWith("job:") && !this.busy(billTo))
        this.capCheck(billTo)
      return
    }
    this.capCheck(agent)
  }

  private capCheck(agent: string) {
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
        'After the compaction, "compaction done" tells you to go on, and ' +
        "what waits for you comes with it.",
    }
  }

  compactNoticed(agent: string, due: CompactDue, steer = false) {
    this.db
      .query("UPDATE agents SET compact_notified = 1 WHERE id = ?")
      .run(agent)
    this.history.record("session.compact.noticed", {
      agent,
      data: {
        context: due.context,
        limit: due.limit,
        // into a running turn (the owner, 2026-11-09)
        ...(steer ? { steer: true } : {}),
      },
    })
  }

  /*
   * A compaction went out: the context starts over; until the next injection
   * no other compaction comes, and the compaction's own steps (which read the
   * whole old conversation) do not count as the context.
   */
  compacted(agent: string, due: CompactDue, instruction: string) {
    this.db
      .query(
        "UPDATE agents SET compact_wanted = 0, context_tokens = NULL, " +
          "compacting = 1, compact_notified = 0, compact_instruction = ?, " +
          "compact_asked = ? WHERE id = ?",
      )
      // one the agent asked for has no threshold (compactDue)
      .run(instruction, due.limit === 0 ? 1 : 0, agent)
    this.history.record("session.compacted", {
      agent,
      data: { context: due.context, limit: due.limit },
    })
  }

  /*
   * The owner, 2026-11-17: "after compaction, we will be sending 'compaction
   * done, complete planned steps if any' so sessions dont stop if there are
   * things to do": a notice of Autocode's, so it goes first, with what waits.
   */
  private compactDone(agent: string) {
    this.history.record("session.compact.done", { agent })
    try {
      this.notify({
        agent,
        subject: "compaction done",
        text:
          "Autocode compacted this session: a summary now stands for the " +
          "conversation before it. If work was planned or in progress, carry " +
          "on with the steps that are left, without waiting to be asked: " +
          "first read the notes you wrote down (the task, where you are, what " +
          "comes next). If nothing is left to do, end your turn.",
      })
    } catch {}
  }

  /*
   * The compaction that is out could not be done (OpenCode said so, or its
   * instruction was lost): nothing was compacted. One that came by the
   * threshold comes again after the next turn that passes it; an agent that
   * asked for one is told, so that it can ask again.
   */
  compactFailed(agent: string, error: string) {
    const row = this.db
      .query("SELECT compact_asked FROM agents WHERE id = ?")
      .get(agent) as any
    this.injected(agent)
    this.history.record("session.compact.failed", { agent, data: { error } })
    if (!row?.compact_asked) return
    try {
      this.notify({
        agent,
        subject: "compaction failed",
        text:
          `Autocode could not compact this session (${error}). Nothing ` +
          "changed. Ask again with autocode_me action=compact if you " +
          "still want it.",
      })
    } catch {}
  }

  // The agents whose compaction is out, with its instruction.
  compactsOut(): { id: string; instruction: string }[] {
    return this.db
      .query(
        "SELECT id, compact_instruction AS instruction FROM agents " +
          "WHERE compact_instruction IS NOT NULL",
      )
      .all() as { id: string; instruction: string }[]
  }

  // autocode_me compact: after the current turn.
  wantCompact(agent: string) {
    this.db
      .query("UPDATE agents SET compact_wanted = 1 WHERE id = ?")
      .run(agent)
    this.history.record("session.compact.asked", { agent })
  }

  /*
   * An injection went out, or a turn ended (the compaction's own, the first
   * after it): the context counts again and compactions may come again.
   */
  injected(agent: string) {
    this.db
      .query(
        "UPDATE agents SET compacting = 0, compact_instruction = NULL, " +
          "compact_asked = 0 WHERE id = ?",
      )
      .run(agent)
  }

  // How the host answered an instruction (set by the server: hosts).
  instruction: (
    id: string,
  ) => { acked: boolean; ok: boolean; error: string | null } | undefined = () =>
    undefined

  /*
   * A turn ended: a cut found at the hello just before was no cut (the
   * plugin's outbox held its end); the cap's pause. A turn started before
   * the resume prompt went: the cut turn goes on already (OpenCode resumed
   * it itself).
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

  /*
   * A cut found less than RESUME_WAIT_MS ago: OpenCode may be resuming the
   * turn itself (2.3.0 does after its server was killed under it); a turn
   * that starts in the session takes the cut back (uncut), and nothing goes
   * to the agent meanwhile.
   */
  cutFresh(agent: string): boolean {
    const row = this.db
      .query("SELECT cut_at FROM agents WHERE id = ?")
      .get(agent) as any
    return !!row?.cut_at && this.now() - row.cut_at < RESUME_WAIT_MS
  }

  /*
   * Whether a session's earlier steps were filed, or are being read now
   * (spec, Costs and Caps: Before a session registered). A session is
   * accounted for once.
   */
  accounted(session: string): boolean {
    if (this.accounting.has(session)) return true
    const row = this.db
      .query("SELECT accounted_at FROM sessions WHERE id = ?")
      .get(session) as { accounted_at: number | null } | null
    return !!row?.accounted_at
  }

  // The session's plugin was asked: what it reports is added up for History.
  accountingStarted(session: string) {
    this.accounting.set(session, {
      steps: 0,
      usd: 0,
      older: 0,
      days: new Set(),
    })
  }

  /*
   * The plugin answered: its report is whole (the session is accounted for,
   * and History says how much was filed), or it could not read its OpenCode
   * (History says why; the next registration asks again).
   */
  accountingEnded(
    session: string,
    agent: string | undefined,
    ok: boolean,
    error: string | null,
  ) {
    const tally = this.accounting.get(session)
    this.accounting.delete(session)
    if (!ok) {
      this.history.record("cost.before", {
        agent,
        session,
        data: { error: error ?? "failed" },
      })
      return
    }
    this.db
      .query("UPDATE sessions SET accounted_at = ? WHERE id = ?")
      .run(this.now(), session)
    if (tally?.steps)
      this.history.record("cost.before", {
        agent,
        session,
        data: {
          steps: tally.steps,
          usd: round(tally.usd),
          days: tally.days.size,
          older_usd: round(tally.older),
        },
      })
  }

  /*
   * Steps read from OpenCode's records, [ID, time, dollars] each: a
   * session's earlier ones, and a compaction's. Each is filed for the agent
   * on its own day in the server's zone, once (by its ID, which a live step
   * carries too); one older than the days kept goes to the total only; one
   * after now counts for today. Today's count toward the cap: its warning,
   * and its pause at once when no turn runs (else when the turn ends). The
   * agent's context and model stay as its live steps left them, and no wake
   * gets these steps.
   */
  past(
    agent: string,
    session: string,
    steps: unknown,
    // the report of an accounting (History adds these up), not a
    // compaction's cost
    accounting = false,
    // each step that counted: its dollars and its day (null for one older
    // than the days kept, which goes to the total only), for the payer
    filed?: (payer: string, usd: number, day: string | null) => void,
  ): number {
    if (!Array.isArray(steps)) return 0
    const now = this.now()
    const today = this.day(now)
    const kept = this.day(now - this.keptDays() * 86_400_000)
    const billTo = this.billTo(agent)
    const payer = billTo ?? agent
    const tally = accounting ? this.accounting.get(session) : undefined
    let counted = 0
    for (const step of steps) {
      if (!Array.isArray(step)) continue
      const [id, at, usd] = step
      if (typeof id !== "string" || !id) continue
      if (typeof at !== "number" || !Number.isFinite(at) || at < 0) continue
      if (
        typeof usd !== "number" ||
        !Number.isFinite(usd) ||
        usd < 0 ||
        usd > MAX_STEP_USD
      )
        continue
      const fresh = this.db
        .query("INSERT OR IGNORE INTO cost_steps (step, at) VALUES (?, ?)")
        .run(id.slice(0, 200), now).changes
      if (!fresh) continue
      const day = at > now ? today : this.day(at)
      if (day >= kept) {
        if (billTo)
          this.db
            .query(
              `INSERT INTO run_costs (run_id, day, usd, steps)
               VALUES (?, ?, ?, 1)
               ON CONFLICT (run_id, day) DO UPDATE SET
                 usd = usd + excluded.usd, steps = steps + 1`,
            )
            .run(agent, day, usd)
        this.db
          .query(
            `INSERT INTO costs (agent_id, day, usd, steps) VALUES (?, ?, ?, 1)
             ON CONFLICT (agent_id, day) DO UPDATE SET
               usd = usd + excluded.usd, steps = steps + 1`,
          )
          .run(payer, day, usd)
        tally?.days.add(day)
      } else if (tally) tally.older += usd
      this.db
        .query(
          `INSERT INTO cost_totals (agent_id, usd, steps, first_day)
           VALUES (?, ?, 1, ?)
           ON CONFLICT (agent_id) DO UPDATE SET usd = usd + excluded.usd,
             steps = steps + 1, first_day = MIN(first_day, excluded.first_day)`,
        )
        .run(payer, usd, day)
      if (tally) {
        tally.steps += 1
        tally.usd += usd
      }
      try {
        filed?.(payer, usd, day >= kept ? day : null)
      } catch {}
      counted += 1
    }
    if (counted && !payer.startsWith("job:")) {
      this.warn(payer)
      if (!this.busy(payer)) this.capCheck(payer)
    }
    return counted
  }

  // The days whose spend is kept: history_days, at least 31.
  private keptDays(): number {
    return Math.max(Number(this.settings.value("history_days")) || 30, 31)
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
                           AND k.state = 'open' AND k.job_def IS NULL
                           AND k.wake_def IS NULL)`,
      )
      .all() as any[]) {
      const after = parseDuration(String(this.values(row.id).expire_after))
      // its session's last turn, or its registration when that is later:
      // an ID given to a session that was idle for long is new all the same
      // (the third review before 1.1.0-rc4)
      const last = Math.max(row.idle_since ?? 0, row.registered_at)
      if (after > 0 && this.now() - last > after && !this.busy(row.id))
        out.push(row.id)
    }
    return out
  }

  trim(days: number) {
    this.db
      .query("DELETE FROM costs WHERE day < ?")
      .run(this.day(this.now() - Math.max(days, 31) * 86_400_000))
    this.db
      .query("DELETE FROM cost_steps WHERE at < ?")
      .run(this.now() - Math.max(days, 31) * 86_400_000)
  }
}
