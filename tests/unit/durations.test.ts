/*
 * Durations such as 90s or 1h30m: the units parseDuration accepts, alone or
 * combined, a bare number as seconds, the texts it refuses, and
 * formatDuration's shortest exact form.
 */
import { describe, expect, test } from "bun:test"
import { formatDuration, parseDuration } from "@autocode/shared"

const s = 1000
const m = 60 * s
const h = 60 * m
const d = 24 * h

describe("durations", () => {
  test("units s, m, h, d and w, alone or combined", () => {
    expect(parseDuration("90s")).toBe(90 * s)
    expect(parseDuration("5m")).toBe(5 * m)
    expect(parseDuration("2h")).toBe(2 * h)
    expect(parseDuration("14d")).toBe(14 * d)
    expect(parseDuration("1w")).toBe(7 * d)
    expect(parseDuration("1h30m")).toBe(h + 30 * m)
    expect(parseDuration("500ms")).toBe(500)
  })

  test("a bare number is seconds", () => {
    expect(parseDuration("240")).toBe(240 * s)
    expect(parseDuration(240)).toBe(240 * s)
  })

  test("garbage, negatives and zero-unit strings are refused", () => {
    for (const bad of ["", "abc", "5x", "-5m", "m", "1h 30m", "1.5h"])
      expect(() => parseDuration(bad)).toThrow()
  })

  test("formatting gives the shortest exact form", () => {
    expect(formatDuration(60 * s)).toBe("1m")
    expect(formatDuration(90 * s)).toBe("1m30s")
    expect(formatDuration(14 * d)).toBe("14d")
    expect(formatDuration(h + 30 * m)).toBe("1h30m")
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(1500)).toBe("1s500ms")
  })
})
