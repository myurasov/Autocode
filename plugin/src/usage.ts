/*
 * What a session spends outside its steps (1.1.2; spec, Costs and Caps).
 * OpenCode's cache warming keeps a session's cache alive with requests that
 * leave no message (session.generate): no step event and no record of the
 * session has their cost. OpenCode does not hand a plugin its announcement
 * of each such request (session.usage.recorded); it hands it the session's
 * totals after every request (session.usage.updated: cost and tokens, all
 * of the session so far).
 *
 * On real OpenCode (tests/plugin/spike-1-inprocess.test.ts) the totals move
 * while a turn runs for the turn's steps, for the session's title and for
 * a compaction (a turn of its own), each before the turn's end is said;
 * and while the session idles for a warming ping. A Subagent's requests
 * move its own session's totals, never its parent's. So a rise of the
 * totals of a session in which no turn runs is a ping, and nothing else is
 * taken from the totals: a step is counted from its own event, a
 * compaction from the session's records, and a title, which cannot be told
 * from a step here, is not counted.
 */

// Tokens by kind, as a cost event says them (reasoning is output).
export interface UsageTokens {
  input: number
  output: number
  read: number
  write: number
}

// Dollars per million tokens of the four kinds.
type Rates = UsageTokens

// A ping: what it added to its session's totals.
export interface Ping {
  // the announcement's ID: one reported twice counts once
  ref: string
  // when OpenCode announced it (ms)
  at?: number
  usd: number
  tokens?: UsageTokens
}

/*
 * How long after a turn's end a rise still counts as the turn's. On real
 * OpenCode a turn's requests have all moved the totals before its end is
 * said; this is for one that would come late, and no ping comes this soon
 * after a turn (warming waits most of the cache's lifetime, minutes).
 */
export const GRACE_MS = 5000

interface Totals {
  cost: number
  tokens?: UsageTokens
}

const count = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0

function totalsOf(event: any): Totals | undefined {
  const data = event?.data
  const cost = data?.cost
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
    return undefined
  const t = data.tokens
  return {
    cost,
    ...(t && typeof t === "object"
      ? {
          tokens: {
            input: count(t.input),
            output: count(t.output) + count(t.reasoning),
            read: count(t.cache?.read),
            write: count(t.cache?.write),
          },
        }
      : {}),
  }
}

// to a billionth of a dollar
const round = (usd: number) => Math.round(usd * 1e9) / 1e9

export class Outside {
  // each session's totals as they were last announced
  private readonly totals = new Map<string, Totals>()
  // the sessions in which a turn runs, and those that are being compacted
  private readonly running = new Set<string>()
  private readonly compacting = new Set<string>()
  // when each session's last turn ended (ms, OpenCode's time)
  private readonly ended = new Map<string, number>()

  // A turn of the session started, or ended (OpenCode's time of it).
  turn(session: string, outcome: string, at: number) {
    if (outcome === "started") {
      this.running.add(session)
      return
    }
    this.running.delete(session)
    this.compacting.delete(session)
    this.ended.set(session, at)
  }

  // A step of the session ended: a turn runs there, seen to start or not.
  step(session: string) {
    this.running.add(session)
  }

  /*
   * A compaction of the session started, or ended. Its request moves the
   * totals with no step's end before it, and its cost is read from the
   * session's records: while it runs nothing is taken from the totals,
   * whatever is known of the turn around it.
   */
  compaction(session: string, on: boolean) {
    if (on) this.compacting.add(session)
    else this.compacting.delete(session)
  }

  // The session is gone.
  forget(session: string) {
    this.totals.delete(session)
    this.running.delete(session)
    this.compacting.delete(session)
    this.ended.delete(session)
  }

  /*
   * A new event stream. Totals announced meanwhile were missed, so the next
   * rise may hold a step: every count starts again from the next totals.
   * And a turn's end may have been missed: no turn is taken to run until
   * one is seen again (a step's end says so before its totals come).
   */
  clear() {
    this.totals.clear()
    this.running.clear()
    this.compacting.clear()
  }

  /*
   * The session's totals were announced: the ping that moved them, or
   * nothing (the first totals seen, totals that did not rise, a turn or a
   * compaction that runs, a turn that has just ended).
   */
  updated(session: string, event: any): Ping | undefined {
    const next = totalsOf(event)
    if (!next) return undefined
    const last = this.totals.get(session)
    this.totals.set(session, next)
    if (!last) return undefined
    const usd = round(next.cost - last.cost)
    if (!(usd > 0)) return undefined
    if (this.running.has(session) || this.compacting.has(session))
      return undefined
    const created = Number(event?.created)
    const at = Number.isFinite(created) && created > 0 ? created : undefined
    const ended = this.ended.get(session)
    if (ended !== undefined && (at ?? Date.now()) - ended < GRACE_MS)
      return undefined
    const kinds = ["input", "output", "read", "write"] as const
    return {
      // OpenCode's ID of the announcement; one without an ID (none was
      // seen) is named by what it says, the same wherever it is read
      ref:
        typeof event.id === "string" && event.id
          ? event.id
          : `usage-${session}-${at ?? 0}-${next.cost}`,
      ...(at === undefined ? {} : { at }),
      usd,
      ...(next.tokens && last.tokens
        ? {
            tokens: Object.fromEntries(
              kinds.map((k) => [
                k,
                Math.max(0, next.tokens![k] - last.tokens![k]),
              ]),
            ) as unknown as UsageTokens,
          }
        : {}),
    }
  }
}

/*
 * The report of a ping for the server: `generate` is OpenCode's name for a
 * request made with a session's context that leaves no message. With the
 * rates of the session's own model, which the request ran on, when the
 * model's prices are known: the server divides the dollars by kind.
 */
export function pingEvent(session: string, ping: Ping, rates?: Rates) {
  return {
    type: "cost.usage",
    session,
    source: "generate",
    ...ping,
    ...(rates ? { rates } : {}),
  }
}
