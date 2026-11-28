/*
 * Costs by kind and by cause (spec, Costs and Caps; 1.1.0-rc7; the owner,
 * 2026-11-27, from a review of real sessions: cache writes were about half
 * of two servers' spend, Subagents a third of one's, and nothing showed
 * either). Each counted model step is filed per agent (the one it counts
 * for), day, cause (what started its turn) and own-or-Subagent: its
 * dollars, divided among cache writes, cache reads, new input and output
 * in the proportion of its tokens times the model's rates; its tokens; and
 * for the first step of a turn its reload, what the turn cost to load the
 * context before anything was done. One more set of rows, without a day,
 * holds the same over all days and outlives history_days, like the total.
 */
import type { Database } from "bun:sqlite"
import { dayBefore } from "./costs.ts"

// A step's tokens, or its dollars, by kind.
export interface Kinds {
  input: number
  output: number
  read: number
  write: number
}

const KINDS = ["input", "output", "read", "write"] as const
const MAX_TOKENS = 1e9
// dollars per million tokens
const MAX_RATE = 1e6

// to a millionth of a dollar
const round = (n: number) => Math.round(n * 1e6) / 1e6

/*
 * A cost event's tokens: whole numbers of a sane size, each kind on its
 * own (one that is no such number counts as none); null for an event
 * without tokens (an older plugin).
 */
export function stepTokens(event: any): Kinds | null {
  const t = event?.tokens
  if (!t || typeof t !== "object" || Array.isArray(t)) return null
  const one = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_TOKENS
      ? Math.round(v)
      : 0
  return {
    input: one(t.input),
    output: one(t.output),
    read: one(t.read),
    write: one(t.write),
  }
}

/*
 * A step's dollars by kind: in the proportion of tokens times rate, so the
 * four add up to what OpenCode recorded for the step, whatever tier or
 * provider's own cost it was priced by: three parts to a billionth of a
 * dollar, and the largest part is what is left of the step's dollars (the
 * review before 1.1.0-rc7: with each part rounded, many small steps' parts
 * came to more than their spend). Null (not split) without tokens, without
 * all four rates, or with nothing to weigh.
 */
export function splitStep(
  usd: number,
  tokens: Kinds | null,
  rates: unknown,
): Kinds | null {
  if (!tokens || !rates || typeof rates !== "object" || Array.isArray(rates))
    return null
  const r = rates as Record<string, unknown>
  const weights = {} as Kinds
  let sum = 0
  for (const kind of KINDS) {
    const rate = r[kind]
    if (
      typeof rate !== "number" ||
      !Number.isFinite(rate) ||
      rate < 0 ||
      rate > MAX_RATE
    )
      return null
    weights[kind] = tokens[kind] * rate
    sum += weights[kind]
  }
  if (!(sum > 0)) return null
  const largest = KINDS.reduce((a, b) => (weights[b] > weights[a] ? b : a))
  const parts = { input: 0, output: 0, read: 0, write: 0 }
  let others = 0
  for (const kind of KINDS) {
    if (kind === largest) continue
    parts[kind] = Math.round(((usd * weights[kind]) / sum) * 1e9) / 1e9
    others += parts[kind]
  }
  parts[largest] = Math.max(0, Math.round((usd - others) * 1e12) / 1e12)
  return parts
}

// What a period's steps were, as the owner and the agent see it.
export interface CostSplit {
  // the dollars these numbers know of (the steps since 1.1.0-rc7)
  usd: number
  cache_write_usd: number
  cache_read_usd: number
  input_usd: number
  output_usd: number
  cache_write_tokens: number
  cache_read_tokens: number
  input_tokens: number
  output_tokens: number
  // of usd, the Subagents' steps
  subagents_usd: number
  // of usd, OpenCode's cache warming between the turns (the cause
  // `warming`; the owner, 2026-11-28: a column of each day's)
  warming_usd: number
  // of usd, the context part of each turn's first step
  reload_usd: number
  turns: number
}

// The same for one cause, with its steps.
export interface CauseSplit {
  cause: string
  turns: number
  steps: number
  usd: number
  subagents_usd: number
  reload_usd: number
  cache_write_usd: number
  cache_read_usd: number
  input_usd: number
  output_usd: number
}

