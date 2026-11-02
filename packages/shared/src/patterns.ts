/*
 * ID patterns: parses a pattern and tells whether an ID matches it (for
 * discovering agents and for settings rules).
 */

import { AutocodeError } from "./errors.ts"

// A pattern is an ID with * wildcards (kaggle:*, *:reviewer), or a list of IDs
// and patterns separated by commas.
const ITEM = /^[A-Za-z0-9._:*-]{1,255}$/

export function parsePattern(input: string | readonly string[]): string[] {
  const items =
    typeof input === "string"
      ? input.split(",").map((s) => s.trim())
      : input.map((s) => String(s).trim())
  if (items.length === 0 || items.some((item) => !ITEM.test(item)))
    throw new AutocodeError(
      "bad_pattern",
      "a pattern is one or more IDs with * wildcards, separated by commas " +
        `(got ${JSON.stringify(input)})`,
    )
  return items
}

function itemMatches(item: string, id: string): boolean {
  if (!item.includes("*")) return item === id
  const parts = item.split("*")
  const first = parts[0] ?? ""
  const last = parts[parts.length - 1] ?? ""
  if (
    !id.startsWith(first) ||
    !id.endsWith(last) ||
    id.length < first.length + last.length
  )
    return false
  let at = first.length
  const end = id.length - last.length
  for (const part of parts.slice(1, -1)) {
    const found = id.indexOf(part, at)
    if (found < 0 || found + part.length > end) return false
    at = found + part.length
  }
  return true
}

export function matchesPattern(
  pattern: string | readonly string[],
  id: string,
): boolean {
  return parsePattern(pattern).some((item) => itemMatches(item, id))
}
