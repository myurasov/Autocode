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