const SUMS = `
  COALESCE(SUM(usd), 0) AS usd,
  COALESCE(SUM(cache_write_usd), 0) AS cache_write_usd,
  COALESCE(SUM(cache_read_usd), 0) AS cache_read_usd,
  COALESCE(SUM(input_usd), 0) AS input_usd,
  COALESCE(SUM(output_usd), 0) AS output_usd,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(CASE WHEN sub = 1 THEN usd ELSE 0 END), 0) AS subagents_usd,
  COALESCE(SUM(CASE WHEN cause = 'warming' THEN usd ELSE 0 END), 0)
    AS warming_usd,
  COALESCE(SUM(reload_usd), 0) AS reload_usd,
  COALESCE(SUM(turns), 0) AS turns,
  COALESCE(SUM(steps), 0) AS steps`

function splitOf(r: any): CostSplit {
  return {
    usd: round(r?.usd ?? 0),
    cache_write_usd: round(r?.cache_write_usd ?? 0),
    cache_read_usd: round(r?.cache_read_usd ?? 0),
    input_usd: round(r?.input_usd ?? 0),
    output_usd: round(r?.output_usd ?? 0),
    cache_write_tokens: r?.cache_write_tokens ?? 0,
    cache_read_tokens: r?.cache_read_tokens ?? 0,
    input_tokens: r?.input_tokens ?? 0,
    output_tokens: r?.output_tokens ?? 0,
    subagents_usd: round(r?.subagents_usd ?? 0),
    warming_usd: round(r?.warming_usd ?? 0),
    reload_usd: round(r?.reload_usd ?? 0),
    turns: r?.turns ?? 0,
  }
}

// The sum of several splits (the totals of a list).
export function addSplits(all: CostSplit[]): CostSplit {
  const out = splitOf(null)
  for (const s of all)
    for (const key of Object.keys(out) as (keyof CostSplit)[])
      out[key] += s[key]
  for (const key of Object.keys(out) as (keyof CostSplit)[])
    if (key.endsWith("_usd") || key === "usd") out[key] = round(out[key])
  return out
}

export class CostParts {
  constructor(
    private readonly db: Database,
    // the server's day (YYYY-MM-DD) of a time, by default now
    private readonly day: (at?: number) => string,
    private readonly now: () => number,
  ) {}

  // The rows of a period: the last `days` days, today included, or the
  // set over all days (kept under an empty day).
  private period(days: number | null): [string, string] {
    return days === null
      ? ["day = ?", ""]
      : ["day >= ?", dayBefore(this.day(), days - 1)]
  }

  private add(
    agent: string,
    day: string,
    cause: string,
    sub: boolean,
    n: {
      steps?: number
      turns?: number
      usd?: number
      split?: Kinds | null
      tokens?: Kinds | null
      reload?: number
    },
  ) {
    this.db
      .query(
        `INSERT INTO cost_parts (agent_id, day, cause, sub, steps, turns,
           usd, input_usd, output_usd, cache_read_usd, cache_write_usd,
           input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, reload_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, day, cause, sub) DO UPDATE SET
           steps = steps + excluded.steps,
           turns = turns + excluded.turns,
           usd = usd + excluded.usd,
           input_usd = input_usd + excluded.input_usd,
           output_usd = output_usd + excluded.output_usd,
           cache_read_usd = cache_read_usd + excluded.cache_read_usd,
           cache_write_usd = cache_write_usd + excluded.cache_write_usd,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens =
             cache_write_tokens + excluded.cache_write_tokens,
           reload_usd = reload_usd + excluded.reload_usd`,
      )
      .run(
        agent,
        day,
        cause,
        sub ? 1 : 0,
        n.steps ?? 0,
        n.turns ?? 0,
        n.usd ?? 0,
        n.split?.input ?? 0,
        n.split?.output ?? 0,
        n.split?.read ?? 0,
        n.split?.write ?? 0,
        n.tokens?.input ?? 0,
        n.tokens?.output ?? 0,
        n.tokens?.read ?? 0,
        n.tokens?.write ?? 0,
        n.reload ?? 0,
      )
  }

