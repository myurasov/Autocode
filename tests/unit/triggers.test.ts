/*
 * Wake triggers (spec, Wakes): parsing and formatting the trigger text, and
 * when each one runs next. Cron runs on local wall time in its time zone: a
 * time a daylight-saving change skips runs at the next minute that exists, and
 * a repeated one runs once. Fixed dates in Los Angeles, 2026: clocks went
 * forward on 8 March at 2:00 and back on 1 November at 2:00.
 */
import { describe, expect, test } from "bun:test"
import {
  cronNext,
  formatTrigger,
  localTime,
  nextRun,
  parseCron,
  parseTrigger,
  wallTime,
  zonedInstant,
} from "@autocode/shared"

const LA = "America/Los_Angeles"
const at = (iso: string) => Date.parse(iso)
const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString()
const opts = { tz: LA, now: at("2026-11-02T17:00:00Z") } // 09:00 PST, Monday

describe("parseTrigger", () => {
  test("every, with an optional start time", () => {
    expect(parseTrigger("every 30m", opts)).toEqual({
      kind: "every",
      every_ms: 1_800_000,
    })
    expect(parseTrigger("every 1h from 09:30", opts)).toEqual({
      kind: "every",
      every_ms: 3_600_000,
      from: "09:30",
    })
  })

  test("at: a full time, a local time in the zone, or the next HH:MM", () => {
    expect(parseTrigger("at 2026-11-03T09:00:00Z", opts)).toEqual({
      kind: "at",
      at: "2026-11-03T09:00:00.000Z",
    })
    // no zone: wall time in the given zone (PST is UTC-8)
    expect(parseTrigger("at 2026-11-03 09:00", opts)).toEqual({
      kind: "at",
      at: "2026-11-03T17:00:00.000Z",
    })
    // the next 08:00 after 09:00 is tomorrow's
    expect(parseTrigger("at 08:00", opts)).toEqual({
      kind: "at",
      at: "2026-11-03T16:00:00.000Z",
    })
    expect(parseTrigger("at 10:15", opts)).toEqual({
      kind: "at",
      at: "2026-11-02T18:15:00.000Z",
    })
  })

  test("in: once, that long after it is set (tier 0b2)", () => {
    expect(parseTrigger("in 45m", opts)).toEqual({
      kind: "at",
      at: "2026-11-02T17:45:00.000Z",
    })
    expect(parseTrigger("in 1h30m", opts)).toEqual({
      kind: "at",
      at: "2026-11-02T18:30:00.000Z",
    })
    for (const bad of ["in", "in soon", "in 0s", "in 500ms", "in 5m now"])
      expect(() => parseTrigger(bad, opts), bad).toThrow(/trigger/)
  })

  test("the help text names every kind of trigger", () => {
    try {
      parseTrigger("sometimes", opts)
    } catch (err) {
      const message = (err as Error).message
      for (const kind of ["every", "in 45m", "at", "cron", "idle", "fire-only"])
        expect(message).toContain(kind)
    }
  })

  test("cron, quoted, with the zone given or the default one", () => {
    expect(parseTrigger('cron "0 9 * * 1-5"', opts)).toEqual({
      kind: "cron",
      cron: "0 9 * * 1-5",
      tz: LA,
    })
    expect(
      parseTrigger("cron '*/15 9-16 * * mon-fri' Europe/Berlin", opts),
    ).toEqual({
      kind: "cron",
      cron: "*/15 9-16 * * mon-fri",
      tz: "Europe/Berlin",
    })
  })

  test("idle, with or without repeat; fire-only", () => {
    expect(parseTrigger("idle 45m", opts)).toEqual({
      kind: "idle",
      idle_ms: 2_700_000,
      repeat: false,
    })
    expect(parseTrigger("idle 2h repeat", opts)).toEqual({
      kind: "idle",
      idle_ms: 7_200_000,
      repeat: true,
    })
    expect(parseTrigger("fire-only", opts)).toEqual({ kind: "fire-only" })
  })

  test("refuses what it cannot read, and says what a trigger looks like", () => {
    for (const bad of [
      "",
      "sometimes",
      "every",
      "every 0s",
      "every soon",
      "at noon",
      "at 2026-13-01 09:00",
      "at 25:00",
      'cron "61 * * * *"',
      'cron "* * *"',
      'cron "0 9 * * *" Mars/Olympus',
      "idle",
      "idle 5m forever",
      "fire-only now",
    ])
      expect(() => parseTrigger(bad, opts), bad).toThrow(/trigger/)
  })

  // The review of 0b2 (2026-11-08): a duration past ten years, or one that
  // is not a finite number, would break the wake's times (Invalid Date).
  test("refuses durations too long or not finite", () => {
    for (const bad of [
      "every 20000000w",
      "in 20000000w",
      "idle 20000000w",
      `idle ${"9".repeat(400)}s repeat`,
      "every 521w2d",
    ])
      expect(() => parseTrigger(bad, opts), bad).toThrow(/trigger/)
    expect(parseTrigger("every 520w", opts)).toMatchObject({ kind: "every" })
  })

  test("formats back to text it reads again", () => {
    for (const text of [
      "every 30m",
      "every 1h from 09:30",
      "at 2026-11-03T09:00:00.000Z",
      `cron "0 9 * * 1-5" ${LA}`,
      "idle 45m",
      "idle 2h repeat",
      "fire-only",
    ]) {
      const t = parseTrigger(text, opts)
      expect(formatTrigger(t)).toBe(text)
      expect(parseTrigger(formatTrigger(t), opts)).toEqual(t)
    }
  })
})

