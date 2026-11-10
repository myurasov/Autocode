/*
 * Questions and permission prompts, between OpenCode and the server (tier
 * 0d): a pending form of the question tool or a permission request becomes
 * an `ask.opened` event; the server's `answer` instruction becomes OpenCode's
 * form reply or cancel, or permission reply. Only published interfaces: the
 * session's forms (through the local API: the plugin context has none) and
 * permissions (ctx.permission list, reply), and their events. A Subagent's
 * form or request is its top-level session's ask, answered in its own
 * session (`form_session`).
 */

// A list OpenCode answered, bare or as {data: [...]}.
export function listOf(reply: any): any[] {
  if (Array.isArray(reply)) return reply
  if (Array.isArray(reply?.data)) return reply.data
  return []
}

// What OpenCode's question tool puts into a form field (2.2.0): key q<i>,
// title the header, description the question, options {value, label,
// description}, type string or multiselect.
export function questionsOf(form: any): any[] | undefined {
  const meta = form?.metadata
  if (meta?.kind !== "question") return undefined
  const fields = Array.isArray(form?.fields) ? form.fields : []
  return fields.map((f: any) => ({
    key: String(f?.key ?? ""),
    header: String(f?.title ?? ""),
    question: String(f?.description ?? f?.title ?? ""),
    multiple: f?.type === "multiselect",
    options: (Array.isArray(f?.options) ? f.options : []).map((o: any) => ({
      label: String(o?.label ?? o?.value ?? ""),
      description: String(o?.description ?? ""),
    })),
  }))
}

// A form of the question tool, as the event the server takes (a settled one,
// with a state other than pending, is none).
export function formEvent(session: string, form: any) {
  if (form?.state !== undefined && form.state !== "pending") return undefined
  const questions = questionsOf(form)
  if (!questions?.length) return undefined
  return {
    type: "ask.opened",
    kind: "question",
    session,
    ...own(session, form?.sessionID),
    ref: String(form.id),
    title: String(form.title ?? "Questions"),
    questions,
  }
}

// The session a form or request is really in, when a Subagent's.
function own(session: string, actual: unknown) {
  return typeof actual === "string" && actual && actual !== session
    ? { form_session: actual }
    : {}
}

// A permission request, as the event the server takes.
export function permissionEvent(session: string, request: any) {
  if (typeof request?.id !== "string") return undefined
  return {
    type: "ask.opened",
    kind: "permission",
    session,
    ...own(session, request.sessionID),
    ref: request.id,
    title: String(request.action ?? ""),
    action: String(request.action ?? ""),
    resources: Array.isArray(request.resources)
      ? request.resources.map(String)
      : [],
    ...(request.message ? { message: String(request.message) } : {}),
  }
}

export interface AnswerDeps {
  formReply: (input: {
    sessionID: string
    formID: string
    answer: Record<string, string | string[]>
  }) => Promise<unknown>
  formCancel: (input: {
    sessionID: string
    formID: string
    message?: string
  }) => Promise<unknown>
  permissionReply: (input: {
    sessionID: string
    requestID: string
    decision: "once" | "always" | "reject"
    message?: string
  }) => Promise<unknown>
}

// Carries out the server's answer.
export async function carryOut(payload: any, deps: AnswerDeps) {
  // the session the form or request is in (a Subagent's), else the agent's
  const sessionID = String(payload?.form_session ?? payload?.session ?? "")
  const ref = String(payload?.ref ?? "")
  if (!sessionID || !ref) throw new Error("an answer needs a session and ref")
  if (payload.kind === "question") {
    if (typeof payload.cancel === "string")
      await deps.formCancel({
        sessionID,
        formID: ref,
        message: payload.cancel,
      })
    else
      await deps.formReply({
        sessionID,
        formID: ref,
        answer: payload.answer ?? {},
      })
    return { answered: "question" }
  }
  if (payload.kind === "permission") {
    const decision = payload.decision
    if (!["once", "always", "reject"].includes(decision))
      throw new Error(`bad decision ${decision}`)
    await deps.permissionReply({
      sessionID,
      requestID: ref,
      decision,
      ...(payload.message ? { message: String(payload.message) } : {}),
    })
    return { answered: "permission" }
  }
  throw new Error(`unknown kind ${payload.kind}`)
}
