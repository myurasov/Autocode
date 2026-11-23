/*
 * Wake triggers (spec, Wakes): the text an agent or the owner writes, the
 * stored form, and when a trigger runs next.
 *   every <duration> [from <HH:MM>]   steps from when it was set (or that time)
 *   in <duration>                     once, that long after it is set (stored
 *                                     as `at`)
 *   at <time>                         once: an ISO time, a local date and time,
 *                                     or the next HH:MM, in the zone
 *   cron "<5 fields>" [<zone>]        on wall time in the zone
 *   idle <duration> [repeat]          after the session is idle that long
 *   fire-only [once]                  only when fired; with once, the wake
 *                                     is removed when it is fired
 * A periodic trigger (every, cron, idle) may end (1.1.0-rc5):
 *   ... until <time>                  a date alone (through that day), a date
 *                                     and a time, an ISO time, or the next
 *                                     HH:MM; no run at the end or after it
 */

import {
  cronNext,
  isTimeZone,
  parseCron,
  wallTime,
  zonedInstant,
} from "./cron.ts"
import { formatDuration, parseDuration } from "./durations.ts"
import { AutocodeError } from "./errors.ts"

// `until`: the end of a periodic trigger, an ISO time (1.1.0-rc5).
export type Trigger =
  | { kind: "every"; every_ms: number; from?: string; until?: string }
  | { kind: "at"; at: string }
  | { kind: "cron"; cron: string; tz: string; until?: string }
  | { kind: "idle"; idle_ms: number; repeat: boolean; until?: string }
  | { kind: "fire-only"; once?: true }

const HELP =
  "a trigger looks like every 30m [from 09:00], in 45m, at 09:00, " +
  'cron "0 9 * * 1-5" [zone], idle 30m [repeat] or fire-only [once]; ' +
  "every, cron and idle may end: ... [until 2027-03-01]"

/*
 * A trigger that runs again and again by itself: what may carry an end, and
 * what wake_mode is about. An idle wake without repeat is one too: it falls
 * due once in every idle stretch, and each of its own turns starts a new
 * stretch (the review before 1.1.0-rc5).
 */
export function periodic(t: Trigger): boolean {
  return t.kind === "every" || t.kind === "cron" || t.kind === "idle"
}

// The latest end a trigger takes: a later one has a year of five digits,
// which no trigger text holds.
const MAX_END = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

// When a trigger ends, or null: it runs while its time is before that.
export function triggerEnd(t: Trigger): number | null {
  const until = (t as { until?: string }).until
  return until ? Date.parse(until) : null
}

function bad(text: string, why?: string): AutocodeError {
  return new AutocodeError(
    "bad_trigger",
    `${why ? `${why}; ` : ""}${HELP} (got ${JSON.stringify(text)})`,
  )
}

function clock(text: string): { hour: number; minute: number } | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!m) return undefined
  const hour = Number(m[1])
  const minute = Number(m[2])
  return hour < 24 && minute < 60 ? { hour, minute } : undefined
}

// The longest duration a trigger takes: ten years (a longer one would put
// its times past what a date holds).
const MAX_DURATION = 520 * 7 * 86_400_000

function duration(text: string | undefined, whole: string): number {
  if (!text) throw bad(whole)
  let ms: number
  try {
    ms = parseDuration(text)
  } catch {
    throw bad(whole, `bad duration ${text}`)
  }
  if (ms < 1000) throw bad(whole, "the duration must be at least 1s")
  if (ms > MAX_DURATION)
    throw bad(whole, "the duration must be at most 520w (ten years)")
  return ms
}

