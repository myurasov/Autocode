/*
 * The plugin's ask parts (tier 0d): a form of OpenCode's question tool and a
 * permission request become the events the server takes; the server's
 * answer becomes a form reply or cancel, or a permission reply; agents
 * answer and escalate asks sent to them, and ask for approvals.
 */
import { describe, expect, test } from "bun:test"
import {
  carryOut,
  formEvent,
  listOf,
  permissionEvent,
} from "../../packages/plugin/src/asks.ts"
import { guideText, helpText, TOPICS } from "../../packages/plugin/src/guide.ts"
import {
  APPROVAL_TOOL,
  MESSAGE_TOOL,
  runApproval,
  runMessage,
  TOOLS,
} from "../../packages/plugin/src/tools.ts"

// A form as the question tool of OpenCode 2.2.0 makes it.
const FORM = {
  id: "frm_1",
  sessionID: "ses_a",
  title: "Questions",
  metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } },
  fields: [
    {
      key: "q0",
      title: "Which fold?",
      description: "Which fold split should I use?",
      type: "string",
      options: [
        { value: "v3", label: "v3", description: "folds v3" },
        { value: "v2", label: "v2", description: "the old ones" },
      ],
      custom: true,
    },
    {
      key: "q1",
      title: "Metrics",
      description: "Which metrics?",
      type: "multiselect",
      options: [{ value: "auc", label: "auc" }],
      custom: true,
    },
  ],
}

describe("events", () => {
  test("a question form: its questions, options and multiple choice", () => {
    expect(formEvent("ses_a", FORM)).toEqual({
      type: "ask.opened",
      kind: "question",
      session: "ses_a",
      ref: "frm_1",
      title: "Questions",
      questions: [
        {
          key: "q0",
          header: "Which fold?",
          question: "Which fold split should I use?",
          multiple: false,
          options: [
            { label: "v3", description: "folds v3" },
            { label: "v2", description: "the old ones" },
          ],
        },
        {
          key: "q1",
          header: "Metrics",
          question: "Which metrics?",
          multiple: true,
          options: [{ label: "auc", description: "" }],
        },
      ],
    })
  })

  test("a form that is not the question tool's is left alone", () => {
    expect(
      formEvent("ses_a", { ...FORM, metadata: { kind: "oauth" } }),
    ).toBeUndefined()
    expect(formEvent("ses_a", { ...FORM, metadata: undefined })).toBeUndefined()
  })

  test("a permission request", () => {
    expect(
      permissionEvent("ses_a", {
        id: "per_1",
        sessionID: "ses_a",
        action: "shell",
        resources: ["rm -rf build"],
        save: ["rm *"],
        message: "clean up",
      }),
    ).toEqual({
      type: "ask.opened",
      kind: "permission",
      session: "ses_a",
      ref: "per_1",
      title: "shell",
      action: "shell",
      resources: ["rm -rf build"],
      message: "clean up",
    })
  })
})

describe("carrying out an answer", () => {
  const calls: any[] = []
  const deps = {
    formReply: async (i: any) => calls.push(["reply", i]),
    formCancel: async (i: any) => calls.push(["cancel", i]),
    permissionReply: async (i: any) => calls.push(["permission", i]),
  }

  test("a question's answer, its dismissal, a permission's decision", async () => {
    calls.length = 0
    await carryOut(
      {
        session: "ses_a",
        kind: "question",
        ref: "frm_1",
        answer: { q0: "v3" },
      },
      deps,
    )
    await carryOut(
      { session: "ses_a", kind: "question", ref: "frm_2", cancel: "Go on." },
      deps,
    )
    await carryOut(
      {
        session: "ses_a",
        kind: "permission",
        ref: "per_1",
        decision: "reject",
        message: "no",
      },
      deps,
    )
    expect(calls).toEqual([
      ["reply", { sessionID: "ses_a", formID: "frm_1", answer: { q0: "v3" } }],
      ["cancel", { sessionID: "ses_a", formID: "frm_2", message: "Go on." }],
      [
        "permission",
        {
          sessionID: "ses_a",
          requestID: "per_1",
          decision: "reject",
          message: "no",
        },
      ],
    ])
  })

  test("a bad decision or kind is refused", async () => {
    await expect(
      carryOut(
        { session: "s", kind: "permission", ref: "p", decision: "maybe" },
        deps,
      ),
    ).rejects.toThrow(/bad decision/)
    await expect(
      carryOut({ session: "s", kind: "other", ref: "p" }, deps),
    ).rejects.toThrow(/unknown kind/)
  })
})

