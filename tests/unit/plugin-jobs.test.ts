/*
 * The plugin's tier 0f parts: a spawn instruction becomes a session in the
 * folder (title, model and variant, OpenCode agent); a remove instruction
 * removes it; autocode_me jobs, run and finish; the turn's last reply is
 * found in the session's messages.
 */
import { describe, expect, test } from "bun:test"
import { guideText, helpText, TOPICS } from "../../packages/plugin/src/guide.ts"
import { lastReply, spawnInput } from "../../packages/plugin/src/jobs.ts"
import { ME_TOOL, runMe } from "../../packages/plugin/src/tools.ts"

describe("spawn", () => {
  test("a session in this folder with the job's model, variant and agent", () => {
    expect(
      spawnInput("/work", {
        run: "mail:2026-10-28T12:00",
        title: "mail:2026-10-28T12:00",
        model: "openai/gpt-5.5",
        variant: "high",
        agent: "build",
      }),
    ).toEqual({
      title: "mail:2026-10-28T12:00",
      location: { directory: "/work" },
      model: { providerID: "openai", id: "gpt-5.5", variant: "high" },
      agent: "build",
    })
    expect(
      spawnInput("/work", { run: "x", title: "x", model: "fake/main" }),
    ).toEqual({
      title: "x",
      location: { directory: "/work" },
      model: { providerID: "fake", id: "main" },
    })
  })
})

describe("the last reply", () => {
  test("the newest assistant message's text", () => {
    const messages = [
      { type: "user", content: [{ type: "text", text: "go" }] },
      {
        type: "assistant",
        time: { created: 2 },
        content: [
          { type: "text", text: "first" },
          { type: "tool", name: "shell" },
          { type: "text", text: "and the end" },
        ],
      },
      {
        type: "assistant",
        time: { created: 1 },
        content: [{ type: "text", text: "older" }],
      },
    ]
    expect(lastReply(messages)).toBe("first\nand the end")
    expect(lastReply([])).toBeNull()
  })
})

describe("autocode_me jobs, run and finish", () => {
  const call = (answers: Record<string, unknown>, calls: any[] = []) =>
    (async (method: string, path: string, body?: unknown) => {
      calls.push([`${method} ${path}`, body])
      return answers[`${method} ${path}`] as any
    }) as any

  test("the actions are described", () => {
    const actions = (ME_TOOL.input.properties.action as any).enum
    for (const a of ["jobs", "run", "finish"]) expect(actions).toContain(a)
    expect(ME_TOOL.description).toContain("finish (result")
  })

  test("jobs lists them; run starts one; finish ends a run", async () => {
    const calls: any[] = []
    const c = call(
      {
        "GET /v1/jobs": {
          jobs: [{ name: "mail", description: "Summarizes mail" }],
        },
        "POST /v1/jobs/mail/run": { run: { id: "mail:2026-10-28T12:00" } },
        "POST /v1/me/finish": { finished: "mail:2026-10-28T12:00" },
      },
      calls,
    )
    expect(await runMe({ action: "jobs" }, c)).toBe(
      "Jobs you can run (autocode_me action=run job=NAME text=...):\n" +
        "mail: Summarizes mail",
    )
    expect(
      await runMe({ action: "run", job: "mail", text: "urgent" } as any, c),
    ).toBe(
      "Started run mail:2026-10-28T12:00; its result comes to you as a " +
        "message from autocode (result of run ...).",
    )
    expect(
      await runMe({ action: "finish", result: "five lines" } as any, c),
    ).toBe(
      "Finished run mail:2026-10-28T12:00; the result is on its way. " +
        "Your session ends now: stop here.",
    )
    expect(calls.map(([k, b]) => [k, b])).toEqual([
      ["GET /v1/jobs", undefined],
      ["POST /v1/jobs/mail/run", { text: "urgent" }],
      ["POST /v1/me/finish", { result: "five lines" }],
    ])
  })
})

describe("the guide's jobs part", () => {
  test("jobs, runs, finish, the result, one run at a time", () => {
    expect(TOPICS).toContain("jobs")
    const facts = {
      serverId: "s",
      url: "http://s:4848",
      shellValues: true,
      tools: [],
    }
    const part = helpText(facts, "jobs").replace(/\s+/g, " ")
    for (const answer of [
      "autocode_me action=jobs",
      "action=run job=",
      "`[autocode] result of run",
      "one run at a time",
      "autocode_me action=finish result=",
      "its last reply is the result",
      "time limit",
      "`run_usd`",
    ])
      expect(part, answer).toContain(answer)
    expect(guideText(facts)).toContain("## Jobs and Runs")
  })
})

// The adversarial review of 0f (2026-11-07).
describe("review of 0f: the last reply", () => {
  test("the newest message with text when the newest has none (a tool call)", () => {
    const messages = [
      {
        type: "assistant",
        time: { created: 1 },
        content: [{ type: "text", text: "the answer is 42" }],
      },
      {
        type: "assistant",
        time: { created: 2 },
        content: [{ type: "tool", name: "shell" }],
      },
    ]
    expect(lastReply(messages)).toBe("the answer is 42")
  })

  test("without times, the last in the list", () => {
    const messages = [
      { type: "assistant", content: [{ type: "text", text: "older" }] },
      { type: "assistant", content: [{ type: "text", text: "newer" }] },
    ]
    expect(lastReply(messages)).toBe("newer")
  })
})
