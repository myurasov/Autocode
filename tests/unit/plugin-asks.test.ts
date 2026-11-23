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
} from "../../plugin/src/asks.ts"
import { guideText, helpText, TOPICS } from "../../plugin/src/guide.ts"
import {
  APPROVAL_TOOL,
  ME_TOOL,
  MESSAGE_TOOL,
  runApproval,
  runMe,
  runMessage,
  TOOLS,
} from "../../plugin/src/tools.ts"

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
    expect(actions).toEqual([
      "send",
      "list",
      "read",
      "wait",
      "answer",
      "escalate",
      "close",
    ])
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

/*
 * 1.1.0-rc4 (the owner, 2026-11-22: "i want autocode agents to be able to
 * close messages/questions/etc in inbox when they become irrelevant (eg
 * when i answered in prompt or things changed/etc)").
 */
describe("closing what the agent put into the owner's Inbox", () => {
  test("both tools name it, and say what closes and why", () => {
    expect(MESSAGE_TOOL.description).toContain(
      "close (id, text: close what you put in the owner's Inbox once it " +
        "no longer matters, as when the owner answered in the session: a " +
        "message or report you sent, or an approval you asked for; text: " +
        "why, required)",
    )
    expect(APPROVAL_TOOL.description).toContain(
      "close (id; text: why, required: take back one that no longer " +
        "matters, as when the owner answered in the session; closed is " +
        "not approved)",
    )
    expect(ME_TOOL.description).toContain(
      "what you have open in the owner's Inbox",
    )
    expect((MESSAGE_TOOL.input.properties.id as any).description).toContain(
      "close: the ID of a message you sent to the owner, or of an " +
        "approval you asked for",
    )
    expect((MESSAGE_TOOL.input.properties.text as any).description).toContain(
      "close: why it no longer matters",
    )
    expect((APPROVAL_TOOL.input.properties.id as any).description).toBe(
      "wait, close: the approval's ID",
    )
  })

  test("a message, a report and an approval, from either tool; the answer says what closed", async () => {
    const { call, calls } = fake({
      "POST /v1/me/inbox/close": (body: any) => ({
        item:
          body.id === "ask_4"
            ? { id: "ask_4", kind: "approval", state: "gone" }
            : body.id === "ask_5"
              ? {
                  id: "ask_5",
                  kind: "approval",
                  state: "gone",
                  job: "team:lead:digest",
                }
              : body.id === "m_2"
                ? {
                    id: "ib_2",
                    kind: "message",
                    message_id: "m_2",
                    report: true,
                  }
                : { id: "ib_1", kind: "message", message_id: "m_1" },
      }),
    })
    expect(
      await runMessage(
        { action: "close", id: "m_1", text: "answered in the session" },
        call,
      ),
    ).toBe("Closed your message m_1 in the owner's Inbox.")
    expect(
      await runMessage(
        { action: "close", id: "m_2", text: "a newer one replaces it" },
        call,
      ),
    ).toBe("Closed your report m_2 in the owner's Inbox.")
    const approval =
      "Closed approval ask_4: you no longer wait for it, and your wakes " +
      "and messages come again. Closed is not approved: act only on what " +
      "the owner told you."
    expect(
      await runApproval(
        { action: "close", id: "ask_4", text: "the plan changed" },
        call,
      ),
    ).toBe(approval)
    expect(
      await runMessage({ action: "close", id: "ask_4", text: "again" }, call),
    ).toBe(approval)
    // a job it asked to set never made it wait
    expect(
      await runApproval(
        { action: "close", id: "ask_5", text: "not needed" },
        call,
      ),
    ).toBe(
      "Closed approval ask_5: the job team:lead:digest is not set. Closed " +
        "is not approved.",
    )
    expect(calls.map((c) => [c.key, c.body])).toEqual([
      [
        "POST /v1/me/inbox/close",
        { id: "m_1", text: "answered in the session" },
      ],
      [
        "POST /v1/me/inbox/close",
        { id: "m_2", text: "a newer one replaces it" },
      ],
      ["POST /v1/me/inbox/close", { id: "ask_4", text: "the plan changed" }],
      ["POST /v1/me/inbox/close", { id: "ask_4", text: "again" }],
      ["POST /v1/me/inbox/close", { id: "ask_5", text: "not needed" }],
    ])
    for (const out of [
      await runMessage({ action: "close", text: "why" }, call),
      await runApproval({ action: "close", text: "why" }, call),
    ])
      expect(out).toBe(
        "error: close needs the id of a message you sent to the owner, or " +
          "of an approval you asked for",
      )
    // no call without a reason: the owner reads it in History
    for (const out of [
      await runMessage({ action: "close", id: "m_1" }, call),
      await runApproval({ action: "close", id: "ask_4", text: "  " }, call),
    ])
      expect(out).toBe(
        "error: close needs text: why it no longer matters, in a line",
      )
    expect(calls.length).toBe(5)
  })

  test("an approval the agent closed itself reads as closed by you", async () => {
    const { call } = fake({
      "GET /v1/me/approvals/ask_4": {
        approval: {
          id: "ask_4",
          agent: "team:lead",
          state: "gone",
          by: "team:lead",
        },
      },
    })
    expect(
      await runApproval({ action: "wait", id: "ask_4", seconds: 1 }, call),
    ).toBe("Approval ask_4: closed by you.")
  })

  test("status lists what the agent has open there, and how to close it", async () => {
    const item = (n: number, more: Record<string, unknown> = {}) => ({
      id: `m_${n}`,
      kind: "message",
      title: "Message from team:lead",
      created_at: `2026-10-28T1${n}:00:00.000Z`,
      ...more,
    })
    const { call } = fake({
      "GET /v1/me": {
        ...ME,
        asks: [
          {
            id: "ask_7",
            kind: "approval",
            title: "Approval for team:lead: Go?",
          },
        ],
        inbox: [
          item(0, {
            title: `Message from team:lead: "the folds ${"x".repeat(80)}"`,
          }),
          item(1, { kind: "report", title: "Report from team:lead" }),
          item(2),
          item(3),
          item(4),
          item(5),
          item(6),
        ],
      },
    })
    const lines = (await runMe({ action: "status" }, call)).split("\n")
    expect(lines).toContain(
      "Waiting on: approval ask_7 (Approval for team:lead: Go?). Your " +
        "wakes and messages wait until they close. An approval that no " +
        "longer matters: autocode_approval action=close id=ID.",
    )
    expect(lines).toContain(
      // a long subject is cut, so that the line stays one to read
      `Open in the owner's Inbox: message m_0 "the folds ${"x".repeat(49)}…" (sent ` +
        "2026-10-28 03:00 PDT); report m_1 (sent 2026-10-28 04:00 PDT); " +
        "message m_2 (sent 2026-10-28 05:00 PDT); message m_3 (sent " +
        "2026-10-28 06:00 PDT); message m_4 (sent 2026-10-28 07:00 PDT); " +
        "and 2 more. One that no longer matters (the owner answered in the " +
        "session, things changed): autocode_message action=close id=ID.",
    )
    // nothing open: no line
    const none = fake({ "GET /v1/me": { ...ME, asks: [], inbox: [] } })
    const quiet = await runMe({ action: "status" }, none.call)
    expect(quiet).not.toContain("Inbox")
    expect(quiet).not.toContain("Waiting on")
  })
})

describe("autocode_approval", () => {
  test("is a tool with ask, wait and close", () => {
    expect(TOOLS).toContain(APPROVAL_TOOL)
    expect((APPROVAL_TOOL.input.properties.action as any).enum).toEqual([
      "ask",
      "wait",
      "close",
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

  test("ask approved at once (approval_mode allow), and wait's outcomes", async () => {
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
      "Approval ask_2 is approved (by the setting approval_mode=allow).",
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