// The agents' side (tier 0d): answer and escalate in autocode_message, and
// autocode_approval ask and wait.

const ME = {
  registered: true,
  agent: { id: "team:lead", status: "idle" },
  server: {
    id: "api-test",
    time: "2026-10-28T12:00:00.000Z",
    timezone: "America/Los_Angeles",
  },
  settings: { max_tool_wait: "5m" },
}

function fake(answers: Record<string, unknown>) {
  const calls: { key: string; body: any }[] = []
  const call = async (method: string, path: string, body?: unknown) => {
    const key = `${method} ${path.split("?")[0]}`
    calls.push({ key: `${method} ${path}`, body })
    if (!(key in answers)) throw new Error(`unexpected ${key}`)
    const a = answers[key]
    return (typeof a === "function" ? a(body, path) : a) as any
  }
  return { call, calls }
}

describe("autocode_message answer and escalate", () => {
  test("the description names them; answer sends the text; escalate the reason", async () => {
    const actions = (MESSAGE_TOOL.input.properties.action as any).enum
    expect(actions).toEqual(["send", "answer", "escalate"])
    expect(MESSAGE_TOOL.description).toContain("answer (id, text")
    expect(MESSAGE_TOOL.description).toContain("escalate (id, text")
    const { call, calls } = fake({
      "POST /v1/asks/ask_1/answer": { ask: { id: "ask_1", kind: "question" } },
      "POST /v1/asks/ask_1/escalate": { ask: { id: "ask_1" } },
    })
    expect(
      await runMessage({ action: "answer", id: "ask_1", text: "v3" }, call),
    ).toBe(
      "Answered ask_1 (question); the asking agent's turn goes on with it.",
    )
    expect(
      await runMessage(
        { action: "escalate", id: "ask_1", text: "I do not know" },
        call,
      ),
    ).toBe("Handed ask_1 to the owner, with your reason.")
    expect(calls.map((c) => [c.key, c.body])).toEqual([
      ["POST /v1/asks/ask_1/answer", { text: "v3" }],
      ["POST /v1/asks/ask_1/escalate", { text: "I do not know" }],
    ])
    expect(await runMessage({ action: "answer", id: "ask_1" }, call)).toBe(
      "error: answer needs the ask's id and your text",
    )
  })
})

describe("autocode_approval", () => {
  test("is a tool with ask and wait only", () => {
    expect(TOOLS).toContain(APPROVAL_TOOL)
    expect((APPROVAL_TOOL.input.properties.action as any).enum).toEqual([
      "ask",
      "wait",
    ])
    for (const word of ["ask", "wait", "options", "expires", "notice"])
      expect(APPROVAL_TOOL.description, word).toContain(word)
  })

  test("ask: who decides, and how the answer comes", async () => {
    const { call, calls } = fake({
      "GET /v1/me": ME,
      "POST /v1/me/approvals": {
        approval: {
          id: "ask_9",
          state: "open",
          routed: "owner",
          expires: "2026-10-28T13:00:00.000Z",
        },
      },
    })
    expect(
      await runApproval(
        {
          action: "ask",
          text: "Deploy v2?",
          options: "now, tonight",
          expires: "1h",
        },
        call,
      ),
    ).toBe(
      "Approval ask_9 is with the owner. The answer comes as a notice " +
        '([autocode] approval "…" approved or rejected); until then your ' +
        "wakes and messages wait. It expires at 2026-10-28 06:00 PDT (in " +
        "1h): then it counts as rejected. To wait for it now: " +
        "autocode_approval action=wait id=ask_9.",
    )
    expect(calls[0]?.body).toEqual({
      text: "Deploy v2?",
      options: ["now", "tonight"],
      expires: "1h",
    })
  })

  test("ask approved at once (approve mode), and wait's outcomes", async () => {
    const { call } = fake({
      "GET /v1/me": ME,
      "POST /v1/me/approvals": {
        approval: { id: "ask_2", state: "approved", by: "auto" },
      },
      "GET /v1/me/approvals/ask_3": (_b: unknown, path: string) => ({
        approval: path.includes("wait=")
          ? { id: "ask_3", state: "approved", option: "tonight", by: "owner" }
          : { id: "ask_3", state: "open" },
      }),
    })
    expect(await runApproval({ action: "ask", text: "Go?" }, call)).toBe(
      "Approval ask_2 is approved (by the setting approval_mode=approve).",
    )
    expect(
      await runApproval({ action: "wait", id: "ask_3", seconds: 30 }, call),
    ).toBe("Approval ask_3: approved by the owner. Option: tonight.")
  })
})

