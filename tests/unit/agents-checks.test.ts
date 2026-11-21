/*
 * The agents suite's own checks (ci/agents/checks.ts; the adversarial review
 * of 0b2, 2026-11-08): what counts as using Autocode outside its tools (the
 * CLI, its API with the session's token, the plugin's code read with any
 * tool), and reading the owner's OpenCode config (JSONC). And two that a
 * full run on OpenCode 2.3 showed (2026-11-17): what ends a fired wake in
 * the job scenario, and that scenarios which run at once do not make jobs
 * that read alike.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  afterFire,
  fireOnlyWake,
  misuseOf,
  readJsonc,
} from "../../ci/agents/checks.ts"

const shell = (command: string): [string, any] => ["shell", { command }]
const tool: [string, any] = ["autocode_wake", { action: "list" }]
const AUTH = "Authorization: Bearer $AUTOCODE_TOKEN"

describe("misuseOf", () => {
  test("tools only, and words about autocode in text: no misuse", () => {
    expect(misuseOf([tool])).toBeNull()
    expect(misuseOf([tool, shell('echo "use autocode tools"')])).toBeNull()
    expect(misuseOf([tool, shell("grep -r autocode notes.md")])).toBeNull()
  })

  test("no autocode_* tool at all", () => {
    expect(misuseOf([shell("ls")])).toBe("never called an autocode_* tool")
  })

  test("the CLI at a command's start; fire only when allowed", () => {
    expect(misuseOf([tool, shell("autocode wakes")])).toBe(
      "ran the CLI (autocode wakes) instead of a tool",
    )
    expect(misuseOf([tool, shell("cd x && autocode me")])).toBe(
      "ran the CLI (autocode me) instead of a tool",
    )
    expect(misuseOf([tool, shell("echo $(autocode me)")])).toBe(
      "ran the CLI (autocode me) instead of a tool",
    )
    const job = shell("(sleep 20; echo done > j.txt; autocode fire me j) &")
    expect(misuseOf([tool, job], true)).toBeNull()
    expect(misuseOf([tool, job])).toBe(
      "ran the CLI (autocode fire) instead of a tool",
    )
  })

  test("Autocode's API with the session's token", () => {
    expect(
      misuseOf([tool, shell(`curl -H "${AUTH}" $AUTOCODE_URL/v1/me/wakes`)]),
    ).toBe("called Autocode's API from a shell instead of a tool")
  })

  /*
   * A full run on OpenCode 2.3 (2026-11-17): before starting its background
   * job, a model asked whether its shell has the values and the command
   * (`test -n "$AUTOCODE_TOKEN" && command -v autocode`), as the guide's
   * "when the machine has it" suggests. That calls nothing.
   */
  test("asking whether a shell value is set is not a call", () => {
    // a value in braces, with what follows its name: ${AUTOCODE_URL:-none}
    const braced = (name: string, rest = "") => `$\{AUTOCODE_${name}${rest}}`
    for (const cmd of [
      'test -n "$AUTOCODE_TOKEN" && command -v autocode',
      '[ -z "$AUTOCODE_URL" ] || echo set',
      `[[ -n ${braced("TOKEN")} ]] && echo yes`,
      `echo ${braced("TOKEN", ":+set")} ${braced("URL", ":-none")}`,
    ])
      expect(misuseOf([tool, shell(cmd)]), cmd).toBeNull()
    // asking first does not excuse the call after it
    expect(
      misuseOf([
        tool,
        shell(
          `test -n "$AUTOCODE_TOKEN" && curl -H "${AUTH}" $AUTOCODE_URL/v1`,
        ),
      ]),
    ).toBe("called Autocode's API from a shell instead of a tool")
  })

  test("the plugin's code, read with any tool", () => {
    for (const [name, input] of [
      ["read", { path: "/x/config/plugins/autocode/index.js" }],
      ["grep", { pattern: "idle", path: "/x/opencode/plugins/" }],
      ["shell", { command: "cat ~/.config/opencode/plugins/autocode/x.js" }],
    ] as [string, any][])
      expect(misuseOf([tool, [name, input]]), name).toMatch(
        /^read the plugin's code/,
      )
  })
})