describe("nextRun", () => {
  test("every: steps from its anchor (the time it was set), never at or before `after`", () => {
    const t = parseTrigger("every 30m", opts)
    const anchor = at("2026-11-02T17:00:00Z")
    expect(iso(nextRun(t, anchor, { anchor, tz: LA }))).toBe(
      "2026-11-02T17:30:00.000Z",
    )
    expect(
      iso(nextRun(t, at("2026-11-02T18:10:00Z"), { anchor, tz: LA })),
    ).toBe("2026-11-02T18:30:00.000Z")
    expect(
      iso(nextRun(t, at("2026-11-02T18:30:00Z"), { anchor, tz: LA })),
    ).toBe("2026-11-02T19:00:00.000Z")
  })

  test("every from HH:MM: steps from that wall time on the day it was set", () => {
    const t = parseTrigger("every 2h from 08:00", opts)
    const anchor = at("2026-11-02T17:00:00Z") // 09:00 PST
    // 08:00 PST = 16:00Z, so 18:00Z (10:00) is next
    expect(iso(nextRun(t, anchor, { anchor, tz: LA }))).toBe(
      "2026-11-02T18:00:00.000Z",
    )
  })

  test("at: once, then never", () => {
    const t = parseTrigger("at 2026-11-03T09:00:00Z", opts)
    expect(iso(nextRun(t, at("2026-11-02T00:00:00Z"), { tz: LA }))).toBe(
      "2026-11-03T09:00:00.000Z",
    )
    expect(nextRun(t, at("2026-11-03T09:00:00Z"), { tz: LA })).toBeNull()
  })

  test("idle and fire-only have no time of their own", () => {
    expect(nextRun(parseTrigger("idle 5m", opts), 0, { tz: LA })).toBeNull()
    expect(nextRun(parseTrigger("fire-only", opts), 0, { tz: LA })).toBeNull()
  })

  test("cron goes through the cron rules", () => {
    const t = parseTrigger('cron "0 9 * * 1-5"', opts)
    // Friday 2026-11-06 10:00 PST -> Monday 09:00 PST
    expect(iso(nextRun(t, at("2026-11-06T18:00:00Z"), { tz: LA }))).toBe(
      "2026-11-09T17:00:00.000Z",
    )
  })
})