  // A turn started in the agent's session (a run's: in its session, for
  // the agent it counts for).
  turn(agent: string, cause: string) {
    for (const day of [this.day(), ""])
      this.add(agent, day, cause, false, { turns: 1 })
  }

  // The session's turn was counted for nobody (no agent yet): none of its
  // steps is a first step.
  noFirstStep(session: string) {
    this.db
      .query("UPDATE sessions SET turn_steps = 1 WHERE id = ?")
      .run(session)
  }

  /*
   * Whether the step that is being counted is the first of its session's
   * turn (its own steps only: a Subagent's are not asked about). The count
   * is 0 only while a turn that was counted waits for its first step: a
   * session the server does not know, one whose turn's start was not seen,
   * and one that registered during its turn have none.
   */
  firstStep(session: string): boolean {
    const row = this.db
      .query(
        "UPDATE sessions SET turn_steps = turn_steps + 1 WHERE id = ? " +
          "RETURNING turn_steps",
      )
      .get(session) as { turn_steps: number } | null
    return row?.turn_steps === 1
  }

  /*
   * A counted step: on its day (today, or the day of a step read from
   * OpenCode's records; none for one older than the days kept) and in the
   * set over all days.
   */
  step(
    agent: string,
    step: {
      cause: string
      sub?: boolean
      usd: number
      tokens?: Kinds | null
      split?: Kinds | null
      reload?: number
      day?: string | null
    },
  ) {
    const day = step.day === undefined ? this.day() : step.day
    for (const d of day === null ? [""] : [day, ""])
      this.add(agent, d, step.cause, !!step.sub, {
        steps: 1,
        usd: step.usd,
        tokens: step.tokens,
        split: step.split,
        reload: step.reload,
      })
  }

  // An agent's split over a period.
  split(agent: string, days: number | null): CostSplit {
    const [where, from] = this.period(days)
    return splitOf(
      this.db
        .query(`SELECT ${SUMS} FROM cost_parts WHERE agent_id = ? AND ${where}`)
        .get(agent, from),
    )
  }

  // Every agent's split over a period, by agent.
  splits(days: number | null): (agent: string) => CostSplit {
    const [where, from] = this.period(days)
    const by = new Map<string, CostSplit>()
    for (const r of this.db
      .query(
        `SELECT agent_id, ${SUMS} FROM cost_parts WHERE ${where}
         GROUP BY agent_id`,
      )
      .all(from) as any[])
      by.set(r.agent_id, splitOf(r))
    return (agent) => by.get(agent) ?? splitOf(null)
  }

  // An agent's spend by what started the turn, largest first.
  causes(agent: string, days: number | null): CauseSplit[] {
    const [where, from] = this.period(days)
    return (
      this.db
        .query(
          `SELECT cause, ${SUMS} FROM cost_parts
           WHERE agent_id = ? AND ${where}
           GROUP BY cause ORDER BY SUM(usd) DESC, cause`,
        )
        .all(agent, from) as any[]
    ).map((r) => ({
      cause: r.cause,
      turns: r.turns,
      steps: r.steps,
      usd: round(r.usd),
      subagents_usd: round(r.subagents_usd),
      reload_usd: round(r.reload_usd),
      cache_write_usd: round(r.cache_write_usd),
      cache_read_usd: round(r.cache_read_usd),
      input_usd: round(r.input_usd),
      output_usd: round(r.output_usd),
    }))
  }

  // An agent's split of each day that is kept, by day.
  days(agent: string): (day: string) => CostSplit {
    const by = new Map<string, CostSplit>()
    for (const r of this.db
      .query(
        `SELECT day, ${SUMS} FROM cost_parts
         WHERE agent_id = ? AND day != '' GROUP BY day`,
      )
      .all(agent) as any[])
      by.set(r.day, splitOf(r))
    return (day) => by.get(day) ?? splitOf(null)
  }

  // The days go with the spend per day: history_days, at least 31 days.
  // The set over all days stays.
  trim(days: number) {
    this.db
      .query("DELETE FROM cost_parts WHERE day != '' AND day < ?")
      .run(this.day(this.now() - Math.max(days, 31) * 86_400_000))
  }
}
