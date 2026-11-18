/*
 * The docs against the code (the adversarial review of 0b2, 2026-11-08; the
 * owner, 2026-11-09: one reference, reference.md, in place of docs/runbook.md
 * and docs/howto.md, and AGENT.md pointing to autocode.admin.agent.md and
 * autocode.consumer.agent.md): the help topics the reference lists are the
 * guide's, notices come from `autocode`, a script in an agent's shell is not
 * offered the API, prose lines are at most 120 columns, and what went is
 * gone everywhere people read. For 1.0.0 (the owner, 2026-11-17): building
 * and testing are in DEVELOPMENT.md, and the reference names every command
 * of the CLI, every kind of History, and the steps an operator needs.
 */
import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { TOPICS } from "../../plugin/src/guide.ts"

const root = resolve(import.meta.dir, "../..")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")
const flat = (path: string) => read(path).replace(/\s+/g, " ")

// What people read: the README, the reference, the contributors' file, the
// agents' files, Help.
const DOCS = [
  "README.md",
  "reference.md",
  "DEVELOPMENT.md",
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

/*
 * The owner, 2026-11-17 ("update docs to say that Autocode is long-term
 * autonomy support framework. frame intro sections and feature lists in
 * that manner. make them more ficused and less verbose"; first asked on
 * 2026-11-07, and lost in the 1.0.0 documentation pass).
 */
test("every document says what Autocode is: a long-term autonomy support framework, in its opening", () => {
  const opening = (path: string, chars: number) => flat(path).slice(0, chars)
  expect(opening("README.md", 400)).toContain(
    "Autocode is a long-term autonomy support framework",
  )
  expect(opening("reference.md", 400)).toContain(
    "Autocode is a long-term autonomy support framework",
  )
  const admin = flat("autocode.admin.agent.md")
  expect(
    admin.slice(admin.indexOf("## What This Repository Is")).slice(0, 300),
  ).toContain("Autocode is a long-term autonomy support framework")
  const guide = flat("autocode.consumer.agent.md")
  expect(guide.slice(guide.indexOf("# Autocode")).slice(0, 300)).toContain(
    "Autocode is a long-term autonomy support framework",
  )
  const help = flat("web/src/app/help/help-page.html")
  expect(help.slice(help.indexOf('id="what"')).slice(0, 500)).toContain(
    "Autocode is a long-term autonomy support framework",
  )
})

// Focused: the README's list of what Autocode provides is nine short items,
// none longer than two lines of 120 columns.
test("the README's feature list is short: nine items of at most two lines", () => {
  const readme = read("README.md")
  const list = readme
    .slice(readme.indexOf("What Autocode provides:"))
    .split("\n\n")[1]!
  const items = list.split(/\n(?=- \*\*)/)
  expect(items.length).toBe(9)
  for (const item of items)
    expect(item.split("\n").length, item).toBeLessThanOrEqual(2)
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
  for (const path of [
    "reference.md",
    "DEVELOPMENT.md",
    "AGENT.md",
    "autocode.admin.agent.md",
  ]) {
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

// For 1.0.0: building, the suites and the CI scripts moved out of the
// reference, which keeps a pointer.
test("the reference points to DEVELOPMENT.md, which has the build and the suites", () => {
  expect(read("reference.md")).toContain("(DEVELOPMENT.md)")
  const dev = read("DEVELOPMENT.md")
  for (const part of ["## Build", "## Tests", "ci/dist.sh", "ci/run.sh"])
    expect(dev, part).toContain(part)
  // the build counter is explained, a fresh clone's first build too
  expect(flat("DEVELOPMENT.md")).toContain("the first build is number 1")
  expect(read("reference.md")).not.toContain("ci/live-server.sh")
})

test("the reference names every command of the CLI, and the flags of each", () => {
  const ref = read("reference.md")
  const main = read("cli/src/main.ts")
  const commands = [...main.matchAll(/^ {4}case "([a-z-]+)":/gm)].map(
    (m) => m[1],
  )
  expect(commands.length).toBeGreaterThan(20)
  for (const command of commands)
    expect(ref, command).toContain(`\`autocode ${command}`)
  // each flag's value is named as the usage text names it
  const usage = /const USAGE = `([^`]*)`/.exec(main)?.[1] ?? ""
  const values = usage.match(/--[a-z-]+ [A-Z][A-Z_/]*/g) ?? []
  expect(values.length).toBeGreaterThan(25)
  for (const value of new Set(values)) expect(ref, value).toContain(value)
  for (const flag of [
    "--consumer-token-file FILE",
    "--admin-token-file FILE",
    "--force",
    "--keep-session",
    "token rotate --admin",
    "token rotate --consumer",
    "autocode version",
    "--json",
  ])
    expect(ref, flag).toContain(flag)
  // the flags of `serve` for development and tests: DEVELOPMENT.md only
  const dev = read("DEVELOPMENT.md")
  for (const flag of ["--web-dir", "--poll-wait", "--offline-after"]) {
    expect(dev, flag).toContain(flag)
    expect(ref, flag).not.toContain(flag)
  }
  // exit codes are every command's, in a section of their own
  expect(ref).toContain("### Exit Codes")
})

test("the reference lists every kind of History", () => {
  const ref = read("reference.md")
  const dir = resolve(root, "server/src")
  const kinds = new Set<string>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue
    const source = readFileSync(resolve(dir, file), "utf8")
    // the first argument of each record(...): one kind, or one of two
    for (const call of source.matchAll(/\.record\(([^,{]*)/g))
      for (const kind of (call[1] ?? "").matchAll(/"([a-z_.]+)"/g))
        kinds.add(kind[1] ?? "")
  }
  expect(kinds.size).toBeGreaterThan(60)
  for (const kind of kinds) expect(ref, kind).toContain(`\`${kind}\``)
})

// What the operator's test read could not find or found twice, differently.
test("the reference has the operator's procedures and one answer each", () => {
  const ref = read("reference.md")
  for (const heading of [
    "### Back Up",
    "### Upgrade",
    "### Roll Back",
    "### Move the Server",
    "### Replace a Leaked Token",
    "### Stop an Agent That Overspends",
    "### What the Database Keeps",
    "### I Cannot Sign In",
    "### The Server Does Not Start",
    "### A Host Is Offline Though OpenCode Runs",
    "### The Tools Are Missing",
    "### A Message Does Not Arrive",
  ])
    expect(ref, heading).toContain(heading)
  const text = flat("reference.md")
  // a deleted session leaves its agent registered, offline
  expect(text).toContain("A deleted session does not unregister its agent")
  expect(text).not.toMatch(/Unregistered by[^.]*when its session is deleted/)
  // an older binary refuses a newer database: the backup is needed
  expect(text).toContain("newer than this autocode knows")
  // no command stops one agent's turn or one run
  expect(text).toContain("No Autocode command interrupts the turn of one agent")
  expect(text).toContain("No command stops one run")
  // the web UI has tabs, not pages
  expect(text).not.toMatch(
    /\b(Agents|Hosts|Wakes|Jobs|Locks|Messages|Settings) page\b/,
  )
})
