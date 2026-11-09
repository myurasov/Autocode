/*
 * The agents' how-to (docs/howto.md) against the code (the adversarial review
 * of 0b2, 2026-11-08): the help topics it lists are the guide's, the notices
 * it names come from `autocode`, and it does not offer the API to a script
 * in an agent's shell (it has only me, fire and send).
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { TOPICS } from "../../packages/plugin/src/guide.ts"

const howto = readFileSync(
  resolve(import.meta.dir, "../../docs/howto.md"),
  "utf8",
)

test("howto lists every help topic, in the guide's order", () => {
  const line = /`topic=` one part of it: ([^.]+)\./.exec(
    howto.replace(/\n\s*/g, " "),
  )
  expect(line, "the topic list").not.toBeNull()
  const listed = [...line![1]!.matchAll(/`([a-z]+)`/g)].map((m) => m[1])
  expect(listed).toEqual([...TOPICS])
})

test("howto: notices come from autocode, none is still to come", () => {
  const flat = howto.replace(/\n\s*/g, " ")
  expect(flat).not.toContain("later: cap warnings")
  expect(flat).not.toContain("later: approval answers")
  expect(flat).toContain("Notices arrive as messages from `autocode`")
})

test("howto does not offer Autocode's API to a script", () => {
  expect(howto).not.toContain("Without the command, the API works too")
})

test("howto's prose lines are at most 120 columns", () => {
  let fence = false
  const long: number[] = []
  howto.split("\n").forEach((l, i) => {
    if (l.trimStart().startsWith("```")) fence = !fence
    else if (!fence && !l.startsWith("|") && l.length > 120) long.push(i + 1)
  })
  expect(long).toEqual([])
})

// The final review (2026-11-08): no word of the message actions Phase 1 took
// out (list, read, wait), inline_limit, unread, or the read state, in what
// owners and agents read; the Costs tab and `autocode costs` are named.
const read = (path: string) =>
  readFileSync(resolve(import.meta.dir, "../..", path), "utf8")
const gone = [
  /list, read/,
  /read and wait/,
  /\binline_limit\b/,
  /\bunread\b/i,
  /queued, delivered,? (and |or )?read/,
  /\(queued, delivered, read\)/,
  /`read` \(id\)/,
]

test("README, runbook, howto and Help say nothing of what Phase 1 took out", () => {
  for (const path of [
    "README.md",
    "docs/runbook.md",
    "docs/howto.md",
    "packages/web/src/app/help/help-page.html",
  ]) {
    const text = read(path).replace(/\s+/g, " ")
    for (const pattern of gone)
      expect(text, `${path} ${pattern}`).not.toMatch(pattern)
  }
})

test("README and runbook name the Costs tab and autocode costs", () => {
  for (const path of ["README.md", "docs/runbook.md"]) {
    const text = read(path)
    expect(text, path).toContain("autocode costs")
    expect(text, path).toMatch(/\bCosts\b/)
  }
})