describe("the guide's asks part", () => {
  test("questions, permissions, approvals, answering for another agent, escalating", () => {
    expect(TOPICS).toContain("asks")
    const facts = {
      serverId: "api-test",
      url: "http://server:4848",
      shellValues: true,
      tools: TOOLS,
    }
    const part = helpText(facts, "asks").replace(/\s+/g, " ")
    for (const answer of [
      "the question tool",
      "`question_mode`",
      "`permission_mode`",
      "`approval_mode`",
      "your wakes and messages wait",
      "autocode_approval action=ask",
      "action=wait",
      "counts as rejected",
      '`[autocode] approval "…" approved`',
      "autocode_message action=answer id=",
      "`once` or `reject`",
      "action=escalate",
      "the first answer counts",
      "A question written as plain text",
    ])
      expect(part, answer).toContain(answer)
    expect(guideText(facts)).toContain(
      "## Questions, Permissions and Approvals",
    )
  })
})

// The adversarial review of 0d (2026-11-07).
describe("review of 0d", () => {
  test("a Subagent's form carries its own session; a settled one is none", () => {
    expect(
      formEvent("ses_a", { ...FORM, sessionID: "ses_child" }),
    ).toMatchObject({
      session: "ses_a",
      form_session: "ses_child",
    })
    expect(formEvent("ses_a", FORM)).not.toHaveProperty("form_session")
    expect(formEvent("ses_a", { ...FORM, state: "replied" })).toBeUndefined()
    expect(formEvent("ses_a", { ...FORM, state: "pending" })).toBeDefined()
  })

  test("a Subagent's permission carries its own session", () => {
    expect(
      permissionEvent("ses_a", {
        id: "per_9",
        sessionID: "ses_child",
        action: "shell",
        resources: [],
      }),
    ).toMatchObject({ session: "ses_a", form_session: "ses_child" })
  })

  test("an answer goes to the session the form is in", async () => {
    const calls: any[] = []
    const deps = {
      formReply: async (i: any) => calls.push(["reply", i]),
      formCancel: async (i: any) => calls.push(["cancel", i]),
      permissionReply: async (i: any) => calls.push(["permission", i]),
    }
    await carryOut(
      {
        session: "ses_a",
        form_session: "ses_child",
        kind: "question",
        ref: "frm_1",
        answer: { q0: "v3" },
      },
      deps,
    )
    await carryOut(
      {
        session: "ses_a",
        form_session: "ses_child",
        kind: "permission",
        ref: "per_1",
        decision: "once",
      },
      deps,
    )
    expect(calls.map(([, i]) => i.sessionID)).toEqual([
      "ses_child",
      "ses_child",
    ])
  })

  test("a list's {data} is unwrapped", () => {
    expect(listOf({ data: [1, 2] })).toEqual([1, 2])
    expect(listOf([3])).toEqual([3])
    expect(listOf(undefined)).toEqual([])
  })

  test("the answer text for approvals and permissions says what happens", async () => {
    const { call } = fake({
      "POST /v1/asks/ask_1/answer": {
        ask: { id: "ask_1", kind: "approval" },
      },
    })
    expect(
      await runMessage(
        { action: "answer", id: "ask_1", text: "approve" },
        call,
      ),
    ).toBe("Answered ask_1 (approval); the asking agent is told.")
  })
})
