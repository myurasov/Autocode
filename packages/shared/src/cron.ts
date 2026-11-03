/*
 * Wall time in a time zone, and five-field cron (minute hour day month
 * weekday) on it. A wall time that a daylight-saving change skips maps to the
 * next minute that exists; one it repeats maps to its first occurrence, so a
 * cron time runs once either way.
 */

import { AutocodeError } from "./errors.ts"

export interface WallTime {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  weekday: number // 0 = Sunday
}

const formats = new Map<string, Intl.DateTimeFormat>()

function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    })
    formats.set(tz, f)
  }
  return f
}

export function isTimeZone(tz: string): boolean {
  try {
    format(tz)
    return true
  } catch {
    return false
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export function wallTime(instant: number, tz: string): WallTime {
  const parts: Record<string, string> = {}
  for (const p of format(tz).formatToParts(new Date(instant)))
    parts[p.type] = p.value
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ""),
  }
}

// The wall time as if it were UTC (for arithmetic on wall times).
function wallMs(w: Omit<WallTime, "weekday">): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute)
}

function sameWall(instant: number, local: number, tz: string): boolean {
  return wallMs(wallTime(instant, tz)) === local
}

/*
 * The instant of a wall time in a zone: its first occurrence when the clocks
 * repeat it, and the next minute that exists when they skip it.
 */
export function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const start = Date.UTC(year, month - 1, day, hour, minute)
  for (let step = 0; step <= 180; step++) {
    const local = start + step * 60_000
    // A zone's offset is within a day of UTC; try both offsets seen around it.
    const found = new Set<number>()
    for (const probe of [local - 86_400_000, local, local + 86_400_000]) {
      const w = wallTime(probe, tz)
      const offset = wallMs(w) - Math.floor(probe / 60_000) * 60_000
      const candidate = local - offset
      if (sameWall(candidate, local, tz)) found.add(candidate)
    }
    if (found.size) return Math.min(...found)
  }
  throw new AutocodeError("bad_time", `no such time in ${tz}`)
}

export interface Cron {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  anyDay: boolean
  anyWeekday: boolean
}

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
]
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

function field(
  text: string,
  min: number,
  max: number,
  what: string,
  names: string[] = [],
  nameBase = 0,
): Set<number> {
  const bad = () =>
    new AutocodeError("bad_cron", `bad cron ${what} field: ${text}`)
  const value = (v: string): number => {
    const named = names.indexOf(v.toLowerCase())
    if (named >= 0) return named + nameBase
    if (!/^\d+$/.test(v)) throw bad()
    return Number(v)
  }
  const out = new Set<number>()
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/")
    if (range === undefined || part.split("/").length > 2) throw bad()
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw bad()
    let lo: number
    let hi: number
    if (range === "*") {
      lo = min
      hi = max
    } else if (range.includes("-")) {
      const [a, b] = range.split("-")
      if (a === undefined || b === undefined) throw bad()
      lo = value(a)
      hi = value(b)
    } else {
      lo = value(range)
      hi = stepText === undefined ? lo : max
    }
    if (lo < min || hi > max || lo > hi) throw bad()
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function parseCron(text: string): Cron {
  const parts = String(text).trim().split(/\s+/)
  if (parts.length !== 5 || parts.some((p) => !p))
    throw new AutocodeError(
      "bad_cron",
      "cron has five fields: minute hour day month weekday",
    )
  const [m, h, d, mo, wd] = parts as [string, string, string, string, string]
  const weekdays = field(wd, 0, 7, "weekday", DAY_NAMES)
  if (weekdays.delete(7)) weekdays.add(0)
  return {
    minutes: field(m, 0, 59, "minute"),
    hours: field(h, 0, 23, "hour"),
    days: field(d, 1, 31, "day"),
    months: field(mo, 1, 12, "month", MONTH_NAMES, 1),
    weekdays: new Set([...weekdays].sort((a, b) => a - b)),
    anyDay: d === "*",
    anyWeekday: wd === "*",
  }
}

function dayMatches(c: Cron, day: number, weekday: number): boolean {
  // Classic cron: when both are restricted, either one matching is enough.
  if (c.anyDay && c.anyWeekday) return true
  if (c.anyDay) return c.weekdays.has(weekday)
  if (c.anyWeekday) return c.days.has(day)
  return c.days.has(day) || c.weekdays.has(weekday)
}

/*
 * The first run strictly after `after`, or null when none comes within five
 * years (a date that does not exist, like 31 February).
 */
export function cronNext(
  expr: string | Cron,
  tz: string,
  after: number,
): number | null {
  const c = typeof expr === "string" ? parseCron(expr) : expr
  // from the minute of `after` itself: the instants decide (a skipped time
  // just before a gap maps past `after`)
  const start = wallTime(Math.floor(after / 60_000) * 60_000, tz)
  const minutes = [...c.minutes].sort((a, b) => a - b)
  const hours = [...c.hours].sort((a, b) => a - b)
  const first = Date.UTC(start.year, start.month - 1, start.day)
  for (let offset = 0; offset < 5 * 366; offset++) {
    const date = new Date(first + offset * 86_400_000)
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    if (!c.months.has(month) || !dayMatches(c, day, date.getUTCDay())) continue
    for (const hour of hours)
      for (const minute of minutes) {
        if (
          offset === 0 &&
          (hour < start.hour || (hour === start.hour && minute < start.minute))
        )
          continue
        const instant = zonedInstant(year, month, day, hour, minute, tz)
        if (instant > after) return instant
      }
  }
  return null
}
