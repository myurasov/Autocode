/*
 * Parses duration text into milliseconds and formats milliseconds as duration
 * text.
 */

import { AutocodeError } from "./errors.ts"

// Durations: "90s", "5m", "1h30m", "14d", "1w", "500ms"; a bare number is
// seconds.
const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}
const FORMAT_UNITS: [string, number][] = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1000],
  ["ms", 1],
]

export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0)
      throw new AutocodeError("bad_duration", `bad duration: ${input}`)
    return Math.round(input * 1000)
  }
  const text = String(input).trim()
  if (/^\d+$/.test(text)) return Number(text) * 1000
  if (!/^(\d+(ms|s|m|h|d|w))+$/.test(text))
    throw new AutocodeError(
      "bad_duration",
      "a duration looks like 90s, 5m, 1h30m or 14d " +
        `(got ${JSON.stringify(input)})`,
    )
  let total = 0
  for (const match of text.matchAll(/(\d+)(ms|s|m|h|d|w)/g))
    total += Number(match[1]) * (UNITS[match[2] ?? "s"] ?? 0)
  return total
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s"
  let rest = Math.round(ms)
  let out = ""
  for (const [unit, size] of FORMAT_UNITS) {
    const n = Math.floor(rest / size)
    if (n > 0) {
      out += `${n}${unit}`
      rest -= n * size
    }
  }
  return out
}
