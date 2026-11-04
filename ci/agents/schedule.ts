/*
 * The agents suite's check of a work-hours schedule: the runs of one or more
 * wake triggers together, over a week.
 */
import { nextRun, parseTrigger, wallTime } from "@autocode/shared"

const MIN = 60_000

/*
 * A work-hours schedule over a week (Monday 2026-11-09, Pacific), from one or
 * more triggers together: runs only on weekdays, between 09:00 and 17:30, at
 * least 16 a day, 30 minutes apart. Null when it holds; else why not.
 */
export function workHours(triggers: string[]): string | null {
  const all = triggers.join(" + ")
  const start = Date.parse("2026-11-09T08:00:00Z") // Monday 00:00 PST
  const end = start + 7 * 24 * 60 * MIN
  const runs = new Set<number>()
  for (const trigger of triggers) {
    let t: ReturnType<typeof parseTrigger>
    try {
      t = parseTrigger(trigger, { tz: "UTC", now: Date.now() })
    } catch {
      return `a trigger the server would not take: ${trigger}`
    }
    if (t.kind !== "cron")
      return `${trigger}: not a clock schedule for weekdays in work hours`
    for (let after = start - 1; ; ) {
      const at = nextRun(t, after, { tz: t.tz })
      if (at === null || at >= end) break
      after = at
      runs.add(at)
    }
  }
  const LA = "America/Los_Angeles"
  const perDay = new Map<number, number[]>()
  for (const at of [...runs].sort((x, y) => x - y)) {
    const w = wallTime(at, LA)
    if (w.weekday === 0 || w.weekday === 6) return `${all} runs on weekends`
    const minute = w.hour * 60 + w.minute
    if (minute < 9 * 60 || minute > 17 * 60 + 30)
      return (
        `${all} runs at ${w.hour}:` +
        `${String(w.minute).padStart(2, "0")} Pacific`
      )
    const day = perDay.get(w.day) ?? []
    day.push(at)
    perDay.set(w.day, day)
  }
  if (perDay.size !== 5) return `${all} runs on ${perDay.size} weekdays, not 5`
  for (const day of perDay.values()) {
    if (day.length < 16) return `${all} runs ${day.length} times a day`
    for (let i = 1; i < day.length; i++)
      if (day[i]! - day[i - 1]! !== 30 * MIN)
        return `${all} is not every 30 minutes`
  }
  return null
}
