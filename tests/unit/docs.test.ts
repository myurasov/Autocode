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
// A table since 1.1.0-rc2 (the owner, 2026-11-21: "make autocode feature
// list in the beginning of readme/help a table"): a feature and what it does.
test("the README's feature list is a short table: nine features, each in at most two lines' worth", () => {
  const readme = read("README.md")
  const table = readme
    .slice(readme.indexOf("What Autocode provides:"))
    .split("\n\n")[1]!
    .split("\n")
  expect(table.slice(0, 2)).toEqual(["| Feature | What It Does |", "|---|---|"])
  const rows = table.slice(2)
  expect(rows.map((r) => /^\| \*\*([^*]+)\*\* \| /.exec(r)?.[1])).toEqual([
    "Wakes",
    "Long commands",
    "Messages",
    "Locks",
    "Recovery",
    "Limits",
    "Your Inbox",
    "Jobs",
    "Control",
  ])
  for (const row of rows) {
    expect(row.length, row).toBeLessThanOrEqual(240)
    expect(row, row).toMatch(/[^. ] \|$/)
  }
  // no list any more
  expect(readme).not.toContain("- **Wakes:**")
})

test("README and Help list what Autocode provides; no needs table", () => {
  const readme = read("README.md")
  expect(readme).not.toContain("| An autonomous agent needs to |")
  expect(readme).toContain("What Autocode provides:")
  const help = read("web/src/app/help/help-page.html")
  expect(help).not.toContain("What an Agent Needs")
  // a table since 1.1.0-rc2 (the owner, 2026-11-21)
  expect(help).toContain('<table class="provides">')
  expect(help).not.toContain('<ul class="provides">')
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

// 1.1.0 (the owner, 2026-11-20: "implement 1-3, 5, 6, 7", from the review
// of real sessions). 5: one-shot fire-only wakes.
test("the reference has the one-shot fire-only wake: the trigger, the example and the goal", () => {
  const ref = read("reference.md")
  for (const part of [
    "| `fire-only once` | the same, for one fire: the wake is removed when it is fired",
    "name=training-done  trigger='fire-only once'",
    "| Wake me when a long command ends | a `fire-only once` wake;",
  ])
    expect(ref, part).toContain(part)
})

// 3: the status line that ends a prompt. Since 1.1.0-rc5 it is the last
// line and says how to get help; no footer line follows (the owner,
// 2026-11-22).
test("the reference and the README show a prompt's status line, its last line", () => {
  const ref = read("reference.md")
  // the line as the server writes it
  const line =
    "Server time 2026-11-03 09:00 PST. Context: 61,000 tokens, 61% of " +
    "compact_at (100,000). Cost today: $3.10 (no daily cap). " +
    '"autocode_me action=help" for more info.\n```\n'
  expect(ref).toContain(line)
  expect(ref).toContain(
    "| Status line | the server's time in its zone; the agent's context " +
      "and its share of `compact_at`, once a step has reported one; " +
      "today's spend, and the daily cap where the agent has one.",
  )
  expect(ref).toContain(
    'It ends with how an agent gets help: `"autocode_me action=help" ' +
      "for more info.` |",
  )
  expect(read("README.md")).toContain(
    "Server time 2026-11-17 14:02 PST. Context: 14,210 tokens, 14.2% of " +
      "compact_at (100,000). Cost today: $0.04 (no daily cap). " +
      '"autocode_me action=help" for more info.\n   ```\n',
  )
  // no footer line anywhere in the texts
  for (const file of [
    "reference.md",
    "README.md",
    "autocode.consumer.agent.md",
    "web/src/app/help/help-page.html",
  ])
    expect(read(file), file).not.toContain("-- Autocode")
  expect(ref).not.toContain("| Footer |")
})

// 1.1.0-rc4 (the owner, 2026-11-22): an agent never takes a registered ID,
// and closes what it put into the Inbox itself.
test("the reference has the stricter registration and an agent's own close", () => {
  const ref = read("reference.md")
  for (const part of [
    "- **A taken ID** is refused (`id_taken`). An agent can never take an " +
      "ID that is registered, also when the session\n  that held it is gone.",
    "`autocode agents register ID --session SES`, and with `--force` when " +
      "the old session still exists.",
    "- its wakes stay. No other session can register its ID.",
    "**Closing what no longer matters.** An agent can close what it put " +
      "into your Inbox itself, once it no longer needs\nyou",
    'autocode_message   action=close  id=m_7c...  text="the owner ' +
      'answered in the session"',
    'autocode_approval  action=close  id=ask_42   text="the plan changed"',
    "- **What it cannot:** another agent's items, and what was sent " +
      "under its ID before it registered; alerts, which\n  are Autocode's " +
      "word to you",
    "- **A reason is required** (`text`, at most 500 characters). " +
      "**History says who and why:**",
    "`answer` and `escalate` (`id`, `text`), `close` (`id`, `text`) |",
    "`wait` (`id`, `seconds`), `close` (`id`, `text`) |",
    "- **`action=close`** takes back an approval that no longer matters",
    "A closed approval is not an approved one.",
    "For an agent's `close`: no item of its own has that ID |",
  ])
    expect(ref, part).toContain(part)
})

// 1.1.0-rc5: an end on a periodic wake (asked for by a project).
test("the reference has the end of a periodic wake: the triggers, the rules and the notice", () => {
  const ref = read("reference.md")
  for (const part of [
    "| `every 1d until 2027-03-01` | as `every 1d`, through 1 March 2027. " +
      "Then the wake is removed |",
    '| `cron "0 9 * * 1-5" until 2027-03-01 18:00` |',
    "| `idle 30m repeat until 18:00` |",
    "- **An end.** `every`, `cron` and `idle ... repeat` take " +
      "`until <time>` as their last words.",
    "A date alone means through that day.",
    "The wake runs while its time is before the end: a run at the end " +
      "itself does not happen.",
    '`[autocode] wake "daily" ended`',
    "A job's trigger takes no end.",
    "| `wake.ended` | a wake reached the end of its trigger (`until`) and " +
      "was removed |",
    "- a wake of the agent's reached its end and was removed;",
  ])
    expect(ref, part).toContain(part)
  expect(ref).not.toContain("A wake has no end date")
})

// 1.1.0-rc5: wake_mode, and expire_after 0 (asked for by a project).
test("the reference has wake_mode, and expire_after 0 for never", () => {
  // on one line: the texts' line breaks are not what is checked here
  const ref = read("reference.md").replace(/\s+/g, " ")
  for (const part of [
    "### Your Approval of Periodic Wakes",
    "`wake_mode` setting decides, per agent or pattern, what happens to " +
      "the periodic wakes that an agent sets for itself: `every`, `cron` " +
      "and `idle ... repeat`.",
    "- `approve`, the default: the wake is set at once.",
    "- `ask`: an approval lands in your Inbox, `Wake NAME, set by AGENT`, " +
      "with the wake's exact terms",
    "- `off`: the wake is refused.",
    "autocode settings set wake_mode ask --match 'kaggle:worker-*'",
    '`[autocode] approval "Wake digest" approved`',
    "- **Changing a wake** asks again.",
    "Setting a wake again with the terms that it has now asks nothing",
    "- **What stays free:** one-time wakes (`in`, `at`, `idle` without " +
      "`repeat`, `fire-only`, `fire-only once`), cancelling and firing.",
    "- **Your own wakes** for an agent are never asked for",
    "| `wake_mode` | agent | `approve` | periodic wakes that an agent sets " +
      "(`every`, `cron`, `idle ... repeat`): set at once (`approve`), you " +
      "approve first (`ask`), or refused (`off`)",
    "| `expire_after` | agent | `14d` | unregister an agent this long " +
      "after its session's last turn. `0`: never |",
    "With `expire_after` `0` an agent never expires",
    "A rule applies to every agent whose ID matches it, also to one that " +
      "registers after the rule was set;",
  ])
    expect(ref, part).toContain(part)
})

// 1: a wake's own time limit for its check.
test("the reference has a wake's own check timeout: the tool, the command, the setting", () => {
  const ref = read("reference.md")
  for (const part of [
    "| `check_timeout_max` | agent | `10m` |",
    "[--check COMMAND] [--check-timeout DURATION]`",
    "check_timeout=5m",
    "A check may do the routine pass",
  ])
    expect(ref, part).toContain(part)
})

// 2: what each wake costs.
test("the reference says what each wake costs, where it shows and what is not counted", () => {
  const ref = read("reference.md")
  for (const part of [
    "### What a Wake Costs",
    "**Last 7 Days**",
    "| `autocode wakes [AGENT]` | every wake, or one agent's: agent, name, trigger, next, check, turns and cost in the last 7 days, last set, text |",
    // 1.1.0-rc2 (the owner, 2026-11-20: "can we fix that?"): such a turn
    // counts for the wake before it
    "| turns | the turns that its prompts started, and the turns that OpenCode started by itself for work they began |",
    // exact attribution (the owner, 2026-11-21: "ok, lets build it!")
    "| dollars | the model steps of those turns, and of the Subagents they started, however long those work |",
    "- **Work that outlives its turn stays with its wake.**",
    "also when other wakes' turns ran meanwhile",
    "- **Not counted:** a turn that you start in the session, and the work it starts.",
    "divides each step's cost among them equally",
  ])
    expect(ref, part).toContain(part)
})

// 6: an agent is renamed in place; unregistering keeps its unread messages
// to the owner.
test("the reference has renaming in place, and what unregistering keeps", () => {
  const ref = read("reference.md")
  for (const part of [
    "### Renaming an Agent",
    "| `autocode agents rename AGENT NEW-ID` |",
    "`rename` (`id`)",
    "`agent.renamed`",
    "| `job_exists` |",
    "Its messages to you that you have not answered or closed stay in the Inbox",
  ])
    expect(ref, part).toContain(part)
  expect(ref).not.toContain("closes its open asks and its\nopen Inbox items")
})

// 7: a "report" mark for messages to the owner.
test("the reference has reports: the mark, the Inbox's box, the setting, the command", () => {
  const ref = read("reference.md")
  for (const part of [
    "### Reports",
    "`report=true`",
    "[--report]`",
    "| `report_close_after` | server | `7d` |",
    "**Reports**",
  ])
    expect(ref, part).toContain(part)
})

// 1.1.0-rc2 (the owner, 2026-11-20: "add red-pink hilight at the top of
// inbox tab when it has messages for us").
test("the reference says what the Inbox tab's red-pink top edge means", () => {
  const ref = read("reference.md")
  expect(ref).toContain(
    "- **The tab's top edge is red-pink** while something waits for you",
  )
  expect(ref).toContain("Reports do not light it")
})

// 1.0.1 (the owner, 2026-11-19: "lets implement fix for stale host
// records"): a host's record goes by itself; the reference said that no
// command removes one.
test("the reference says how a host's record goes: the setting, the command, its errors", () => {
  const ref = read("reference.md")
  for (const part of [
    "| `host_expire_after` | server | `1d` |",
    "| `autocode hosts rm HOST` |",
    "`host.removed`",
    "| `host_online` |",
    "| `host_in_use` |",
    "| hosts | `host_expire_after` (1 day) after they were last heard from",
  ])
    expect(ref, part).toContain(part)
  // what it said before 1.0.1, in two places
  expect(ref).not.toContain("no command removes")
  expect(ref).not.toContain("row stays for good")
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