describe("readJsonc", () => {
  test("comments of both kinds, at a line's end too, and trailing commas", () => {
    const text = `{
      // a whole-line comment
      "provider": { "p": { "url": "https://x.example/v1" } }, // trailing
      /* a block
         comment */
      "list": [1, 2,],
      "text": "keeps // and /* inside strings */ and ,} too",
    }`
    expect(readJsonc(text)).toEqual({
      provider: { p: { url: "https://x.example/v1" } },
      list: [1, 2],
      text: "keeps // and /* inside strings */ and ,} too",
    })
  })
})

describe("afterFire", () => {
  const fired = Date.parse("2026-11-18T01:16:00Z")
  const at = (s: number) => new Date(fired + s * 1000).toISOString()
  const cancel = (s: number, name = "job-done", by = "ci:m:job") => ({
    at: at(s),
    data: { name, by },
  })

  test("Autocode's prompt after the fire", () => {
    expect(
      afterFire(fired, "job-done", "ci:m:job", [{ at: at(2) }], []),
    ).toEqual({ at: at(2), by: "prompt" })
    // one sent before the fire (the setup's own) does not count
    expect(
      afterFire(fired, "job-done", "ci:m:job", [{ at: at(-30) }], []),
    ).toBeNull()
  })

  test("the agent's own cancel after the fire stands for the prompt", () => {
    // OpenCode's notice for the background shell woke the session first; the
    // agent did the wake's work in that turn and cancelled the wake
    expect(afterFire(fired, "job-done", "ci:m:job", [], [cancel(40)])).toEqual({
      at: at(40),
      by: "cancel",
    })
    // the prompt wins when both are there
    expect(
      afterFire(fired, "job-done", "ci:m:job", [{ at: at(5) }], [cancel(40)]),
    ).toEqual({ at: at(5), by: "prompt" })
  })

  test("not a cancel before the fire, of another wake, or by another", () => {
    expect(
      afterFire(fired, "job-done", "ci:m:job", [], [cancel(-5)]),
    ).toBeNull()
    expect(
      afterFire(fired, "job-done", "ci:m:job", [], [cancel(40, "other")]),
    ).toBeNull()
    expect(
      afterFire(
        fired,
        "job-done",
        "ci:m:job",
        [],
        [cancel(40, "job-done", "owner")],
      ),
    ).toBeNull()
  })
})

/*
 * 1.1.0: the guide's recipe for a job is a `fire-only once` wake, which is
 * gone once the job fired it: the job scenario reads the wake from History
 * (wake.set), not from the wakes that are left.
 */
describe("fireOnlyWake", () => {
  const set = (name: string, trigger: string, at = "2026-11-20T10:00:00Z") => ({
    at,
    data: { name, trigger },
  })
  test("the wake the agent set as fire-only, once or not; the newest", () => {
    expect(fireOnlyWake([set("done", "fire-only once")])).toBe("done")
    expect(fireOnlyWake([set("done", "fire-only")])).toBe("done")
    expect(
      fireOnlyWake([
        set("b", "fire-only once", "2026-11-20T10:00:05Z"),
        set("a", "fire-only", "2026-11-20T10:00:01Z"),
      ]),
    ).toBe("b")
  })
  test("no other trigger", () => {
    expect(
      fireOnlyWake([set("poll", "every 1m"), set("soon", "at 2026-11-20")]),
    ).toBeNull()
    expect(fireOnlyWake([])).toBeNull()
  })
})

describe("the scenarios' jobs", () => {
  /*
   * Every model's scenarios run on one server at once, and autocode_me jobs
   * lists every job: a model asked to "find the job that counts the lines
   * of data.csv" (run) took another model's proposed job, which read the
   * same.
   */
  test("the proposed job counts another file than the owner's job", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../ci/agents/run.ts"),
      "utf8",
    )
    const body = (name: string) => {
      const from = src.indexOf(`\n  async ${name}(ctx) {`)
      expect(from, name).toBeGreaterThan(0)
      const to = src.indexOf("\n  },\n", from)
      return src.slice(from, to > 0 ? to : undefined)
    }
    expect(body("run")).toContain("data.csv")
    expect(body("propose")).not.toContain("data.csv")
    expect(body("propose")).toContain("items.txt")
  })
})
