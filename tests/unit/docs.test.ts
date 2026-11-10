/*
 * The docs against the code (the adversarial review of 0b2, 2026-11-08; the
 * owner, 2026-11-09: one reference, reference.md, in place of docs/runbook.md
 * and docs/howto.md, and AGENT.md pointing to autocode.admin.agent.md and
 * autocode.consumer.agent.md): the help topics the reference lists are the
 * guide's, notices come from `autocode`, a script in an agent's shell is not
 * offered the API, prose lines are at most 120 columns, and what went is
 * gone everywhere people read.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { TOPICS } from "../../plugin/src/guide.ts"

const root = resolve(import.meta.dir, "../..")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")
const flat = (path: string) => read(path).replace(/\s+/g, " ")

// What people read: the README, the reference, the agents' files, Help.
const DOCS = [
  "README.md",
  "reference.md",
  "AGENT.md",
  "autocode.admin.agent.md",
  "autocode.consumer.agent.md",
  "web/src/app/help/help-page.html",
]

test("one reference: reference.md at the root; docs/ is gone", () => {
  expect(existsSync(resolve(root, "reference.md"))).toBe(true)
  for (const gone of ["docs/runbook.md", "docs/howto.md", "docs/tests.md"])
    expect(existsSync(resolve(root, gone)), gone).toBe(false)
  for (const path of DOCS)
    expect(read(path), path).not.toMatch(/docs\/(runbook|howto|tests)\.md/)
})

test("AGENT.md points to the admin and the consumer files, which say what they are", () => {
  const agent = read("AGENT.md")
  expect(agent).toContain("(autocode.admin.agent.md)")
  expect(agent).toContain("(autocode.consumer.agent.md)")
  const admin = flat("autocode.admin.agent.md")
  expect(admin).toContain("## What This Repository Is")
  expect(admin).toContain("## Install")
  expect(admin).toContain("autocode plugin install")
  // the consumer file is the skill's source (agent-guide.test.ts checks it)
  expect(read("autocode.consumer.agent.md")).toContain(
    "<!-- topic: overview -->",
  )
})

test("README and Help list what Autocode provides; no needs table", () => {
  const readme = read("README.md")
  expect(readme).not.toContain("| An autonomous agent needs to |")
  expect(readme).toContain("What Autocode provides:")
  const help = read("web/src/app/help/help-page.html")
  expect(help).not.toContain("What an Agent Needs")
  expect(help).toContain('<ul class="provides">')
})

test("the reference lists every help topic, in the guide's order", () => {
  const line = /`topic=` one part: ([^.]+)\./.exec(flat("reference.md"))
  expect(line, "the topic list").not.toBeNull()
  const listed = [...line![1]!.matchAll(/`([a-z]+)`/g)].map((m) => m[1])
  expect(listed).toEqual([...TOPICS])
})

test("the reference: notices come from autocode; no API for scripts", () => {
  const text = flat("reference.md")
  expect(text).not.toContain("later: cap warnings")
  expect(text).not.toContain("later: approval answers")
  expect(text).toContain("Notices arrive as messages from `autocode`")
  expect(text).not.toContain("Without the command, the API works too")
})

test("the docs' prose lines are at most 120 columns", () => {
  for (const path of DOCS.filter((p) => p.endsWith(".md"))) {
    let fence = false
    const long: number[] = []
    read(path)
      .split("\n")
      .forEach((l, i) => {
        if (l.trimStart().startsWith("```")) fence = !fence
        else if (!fence && !l.startsWith("|") && l.length > 120)
          long.push(i + 1)
      })
    expect(long, path).toEqual([])
  }
})

test("the docs tell no development history", () => {
  for (const path of ["reference.md", "AGENT.md", "autocode.admin.agent.md"]) {
    const text = flat(path)
    expect(text, path).not.toMatch(/\btier 0[a-g]\b/i)
    expect(text, path).not.toMatch(/\(now\)/)
    expect(text, path).not.toMatch(/the owner, 20\d\d-/)
  }
})

// The final review (2026-11-08): no word of inline_limit or unread in what
// owners and agents read; the owner, 2026-11-09: list, read and wait are
// back, one final state `read` (no `delivered`), and no "no reading or
// waiting". The Costs tab and `autocode costs` are named.
const gone = [
  /\binline_limit\b/,
  /\bunread\b/i,
  /queued, delivered/,
  /\bdelivered \(in a prompt/,
  /no reading or waiting/i,
]

test("the docs and Help say nothing of what went", () => {
  for (const path of DOCS)
    for (const pattern of gone)
      expect(flat(path), `${path} ${pattern}`).not.toMatch(pattern)
})

test("README, the reference and Help say messages steer into a running turn, and list, read and wait", () => {
  for (const path of [
    "README.md",
    "reference.md",
    "web/src/app/help/help-page.html",
  ]) {
    const text = flat(path)
    expect(text, path).toMatch(/at (its|the turn's) next step/)
    expect(text, path).toMatch(/\bread\b.*\bwait\b/)
  }
  const ref = flat("reference.md")
  for (const action of ["action=list", "action=read", "action=wait"])
    expect(ref).toContain(action)
})

test("README and the reference name the Costs tab and autocode costs", () => {
  for (const path of ["README.md", "reference.md"]) {
    const text = read(path)
    expect(text, path).toContain("autocode costs")
    expect(text, path).toMatch(/\bCosts\b/)
  }
})

// The owner, 2026-11-09: an idle agent past compact_at is told and compacted
// even with nothing waiting.
test("the reference says a compaction comes even with nothing waiting", () => {
  expect(flat("reference.md")).toContain("even when nothing waits for it")
})