// An absolute time: with a zone (Z or an offset) as written, without one as
// wall time in `tz`.
function instant(text: string, tz: string, whole: string): number {
  const m = new RegExp(
    "^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})" +
      "(?::(\\d{2})(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?$",
  ).exec(text)
  if (!m) throw bad(whole)
  const [, y, mo, d, h, mi, s, , zone] = m
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    month < 1 ||
    month > 12 ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    Number(s ?? 0) > 59
  )
    throw bad(whole, "no such date or time")
  if (zone) {
    const t = Date.parse(text.replace(" ", "T"))
    if (!Number.isFinite(t)) throw bad(whole)
    return t
  }
  return (
    zonedInstant(year, month, day, hour, minute, tz) + Number(s ?? 0) * 1000
  )
}

// The next HH:MM in the zone, strictly after `now`.
function nextClock(
  c: { hour: number; minute: number },
  tz: string,
  now: number,
): number {
  const w = wallTime(now, tz)
  const t = zonedInstant(w.year, w.month, w.day, c.hour, c.minute, tz)
  if (t > now) return t
  const next = new Date(Date.UTC(w.year, w.month - 1, w.day + 1))
  return zonedInstant(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    c.hour,
    c.minute,
    tz,
  )
}

/*
 * The end of a periodic trigger: a date alone means through that day (the
 * midnight after it), in the zone; else a time as `at` reads one.
 */
function endTime(when: string, tz: string, now: number, whole: string): number {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(when)
  if (date) {
    // the day must exist
    instant(`${when} 00:00`, tz, whole)
    const next = new Date(
      Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]) + 1),
    )
    return zonedInstant(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      0,
      0,
      tz,
    )
  }
  const c = clock(when)
  if (c) return nextClock(c, tz, now)
  try {
    return instant(when, tz, whole)
  } catch (err) {
    // a date that does not exist says so; anything else is unreadable
    if ((err as Error).message.startsWith("no such date or time")) throw err
    throw bad(
      whole,
      "cannot read the end (until): a date (2027-03-01), a date and a " +
        "time, an ISO time or HH:MM",
    )
  }
}

export function parseTrigger(
  input: string,
  opts: { tz: string; now: number },
): Trigger {
  const text = String(input ?? "").trim()
  // the end of a periodic trigger, its last words
  const ended = /^(.*?)\s+until(?:\s+(.*))?$/.exec(text)
  if (!ended) return parseBase(text, text, opts)
  const t = parseBase((ended[1] ?? "").trim(), text, opts)
  if (!periodic(t))
    throw bad(
      text,
      "only a periodic trigger takes an end (until): every, cron or idle",
    )
  const when = (ended[2] ?? "").trim().split(/\s+/).join(" ")
  if (!when) throw bad(text, "until needs a time, like 2027-03-01")
  // a cron trigger's end is wall time in the cron's own zone
  const tz = t.kind === "cron" ? t.tz : opts.tz
  const end = endTime(when, tz, opts.now, text)
  if (end <= opts.now) throw bad(text, "the end (until) has passed already")
  if (!Number.isFinite(end) || end > MAX_END)
    throw bad(
      text,
      "the end (until) is too far ahead: it must come before the year " +
        "10000 (a date alone ends at the midnight after it)",
    )
  return { ...t, until: new Date(end).toISOString() } as Trigger
}