describe("cron", () => {
  test("parses fields: lists, ranges, steps, names, 7 as Sunday", () => {
    const c = parseCron("0,30 9-17/4 1 jan,jul sun")
    expect([...c.minutes]).toEqual([0, 30])
    expect([...c.hours]).toEqual([9, 13, 17])
    expect([...c.days]).toEqual([1])
    expect([...c.months]).toEqual([1, 7])
    expect([...c.weekdays]).toEqual([0])
    expect([...parseCron("* * * * 7").weekdays]).toEqual([0])
    expect([...parseCron("*/20 * * * *").minutes]).toEqual([0, 20, 40])
  })

  test("refuses bad fields", () => {
    for (const bad of [
      "",
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "* * * * 8",
      "*/0 * * * *",
      "5-1 * * * *",
      "a * * * *",
    ])
      expect(() => parseCron(bad), bad).toThrow()
  })

  test("weekdays at 9:00 in the zone, every 15 minutes in market hours", () => {
    expect(iso(cronNext("0 9 * * 1-5", LA, at("2026-11-02T17:00:00Z")))).toBe(
      "2026-11-03T17:00:00.000Z",
    )
    const market = "*/15 9-15 * * 1-5"
    expect(iso(cronNext(market, LA, at("2026-11-02T17:00:00Z")))).toBe(
      "2026-11-02T17:15:00.000Z",
    )
    // 15:45 is the last of the day; then Tuesday 09:00
    expect(iso(cronNext(market, LA, at("2026-11-02T23:45:00Z")))).toBe(
      "2026-11-03T17:00:00.000Z",
    )
  })

  test("the 1st of the month; day of month OR weekday when both are set", () => {
    expect(iso(cronNext("0 0 1 * *", "UTC", at("2026-11-02T00:00:00Z")))).toBe(
      "2026-12-01T00:00:00.000Z",
    )
    // the 15th or any Monday, whichever comes first
    expect(iso(cronNext("0 0 15 * 1", "UTC", at("2026-11-03T00:00:00Z")))).toBe(
      "2026-11-09T00:00:00.000Z",
    )
  })

  test("a time the clocks skip runs at the next minute that exists", () => {
    // 8 March 2026: 02:00 PST jumps to 03:00 PDT; 02:30 does not exist
    expect(iso(cronNext("30 2 * * *", LA, at("2026-03-08T09:00:00Z")))).toBe(
      "2026-03-08T10:00:00.000Z", // 03:00 PDT
    )
    // every 15 minutes through the gap: 01:45 PST, then 03:00 PDT once
    expect(iso(cronNext("*/15 * * * *", LA, at("2026-03-08T09:45:00Z")))).toBe(
      "2026-03-08T10:00:00.000Z",
    )
    expect(iso(cronNext("*/15 * * * *", LA, at("2026-03-08T10:00:00Z")))).toBe(
      "2026-03-08T10:15:00.000Z",
    )
  })

  test("a time the clocks repeat runs once", () => {
    // 1 November 2026: 02:00 PDT falls back to 01:00 PST; 01:30 comes twice
    expect(iso(cronNext("30 1 * * *", LA, at("2026-11-01T07:00:00Z")))).toBe(
      "2026-11-01T08:30:00.000Z", // the first 01:30 (PDT)
    )
    expect(iso(cronNext("30 1 * * *", LA, at("2026-11-01T08:30:00Z")))).toBe(
      "2026-11-02T09:30:00.000Z", // not the second 01:30; the next day's
    )
    // every 15 minutes: after 01:45 PDT comes 02:00 PST, not 01:00 PST again
    expect(iso(cronNext("*/15 * * * *", LA, at("2026-11-01T08:45:00Z")))).toBe(
      "2026-11-01T10:00:00.000Z",
    )
  })

  test("a date that never comes gives null", () => {
    expect(cronNext("0 0 31 2 *", "UTC", at("2026-01-01T00:00:00Z"))).toBeNull()
  })
})

describe("zoned times", () => {
  test("localTime: wall time with the zone's short name", () => {
    expect(localTime(at("2026-11-02T17:00:00Z"), LA)).toBe(
      "2026-11-02 09:00 PST",
    )
    expect(localTime(at("2026-07-01T16:00:00Z"), LA)).toBe(
      "2026-07-01 09:00 PDT",
    )
    expect(localTime(at("2026-07-01T16:05:00Z"), "UTC")).toBe(
      "2026-07-01 16:05 UTC",
    )
  })

  test("wall time of an instant, and the instant of a wall time", () => {
    expect(wallTime(at("2026-11-02T17:00:00Z"), LA)).toEqual({
      year: 2026,
      month: 11,
      day: 2,
      hour: 9,
      minute: 0,
      weekday: 1,
    })
    expect(iso(zonedInstant(2026, 7, 1, 9, 0, LA))).toBe(
      "2026-07-01T16:00:00.000Z",
    )
    // skipped: the next minute that exists; repeated: the first
    expect(iso(zonedInstant(2026, 3, 8, 2, 30, LA))).toBe(
      "2026-03-08T10:00:00.000Z",
    )
    expect(iso(zonedInstant(2026, 11, 1, 1, 30, LA))).toBe(
      "2026-11-01T08:30:00.000Z",
    )
  })
})
