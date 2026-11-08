/*
 * The agents suite's own checks (ci/agents/checks.ts; the adversarial review
 * of 0b2, 2026-11-08): what counts as using Autocode outside its tools (the
 * CLI, its API with the session's token, the plugin's code read with any
 * tool), and reading the owner's OpenCode config (JSONC).
 */
import { describe, expect, test } from "bun:test"
import { misuseOf, readJsonc } from "../../ci/agents/checks.ts"

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
