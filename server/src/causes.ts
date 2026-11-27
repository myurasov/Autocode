/*
 * What started a turn (spec, Costs and Caps: Costs by kind and by cause;
 * 1.1.0-rc7). One cause per turn: `wake`, `message`, `owner` (typed into
 * the session), `compaction` (the compaction notice's turn, the turn that
 * "compaction done" starts, a compaction's own cost), `job` (a job's
 * result or failure), `ask` (an ask that was answered or closed, or one
 * sent to the agent to answer), `retry` (a retry or resume prompt) and
 * `other` (any other notice of Autocode's, and a turn whose start nobody
 * explained). Two more hold steps that are no turn of the agent's own
 * session: `run` (its jobs' runs) and `earlier` (from before the session
 * registered).
 */

export const CAUSES = [
  "wake",
  "message",
  "owner",
  "compaction",
  "job",
  "ask",
  "retry",
  "run",
  "earlier",
  "other",
] as const

export type Cause = (typeof CAUSES)[number]

export function isCause(value: unknown): value is Cause {
  return (
    typeof value === "string" && (CAUSES as readonly string[]).includes(value)
  )
}

// The causes a prompt of Autocode's can give its turn.
const PROMPTED = new Set<Cause>([
  "wake",
  "message",
  "compaction",
  "job",
  "ask",
  "retry",
  "other",
])

/*
 * The cause of the turn that a prompt of Autocode's starts, from the
 * prompt's summary (injections.reasons). A prompt that carries several
 * things counts by the first of: the compaction notice, a retry or resume,
 * a wake, a message, a job's result, an ask, "compaction done" or
 * "failed", any other notice. A summary that names its cause (written
 * since 1.1.0-rc7) is taken at its word; an older one is read from its
 * wakes, messages and header, where Autocode's own notices stand by their
 * subjects.
 */
export function promptCause(summary: unknown): Cause {
  if (!summary || typeof summary !== "object") return "other"
  const s = summary as Record<string, unknown>
  if (isCause(s.cause) && PROMPTED.has(s.cause)) return s.cause
  const header = Array.isArray(s.header) ? s.header.map(String) : []
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0)
  if (s.compact_notice || header.some((h) => h.startsWith("compaction next")))
    return "compaction"
  if (s.retry !== undefined && s.retry !== null) return "retry"
  if (count(s.wakes)) return "wake"
  if (count(s.messages)) return "message"
  if (header.some((h) => /^(result of run |run \S+ failed)/.test(h)))
    return "job"
  if (header.some((h) => /^(approval|question|permission) /.test(h)))
    return "ask"
  if (header.some((h) => /^compaction (done|failed)/.test(h)))
    return "compaction"
  return "other"
}

/*
 * The cause of a turn that no prompt of Autocode's started, from what the
 * plugin says started it (`by` in turn.started): a typed prompt is the
 * owner's (or another program's), a compaction is one; anything else, and
 * an older plugin that says nothing, is not known.
 */
export function unpromptedCause(by: unknown): Cause {
  return by === "user" ? "owner" : by === "compaction" ? "compaction" : "other"
}