// A trigger without its end; `whole` is the text as written, for errors.
function parseBase(
  text: string,
  whole: string,
  opts: { tz: string; now: number },
): Trigger {
  const [word, ...rest] = text.split(/\s+/)
  switch (word) {
    case "every": {
      const [d, fromWord, from, ...extra] = rest
      const every_ms = duration(d, whole)
      if (fromWord === undefined) return { kind: "every", every_ms }
      if (fromWord !== "from" || !from || extra.length || !clock(from))
        throw bad(whole)
      const c = clock(from)!
      const hh = String(c.hour).padStart(2, "0")
      const mm = String(c.minute).padStart(2, "0")
      return { kind: "every", every_ms, from: `${hh}:${mm}` }
    }
    case "in": {
      const [d, ...extra] = rest
      const ms = duration(d, whole)
      if (extra.length) throw bad(whole)
      return { kind: "at", at: new Date(opts.now + ms).toISOString() }
    }
    case "at": {
      const when = rest.join(" ")
      const c = clock(when)
      if (c) {
        const t = nextClock(c, opts.tz, opts.now)
        return { kind: "at", at: new Date(t).toISOString() }
      }
      return {
        kind: "at",
        at: new Date(instant(when, opts.tz, whole)).toISOString(),
      }
    }
    case "cron": {
      const m = /^cron\s+(["'])(.+?)\1(?:\s+(\S+))?$/.exec(text)
      if (!m) throw bad(whole, "put the cron fields in quotes")
      const cron = (m[2] ?? "").trim().split(/\s+/).join(" ")
      const tz = m[3] ?? opts.tz
      try {
        parseCron(cron)
      } catch (err) {
        throw bad(whole, (err as Error).message)
      }
      if (!isTimeZone(tz)) throw bad(whole, `unknown time zone ${tz}`)
      return { kind: "cron", cron, tz }
    }
    case "idle": {
      const [d, repeat, ...extra] = rest
      const idle_ms = duration(d, whole)
      if (extra.length || (repeat !== undefined && repeat !== "repeat"))
        throw bad(whole)
      return { kind: "idle", idle_ms, repeat: repeat === "repeat" }
    }
    case "fire-only": {
      // once: removed when it is fired (1.1.0)
      const [once, ...extra] = rest
      if (once === undefined) return { kind: "fire-only" }
      if (once !== "once" || extra.length) throw bad(whole)
      return { kind: "fire-only", once: true }
    }
    default:
      throw bad(whole)
  }
}

/*
 * A trigger as text. Its end is written as the ISO time, which parseTrigger
 * reads again; `time` writes it another way for a reader (the server's zone
 * in a prompt).
 */
export function formatTrigger(
  t: Trigger,
  time: (iso: string) => string = (iso) => iso,
): string {
  const end = (until?: string) => (until ? ` until ${time(until)}` : "")
  switch (t.kind) {
    case "every":
      return (
        `every ${formatDuration(t.every_ms)}` +
        (t.from ? ` from ${t.from}` : "") +
        end(t.until)
      )
    case "at":
      return `at ${t.at}`
    case "cron":
      return `cron "${t.cron}" ${t.tz}${end(t.until)}`
    case "idle":
      return (
        `idle ${formatDuration(t.idle_ms)}${t.repeat ? " repeat" : ""}` +
        end(t.until)
      )
    case "fire-only":
      return t.once ? "fire-only once" : "fire-only"
  }
}

/*
 * When a trigger runs next, strictly after `after`; null for idle and
 * fire-only (they have no time of their own) and for a past `at`. `anchor` is
 * when the wake was set: `every` steps from it (or from its `from` time on that
 * day). A trigger with an end has no run at the end or after it.
 */
export function nextRun(
  t: Trigger,
  after: number,
  opts: { tz: string; anchor?: number },
): number | null {
  const next = nextOf(t, after, opts)
  const end = triggerEnd(t)
  return next !== null && end !== null && next >= end ? null : next
}

function nextOf(
  t: Trigger,
  after: number,
  opts: { tz: string; anchor?: number },
): number | null {
  switch (t.kind) {
    case "every": {
      let anchor = opts.anchor ?? after
      if (t.from) {
        const c = clock(t.from)!
        const w = wallTime(anchor, opts.tz)
        anchor = zonedInstant(w.year, w.month, w.day, c.hour, c.minute, opts.tz)
        if (anchor > after) return anchor
      }
      const steps = Math.floor((after - anchor) / t.every_ms) + 1
      return anchor + Math.max(steps, 1) * t.every_ms
    }
    case "at": {
      const at = Date.parse(t.at)
      return at > after ? at : null
    }
    case "cron":
      return cronNext(t.cron, t.tz, after)
    default:
      return null
  }
}
