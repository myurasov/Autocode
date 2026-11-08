/*
 * The agents suite's own checks, apart from the run so that they can be
 * tested (tests/unit/agents-checks.test.ts): what an agent did with Autocode
 * that it should have done with a tool, and the owner's OpenCode config read
 * as JSONC (comments and trailing commas).
 */

// A tool call: the tool's name and its input.
export type Call = [string, any]

// Where the plugin's code lives (the scratch config's, or a user's).
const PLUGIN_PATH = /plugins\/autocode|opencode\/plugins/

/*
 * The `autocode` CLI at a command's start: a line's start, or after ; & | (
 * or $(, with an optional path before it (./bin/autocode).
 */
const CLI = /(?:^|[;&|(`]|\$\()\s*(?:[\w./~-]*\/)?autocode\s+([a-z-]+)/gm

/*
 * What the agent did that it should have done with a tool, or null: never
 * an autocode_* tool; the plugin's code read with any tool; the CLI (a
 * background job's `autocode fire` is allowed when asked for); Autocode's API
 * called with the session's token.
 */
export function misuseOf(calls: Call[], allowFire = false): string | null {
  if (!calls.some(([name]) => name.startsWith("autocode_")))
    return "never called an autocode_* tool"
  for (const [name, input] of calls) {
    if (name.startsWith("autocode_")) continue
    const text = JSON.stringify(input ?? {})
    if (PLUGIN_PATH.test(text))
      return `read the plugin's code: ${text.slice(0, 120)}`
    if (name !== "shell" && name !== "bash") continue
    const cmd = String(input?.command ?? "")
    for (const [, sub] of cmd.matchAll(CLI))
      if (!(allowFire && sub === "fire"))
        return `ran the CLI (autocode ${sub}) instead of a tool`
    if (/\$\{?AUTOCODE_(TOKEN|URL)\b/.test(cmd) && !/\bautocode\s/.test(cmd))
      return "called Autocode's API from a shell instead of a tool"
  }
  return null
}

/*
 * JSON with comments (// to the line's end, /* ... *\/) and trailing commas,
 * as OpenCode reads its config; strings are kept as they are.
 */
export function readJsonc(text: string): any {
  let out = ""
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      // a string, escapes and all
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end < 0 ? text.length : end + 2
    } else if (c === ",") {
      // a trailing comma: only space (comments gone) before } or ]
      let j = i + 1
      let rest = ""
      while (j < text.length) {
        if (/\s/.test(text[j]!)) j++
        else if (text[j] === "/" && text[j + 1] === "/")
          while (j < text.length && text[j] !== "\n") j++
        else if (text[j] === "/" && text[j + 1] === "*") {
          const end = text.indexOf("*/", j + 2)
          j = end < 0 ? text.length : end + 2
        } else {
          rest = text[j]!
          break
        }
      }
      if (rest !== "}" && rest !== "]") out += c
      i++
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(out)
}
