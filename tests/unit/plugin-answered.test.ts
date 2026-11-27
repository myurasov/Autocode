/*
 * The model that answered a claude-agent session (1.1.0-rc7): OpenCode
 * records the model asked for; the harness's own transcript says which
 * model answered. The plugin finds the transcript by the harness's session
 * that OpenCode's last assistant message names, and reads the answer's
 * line from the file's end. Fixtures stand for the harness's files.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  answeredBy,
  answeredIn,
  harnessHome,
  nativeOf,
  tailOf,
  transcriptOf,
} from "../../plugin/src/answered.ts"

const SESSION = "29721054-a533-40cb-af6a-bad287b4b2fd"
const OTHER = "fb82d245-08ab-4de5-8616-bd98a517b07e"
const MSG = "333bc989-c108-41d5-a6f3-bd24742fbb4c"

// A line of the harness's transcript, as it writes an answer.
const answer = (
  uuid: string,
  model: string,
  more: Record<string, unknown> = {},
) =>
  JSON.stringify({
    type: "assistant",
    uuid,
    isSidechain: false,
    requestedModel: "claude-fable-5-2",
    sessionId: SESSION,
    message: { id: "msg_01", role: "assistant", model, content: [] },
    ...more,
  })
const user = JSON.stringify({ type: "user", uuid: "u-1", message: {} })

let home: string
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "autocode-answered-"))
  mkdirSync(join(home, "projects", "-home-someone-work"), { recursive: true })
  mkdirSync(join(home, "projects", "-home-someone-other"), { recursive: true })
  writeFileSync(
    join(home, "projects", "-home-someone-work", `${SESSION}.jsonl`),
    `${[
      user,
      answer("a-1", "claude-fable-5-2"),
      answer(MSG, "claude-opus-4-8"),
      user,
    ].join("\n")}\n`,
  )
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe("the harness's session behind an OpenCode message", () => {
  test("the last content block that names it", () => {
    expect(
      nativeOf({
        type: "assistant",
        content: [
          { type: "reasoning", native: { sessionID: OTHER, messageID: "m-0" } },
          { type: "text", text: "x" },
          { type: "tool", native: { sessionID: SESSION, messageID: MSG } },
        ],
      }),
    ).toEqual({ session: SESSION, message: MSG })
    for (const none of [
      undefined,
      null,
      {},
      { content: "x" },
      { content: [{ type: "text" }, { native: { sessionID: 3 } }] },
    ])
      expect(nativeOf(none)).toBeUndefined()
  })
})

describe("which model answered, from a transcript's text", () => {
  test("the line of that message; else the last answer of the main thread", () => {
    const text = [
      answer("a-1", "claude-fable-5-2"),
      answer(MSG, "claude-opus-4-8"),
      answer("a-3", "claude-fable-5-2"),
      // a Subagent's thread in the same file, and the harness's own
      // made-up answers, are not the session's
      answer("a-4", "claude-haiku-5-5", { isSidechain: true }),
      answer("a-5", "<synthetic>"),
      user,
    ].join("\n")
    expect(answeredIn(text, MSG)).toEqual({
      model: "claude-opus-4-8",
      requested: "claude-fable-5-2",
    })
    expect(answeredIn(text, "not-there")).toEqual({
      model: "claude-fable-5-2",
      requested: "claude-fable-5-2",
    })
    expect(answeredIn(text)).toEqual({
      model: "claude-fable-5-2",
      requested: "claude-fable-5-2",
    })
  })

  test("an older transcript says no requested model; what is no transcript says nothing", () => {
    const old = answer("a-1", "claude-opus-5-5", { requestedModel: undefined })
    expect(answeredIn(old)).toEqual({ model: "claude-opus-5-5" })
    // a line cut at the start of what was read, and other junk
    expect(answeredIn(`${old.slice(40)}\n{"type":"assistant"}\nnot json`)).toBe(
      undefined,
    )
    expect(answeredIn("")).toBeUndefined()
    // a model's name that is none is passed over
    expect(answeredIn(answer("a-1", "x".repeat(300)))).toBeUndefined()
  })
})

describe("the transcript's file", () => {
  test("found by the harness's session under any project folder; never by a name that is no such ID", () => {
    expect(transcriptOf(home, SESSION)).toBe(
      join(home, "projects", "-home-someone-work", `${SESSION}.jsonl`),
    )
    expect(transcriptOf(home, OTHER)).toBeUndefined()
    for (const bad of ["", "..", "../x", `${SESSION}/../x`, "a b", "*"])
      expect(transcriptOf(home, bad)).toBeUndefined()
    expect(transcriptOf(join(home, "nope"), SESSION)).toBeUndefined()
  })

  test("only the end of a long file is read", () => {
    const path = join(home, "long.jsonl")
    writeFileSync(path, `${"x".repeat(5000)}\n${answer("z", "claude-m")}\n`)
    const tail = tailOf(path, 1000) as string
    expect(tail.length).toBeLessThanOrEqual(1000)
    expect(answeredIn(tail)).toEqual({
      model: "claude-m",
      requested: "claude-fable-5-2",
    })
    expect(tailOf(join(home, "nope.jsonl"))).toBeUndefined()
  })

  test("the harness's folder: CLAUDE_CONFIG_DIR, else .claude in the home", () => {
    expect(harnessHome({ CLAUDE_CONFIG_DIR: "/x/y" })).toBe("/x/y")
    expect(harnessHome({})).toMatch(/\.claude$/)
  })
})

describe("from OpenCode's last message to the answering model", () => {
  const messages = (native: unknown) => async (path: string) => {
    expect(path).toBe(
      "/api/session/ses_a/message?type=assistant&limit=1&order=desc",
    )
    return { data: [{ type: "assistant", content: [{ native }] }] }
  }

  test("the answer's model and the one asked for", async () => {
    expect(
      await answeredBy(
        messages({ sessionID: SESSION, messageID: MSG }),
        "ses_a",
        home,
      ),
    ).toEqual({ model: "claude-opus-4-8", requested: "claude-fable-5-2" })
  })

  test("nothing when anything is missing", async () => {
    expect(
      await answeredBy(
        messages({ sessionID: OTHER, messageID: MSG }),
        "ses_a",
        home,
      ),
    ).toBeUndefined()
    expect(await answeredBy(messages(undefined), "ses_a", home)).toBe(undefined)
    expect(
      await answeredBy(async () => ({ data: [] }), "ses_a", home),
    ).toBeUndefined()
    // OpenCode's API cannot be read: said to the caller, who logs it
    expect(
      answeredBy(
        async () => {
          throw new Error("down")
        },
        "ses_a",
        home,
      ),
    ).rejects.toThrow("down")
  })
})
