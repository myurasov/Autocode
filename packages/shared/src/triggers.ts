/*
 * Wake triggers (spec, Wakes): the text an agent or the owner writes, the
 * stored form, and when a trigger runs next.
 *   every <duration> [from <HH:MM>]   steps from when it was set (or that time)
 *   at <time>                         once: an ISO time, a local date and time,
 *                                     or the next HH:MM, in the zone
 *   cron "<5 fields>" [<zone>]        on wall time in the zone
 *   idle <duration> [repeat]          after the session is idle that long
 *   fire-only                         only when fired
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

export type Trigger =
  | { kind: "every"; every_ms: number; from?: string }
  | { kind: "at"; at: string }
  | { kind: "cron"; cron: string; tz: string }
  | { kind: "idle"; idle_ms: number; repeat: boolean }
  | { kind: "fire-only" }

const HELP =
  'a trigger looks like every 30m [from 09:00], at 09:00, cron "0 9 * * 1-5" ' +
  "[zone], idle 30m [repeat] or fire-only"

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

function duration(text: string | undefined, whole: string): number {
  if (!text) throw bad(whole)
  let ms: number
  try {
    ms = parseDuration(text)
  } catch {
    throw bad(whole, `bad duration ${text}`)
  }
  if (ms < 1000) throw bad(whole, "the duration must be at least 1s")
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

export function parseTrigger(
  input: string,
  opts: { tz: string; now: number },
): Trigger {
  const text = String(input ?? "").trim()
  const [word, ...rest] = text.split(/\s+/)
  switch (word) {
    case "every": {
      const [d, fromWord, from, ...extra] = rest
      const every_ms = duration(d, text)
      if (fromWord === undefined) return { kind: "every", every_ms }
      if (fromWord !== "from" || !from || extra.length || !clock(from))
        throw bad(text)
      const c = clock(from)!
      const hh = String(c.hour).padStart(2, "0")
      const mm = String(c.minute).padStart(2, "0")
      return { kind: "every", every_ms, from: `${hh}:${mm}` }
    }
    case "at": {
      const when = rest.join(" ")
      const c = clock(when)
      if (c) {
        const w = wallTime(opts.now, opts.tz)
        let t = zonedInstant(w.year, w.month, w.day, c.hour, c.minute, opts.tz)
        if (t <= opts.now) {
          const next = new Date(Date.UTC(w.year, w.month - 1, w.day + 1))
          t = zonedInstant(
            next.getUTCFullYear(),
            next.getUTCMonth() + 1,
            next.getUTCDate(),
            c.hour,
            c.minute,
            opts.tz,
          )
        }
        return { kind: "at", at: new Date(t).toISOString() }
      }
      return {
        kind: "at",
        at: new Date(instant(when, opts.tz, text)).toISOString(),
      }
    }
    case "cron": {
      const m = /^cron\s+(["'])(.+?)\1(?:\s+(\S+))?$/.exec(text)
      if (!m) throw bad(text, "put the cron fields in quotes")
      const cron = (m[2] ?? "").trim().split(/\s+/).join(" ")
      const tz = m[3] ?? opts.tz
      try {
        parseCron(cron)
      } catch (err) {
        throw bad(text, (err as Error).message)
      }
      if (!isTimeZone(tz)) throw bad(text, `unknown time zone ${tz}`)
      return { kind: "cron", cron, tz }
    }
    case "idle": {
      const [d, repeat, ...extra] = rest
      const idle_ms = duration(d, text)
      if (extra.length || (repeat !== undefined && repeat !== "repeat"))
        throw bad(text)
      return { kind: "idle", idle_ms, repeat: repeat === "repeat" }
    }
    case "fire-only":
      if (rest.length) throw bad(text)
      return { kind: "fire-only" }
    default:
      throw bad(text)
  }
}

export function formatTrigger(t: Trigger): string {
  switch (t.kind) {
    case "every":
      return (
        `every ${formatDuration(t.every_ms)}` +
        (t.from ? ` from ${t.from}` : "")
      )
    case "at":
      return `at ${t.at}`
    case "cron":
      return `cron "${t.cron}" ${t.tz}`
    case "idle":
      return `idle ${formatDuration(t.idle_ms)}${t.repeat ? " repeat" : ""}`
    case "fire-only":
      return "fire-only"
  }
}

/*
 * When a trigger runs next, strictly after `after`; null for idle and
 * fire-only (they have no time of their own) and for a past `at`. `anchor` is
 * when the wake was set: `every` steps from it (or from its `from` time on that
 * day).
 */
export function nextRun(
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
