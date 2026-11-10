/*
 * Questions, permission prompts and approvals: "asks" (spec, Questions and
 * Permissions; Approvals; tier 0d). The plugin reports a pending form (the
 * question tool) or permission request of an agent's session; an agent opens
 * an approval itself. Each is routed by its mode setting, resolved for the
 * asking agent: answered at once (auto: a question dismissed with
 * auto_answer_text; approve: a permission once, an approval approved), left
 * to the owner (ask), or sent to another agent (agent:<id>) or a job's run
 * (job:<name>) as a notice, while the owner's inbox has it too. The first
 * answer wins; an agent answers a permission once or reject only, and may
 * escalate (a note for the owner). A question's or permission's answer goes
 * back to the plugin as an instruction, followed to its ack (refused: the ask
 * opens again); an approval's comes to the asking agent as a notice and ends
 * its wait. An agent with an open ask is `waiting`, and its wakes and
 * messages wait; a question or permission closes when its turn ends, when a
 * hello no longer lists it, or when the owner closes it.
 */
import type { Database } from "bun:sqlite"
import {
  AutocodeError,
  isReservedId,
  onlyFields,
  parseDuration,
  resolveSettings,
} from "@autocode/shared"
import type { History } from "./history.ts"
import type { SettingsStore } from "./settings-store.ts"

export type AskKind = "question" | "permission" | "approval"

export interface Question {
  // the form field's key (q<i> in OpenCode 2.2.0)
  key?: string
  question: string
  header: string
  options: string[]
  descriptions: string[]
  multiple: boolean
}

export interface AskView {
  id: string
  kind: AskKind
  agent: string
  title: string
  routed: string
  notes: string[]
  state: string
  created_at: string
  expires: string | null
  // a question's questions; a permission's action, resources, decisions; an
  // approval's text and options
  questions?: { question: string; options: string[]; multiple: boolean }[]
  action?: string
  resources?: string[]
  message?: string | null
  decisions?: string[]
  text?: string
  options?: string[]
  // once closed
  answer?: unknown
  by?: string | null
  closed_at?: string | null
}

// What the plugin is told to do with an answer.
export interface AnswerOrder {
  host: string | null
  session: string
  // the session the form or request is in (a Subagent's), when not `session`
  form_session?: string
  kind: "question" | "permission"
  ref: string
  answer?: Record<string, string | string[]>
  cancel?: string
  decision?: "once" | "always" | "reject"
  message?: string
}

export interface AskNotice {
  // who is told: the agent an ask was sent to, or the agent whose approval
  // closed
  agent: string
  subject: string
  text: string
}

const iso = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString()

const randomId = () =>
  `ask_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`

const MAX_TEXT = 4000
const MAX_OPTIONS = 20
const MAX_EXPIRY = 30 * 86_400_000

const short = (text: string, n = 80) => {
  const flat = String(text).replace(/\s+/g, " ").trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

export class Asks {
  // Calls waiting on an approval (GET .../approvals/{id}?wait=), by ask.
  private readonly waiters = new Map<string, Set<() => void>>()
  private closed = false

  constructor(
    private readonly db: Database,
    private readonly history: History,
    private readonly settings: SettingsStore,
    private readonly now: () => number,
    // an answer for the plugin to carry out (its instruction's ID)
    private readonly order: (o: AnswerOrder) => string | null,
    // a notice to an agent (a message from autocode)
    private readonly notify: (n: AskNotice) => void,
    // whether an agent ID is registered now
    private readonly registered: (agent: string) => boolean,
  ) {}

  /*
   * Tier 0f: a job that can take a run for an ask now, and starting it (its
   * run's ID, which may answer the ask).
   */
  jobIdle: (job: string) => boolean = () => false
  startJob: (job: string, ask: string) => string | null = () => null
  // an approved job of an agent's (the owner, 2026-11-09): it is set
  setJob: (def: unknown, agent: string) => void = () => {}

  /*
   * A job an agent set, for the owner to approve (the owner, 2026-11-09:
   * job_mode ask): an approval in the owner's inbox with the whole
   * definition, kept with it; the job is set once the owner approves. It
   * goes to the owner alone, never expires, and does not make the agent
   * wait. A new proposal of the same job replaces an open one.
   */
  proposeJob(
    agent: string,
    session: string,
    name: string,
    change: boolean,
    lines: string[],
    def: unknown,
  ): AskView {
    for (const old of this.db
      .query(
        "SELECT * FROM asks WHERE agent_id = ? AND state = 'open' " +
          "AND job_def IS NOT NULL",
      )
      .all(agent) as any[])
      if (JSON.parse(old.job_def).name === name)
        this.finish(old, "gone", null, null, true)
    const text = [
      `${agent} asks to ${change ? "change" : "set"} the job ${name}:`,
      ...lines,
      "",
      "Its prompt:",
      ...String((def as any).prompt)
        .split("\n")
        .map((l) => `> ${l}`),
    ].join("\n")
    const id = randomId()
    this.db
      .query(
        `INSERT INTO asks (id, kind, agent_id, session_id, title, body,
           routed, created_at, job_def)
         VALUES (?, 'approval', ?, ?, ?, ?, 'owner', ?, ?)`,
      )
      .run(
        id,
        agent,
        session,
        `Job ${name}, set by ${agent}`,
        JSON.stringify({ text, options: [], job: name }),
        this.now(),
        JSON.stringify(def),
      )
    this.history.record("ask.opened", {
      agent,
      session,
      data: { id, kind: "approval", routed: "owner", job: name },
    })
    return this.approvalView(this.row(id))
  }

  private row(id: string): any {
    return this.db.query("SELECT * FROM asks WHERE id = ?").get(id)
  }

  private mode(agent: string, kind: AskKind): string {
    const values = resolveSettings(this.settings.layers(), agent).values
    const key =
      kind === "question"
        ? "question_mode"
        : kind === "permission"
          ? "permission_mode"
          : "approval_mode"
    return String(values[key] ?? "ask")
  }

  view(row: any): AskView {
    const body = JSON.parse(row.body)
    const out: AskView = {
      id: row.id,
      kind: row.kind,
      agent: row.agent_id,
      title: row.title,
      routed: row.routed,
      notes: JSON.parse(row.notes),
      state: row.state,
      created_at: iso(row.created_at)!,
      expires: iso(row.expires_at),
    }
    if (row.kind === "question")
      out.questions = (body.questions as Question[]).map((q) => ({
        question: q.question,
        options: q.options,
        multiple: q.multiple,
      }))
    else if (row.kind === "permission") {
      out.action = body.action
      out.resources = body.resources
      out.message = body.message ?? null
      out.decisions = ["once", "always", "reject"]
    } else {
      out.text = body.text
      out.options = body.options
    }
    if (row.state !== "open") {
      out.answer = row.answer ? JSON.parse(row.answer) : null
      out.by = row.answered_by ?? null
      out.closed_at = iso(row.closed_at)
    }
    return out
  }

  /*
   * Where an ask goes: the mode for the asking agent; an agent never answers
   * its own ask; an unregistered agent, and a job that cannot take a run
   * now, fall back to the owner.
   */
  private route(agent: string, kind: AskKind): string {
    const mode = this.mode(agent, kind)
    if (mode.startsWith("agent:")) {
      const to = mode.slice("agent:".length)
      if (to !== agent && !isReservedId(to) && this.registered(to)) return mode
      return "owner"
    }
    if (mode.startsWith("job:"))
      return this.jobIdle(mode.slice("job:".length)) ? mode : "owner"
    return mode === "ask" ? "owner" : mode
  }

  // An open question or permission reported by the plugin.
  opened(host: string | null, agent: string, event: any) {
    const kind = event.kind as AskKind
    const session = String(event.session)
    const ref = String(event.ref ?? "")
    if (!ref || ref.length > 200) return
    // one ask per form or request, open or closed (a late list at a hello)
    if (
      this.db
        .query("SELECT 1 FROM asks WHERE session_id = ? AND ref = ?")
        .get(session, ref)
    )
      return
    const formSession =
      typeof event.form_session === "string" &&
      event.form_session !== session &&
      event.form_session.length <= 200
        ? event.form_session
        : null
    let body: any
    let title: string
    if (kind === "question") {
      const questions: Question[] = (
        Array.isArray(event.questions) ? event.questions : []
      )
        .slice(0, MAX_OPTIONS)
        .map((q: any, i: number) => ({
          key:
            typeof q?.key === "string" && /^[\w.-]{1,100}$/.test(q.key)
              ? q.key
              : `q${i}`,
          question: short(String(q?.question ?? ""), MAX_TEXT),
          header: short(String(q?.header ?? q?.question ?? ""), 200),
          options: (Array.isArray(q?.options) ? q.options : [])
            .slice(0, MAX_OPTIONS)
            .map((o: any) => short(String(o?.label ?? o ?? ""), 200)),
          descriptions: (Array.isArray(q?.options) ? q.options : [])
            .slice(0, MAX_OPTIONS)
            .map((o: any) => short(String(o?.description ?? ""), 500)),
          multiple: q?.multiple === true,
        }))
      if (!questions.length) return
      body = { questions }
      title = `Question from ${agent}: ${questions[0]!.header}`
    } else if (kind === "permission") {
      const resources = (Array.isArray(event.resources) ? event.resources : [])
        .slice(0, 20)
        .map((r: unknown) => short(String(r), 500))
      body = {
        action: short(String(event.action ?? ""), 100),
        resources,
        message: event.message ? short(String(event.message), MAX_TEXT) : null,
      }
      title = short(
        `Permission for ${agent}: ${body.action} ${resources.join(", ")}`,
        200,
      )
    } else return
    const routed = this.route(agent, kind)
    const id = randomId()
    this.db
      .query(
        `INSERT INTO asks (id, kind, agent_id, session_id, host_id, ref,
           form_session, title, body, routed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        kind,
        agent,
        session,
        host,
        ref,
        formSession,
        title,
        JSON.stringify(body),
        routed,
        this.now(),
      )
    this.history.record("ask.opened", {
      agent,
      session,
      data: { id, kind, routed, title },
    })
    // answered at once
    if (kind === "question" && routed === "auto") {
      const text = String(
        resolveSettings(this.settings.layers(), agent).values.auto_answer_text,
      )
      this.finish(this.row(id), "answered", { cancel: text }, "auto")
      this.carry(this.row(id), { cancel: text })
      return
    }
    if (kind === "permission" && routed === "approve") {
      this.finish(this.row(id), "answered", { decision: "once" }, "auto")
      this.carry(this.row(id), { decision: "once" })
      return
    }
    if (routed.startsWith("agent:")) this.send(this.row(id))
    if (routed.startsWith("job:")) this.toJob(this.row(id))
  }

  /*
   * Sends an answer to the plugin; its instruction is followed to its ack
   * (an answer OpenCode refused opens the ask again: pending()).
   */
  private carry(row: any, what: Partial<AnswerOrder>) {
    const instruction = this.order({
      host: row.host_id,
      session: row.session_id,
      ...(row.form_session ? { form_session: row.form_session } : {}),
      kind: row.kind,
      ref: row.ref,
      ...what,
    })
    if (instruction)
      this.db
        .query("UPDATE asks SET answer_instruction = ? WHERE id = ?")
        .run(instruction, row.id)
  }

  /*
   * Answers whose instruction the plugin acked as failed (no local API for
   * forms; OpenCode refused the reply): the ask opens again, with a note and
   * an alert for the owner.
   */
  checkAnswers(
    instruction: (
      id: string,
    ) => { acked: boolean; ok: boolean; error: string | null } | undefined,
    alert: (agent: string, title: string, body: string) => void,
  ) {
    for (const row of this.db
      .query(
        "SELECT * FROM asks WHERE answer_instruction IS NOT NULL " +
          "AND state = 'answered'",
      )
      .all() as any[]) {
      const done = instruction(row.answer_instruction)
      if (!done?.acked) {
        if (!done)
          this.db
            .query("UPDATE asks SET answer_instruction = NULL WHERE id = ?")
            .run(row.id)
        continue
      }
      this.db
        .query("UPDATE asks SET answer_instruction = NULL WHERE id = ?")
        .run(row.id)
      if (done.ok) continue
      const why = short(done.error ?? "an error", 200)
      const notes = JSON.parse(row.notes) as string[]
      notes.push(`the answer did not reach OpenCode: ${why}`)
      this.db
        .query(
          "UPDATE asks SET state = 'open', answer = NULL, " +
            "answered_by = NULL, closed_at = NULL, notes = ? WHERE id = ?",
        )
        .run(JSON.stringify(notes.slice(-10)), row.id)
      this.history.record("ask.reopened", {
        agent: row.agent_id,
        data: { id: row.id, error: why },
      })
      alert(
        row.agent_id,
        `An answer to ${row.agent_id}'s ${row.kind} did not reach OpenCode`,
        `OpenCode said: ${why}. The ${row.kind} is open again in the inbox; ` +
          "answer it there or in the TUI.",
      )
    }
  }

  // The owner closes an ask (one OpenCode lost without telling).
  closeByOwner(id: string): AskView {
    const row = this.row(id)
    if (!row) throw new AutocodeError("no_ask", `no ask ${id}`, 404)
    if (row.state !== "open")
      throw new AutocodeError("ask_closed", `ask ${id} is closed`, 409)
    this.finish(row, "gone", null, "owner")
    this.history.record("ask.closed", {
      agent: row.agent_id,
      data: { id, by: "owner" },
    })
    return this.view(this.row(id))
  }

  /*
   * A turn of the session ended: its questions and permissions are gone (a
   * form lives only while its tool call runs); approvals stay.
   */
  turnEnded(session: string) {
    for (const row of this.db
      .query(
        "SELECT * FROM asks WHERE session_id = ? AND state = 'open' " +
          "AND kind != 'approval'",
      )
      .all(session) as any[]) {
      this.finish(row, "gone", null, null)
      this.history.record("ask.gone", {
        agent: row.agent_id,
        session,
        data: { id: row.id, why: "turn ended" },
      })
    }
  }

  /*
   * At a hello: the forms and requests OpenCode still has, per session; the
   * other open questions and permissions of those sessions are gone.
   */
  stillPending(pending: Record<string, unknown>) {
    for (const [session, refs] of Object.entries(pending)) {
      if (!Array.isArray(refs)) continue
      const keep = new Set(refs.filter((r) => typeof r === "string"))
      for (const row of this.db
        .query(
          "SELECT * FROM asks WHERE session_id = ? AND state = 'open' " +
            "AND kind != 'approval'",
        )
        .all(session) as any[])
        if (!keep.has(row.ref)) {
          this.finish(row, "gone", null, null)
          this.history.record("ask.gone", {
            agent: row.agent_id,
            session,
            data: { id: row.id, why: "not pending" },
          })
        }
    }
  }

  // An ask routed to a job: a run starts with the ask in its prompt.
  private toJob(row: any) {
    const job = String(row.routed).slice("job:".length)
    let run: string | null = null
    try {
      run = this.startJob(job, row.id)
    } catch {
      run = null
    }
    if (run) {
      this.db
        .query("UPDATE asks SET routed = ? WHERE id = ?")
        .run(`agent:${run}`, row.id)
      this.history.record("ask.sent", {
        agent: run,
        data: { id: row.id, from: row.agent_id, kind: row.kind, job },
      })
    } else
      this.db.query("UPDATE asks SET routed = 'owner' WHERE id = ?").run(row.id)
  }

  // What an ask says to whoever answers it (a run's prompt part).
  askText(id: string): string | null {
    const row = this.row(id)
    return row ? this.describe(row).text : null
  }

  // OpenCode settled a form or a permission (the TUI, or our own answer).
  settled(session: string, ref: string, how: string) {
    const row = this.db
      .query("SELECT * FROM asks WHERE session_id = ? AND ref = ?")
      .get(session, ref) as any
    if (!row) return
    if (row.state === "open") {
      this.finish(row, "answered", { settled: how }, "opencode")
      this.history.record("ask.settled", {
        agent: row.agent_id,
        session,
        data: { id: row.id, how: short(how, 40) },
      })
    }
  }

  // The session went away: its open asks close.
  gone(session: string) {
    for (const row of this.db
      .query("SELECT * FROM asks WHERE session_id = ? AND state = 'open'")
      .all(session) as any[]) {
      this.finish(row, "gone", null, null)
      this.history.record("ask.gone", {
        agent: row.agent_id,
        session,
        data: { id: row.id },
      })
      if (row.kind === "approval") this.wake(row.id)
    }
  }

  // An approval an agent asks for.
  approval(agent: string, session: string, body: any): AskView {
    if (!body || typeof body !== "object")
      throw new AutocodeError("bad_request", "the body must be an object")
    onlyFields(body, ["text", "options", "expires"])
    if (
      typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.length > MAX_TEXT
    )
      throw new AutocodeError(
        "bad_request",
        `an approval needs text of at most ${MAX_TEXT} characters`,
      )
    const options = body.options ?? []
    if (
      !Array.isArray(options) ||
      options.length > MAX_OPTIONS ||
      options.some(
        (o: unknown) => typeof o !== "string" || !o.trim() || o.length > 200,
      )
    )
      throw new AutocodeError(
        "bad_request",
        `options are a list of up to ${MAX_OPTIONS} short texts`,
      )
    let expires: number | null = null
    if (body.expires !== undefined && body.expires !== null) {
      let ms: number
      try {
        ms = parseDuration(body.expires)
      } catch {
        throw new AutocodeError(
          "bad_request",
          "expires is a duration, like 1h or 2d",
        )
      }
      if (ms < 1000 || ms > MAX_EXPIRY)
        throw new AutocodeError("bad_request", "expires is from 1s to 30d")
      expires = this.now() + ms
    }
    const routed = this.route(agent, "approval")
    const id = randomId()
    const text = body.text.trim()
    this.db
      .query(
        `INSERT INTO asks (id, kind, agent_id, session_id, title, body,
           routed, expires_at, created_at)
         VALUES (?, 'approval', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        agent,
        session,
        short(`Approval for ${agent}: ${text}`, 200),
        JSON.stringify({ text, options }),
        routed,
        expires,
        this.now(),
      )
    this.history.record("ask.opened", {
      agent,
      session,
      data: { id, kind: "approval", routed },
    })
    if (routed === "approve")
      this.finish(this.row(id), "answered", { decision: "approve" }, "auto")
    else if (routed.startsWith("agent:")) this.send(this.row(id))
    else if (routed.startsWith("job:")) this.toJob(this.row(id))
    return this.approvalView(this.row(id))
  }

  // An agent's own approval, by ID.
  ownApproval(agent: string, id: string): AskView {
    const row = this.row(id)
    if (row?.kind !== "approval" || row.agent_id !== agent)
      throw new AutocodeError("no_approval", `no approval ${id}`, 404)
    return this.approvalView(row)
  }

  private approvalView(row: any): AskView & Record<string, unknown> {
    const v = this.view(row)
    const a = row.answer ? JSON.parse(row.answer) : null
    return {
      ...v,
      state:
        row.state === "answered"
          ? a?.decision === "reject"
            ? "rejected"
            : "approved"
          : row.state,
      ...(a?.option ? { option: a.option } : {}),
      ...(a?.text ? { note: a.text } : {}),
    }
  }

  // Waits up to ms (real time) for an agent's approval to close.
  async waitApproval(
    agent: string,
    id: string,
    ms: number,
    signal?: AbortSignal,
  ): Promise<AskView> {
    const deadline = Date.now() + ms
    for (;;) {
      this.tick()
      const v = this.ownApproval(agent, id)
      if (
        v.state !== "open" ||
        this.closed ||
        Date.now() >= deadline ||
        signal?.aborted
      )
        return v
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(id) ?? new Set()
        this.waiters.set(id, set)
        const done = () => {
          clearTimeout(timer)
          set.delete(done)
          if (!set.size) this.waiters.delete(id)
          signal?.removeEventListener("abort", done)
          resolve()
        }
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()))
        signal?.addEventListener("abort", done)
        set.add(done)
      })
    }
  }

  private wake(id: string) {
    for (const done of this.waiters.get(id) ?? []) done()
  }

  close() {
    this.closed = true
    for (const set of this.waiters.values()) for (const done of set) done()
  }

  // Tells the agent an ask was sent to: what is asked and how to answer.
  private send(row: any) {
    const to = String(row.routed).slice("agent:".length)
    const { subject, text } = this.describe(row)
    this.history.record("ask.sent", {
      agent: to,
      data: { id: row.id, from: row.agent_id, kind: row.kind },
    })
    try {
      this.notify({ agent: to, subject, text })
    } catch {}
  }

  // What an ask says, for the one who answers it.
  private describe(row: any): { subject: string; text: string } {
    const body = JSON.parse(row.body)
    const how =
      `Answer with autocode_message action=answer id=${row.id} text=...; ` +
      "if you cannot, hand it to the owner with autocode_message " +
      `action=escalate id=${row.id} text=<why>. The owner sees it too; the ` +
      "first answer counts."
    let subject: string
    let text: string
    if (row.kind === "question") {
      const qs = body.questions as Question[]
      subject = `question from ${row.agent_id}: "${short(qs[0]!.header, 60)}"`
      text = [
        `Agent ${row.agent_id} asks (its turn waits for the answer):`,
        ...qs.flatMap((q, i) => [
          "",
          `${qs.length > 1 ? `${i + 1}. ` : ""}${q.question}` +
            (q.multiple ? " (one or more)" : ""),
          ...q.options.map(
            (o, j) =>
              `- ${o}${q.descriptions[j] ? `: ${q.descriptions[j]}` : ""}`,
          ),
        ]),
        "",
        qs.length > 1
          ? "Give one answer per question, separated by new lines; an " +
            "option's name, or your own words."
          : "Give an option's name, or your own words.",
        how,
      ].join("\n")
    } else if (row.kind === "permission") {
      subject = short(
        `permission for ${row.agent_id}: ${body.action} ` +
          body.resources.join(", "),
        120,
      )
      text = [
        `Agent ${row.agent_id} wants to run ${body.action}: ` +
          body.resources.join(", ") +
          (body.message ? ` (${body.message})` : "") +
          ". Its turn waits.",
        "",
        "Answer text=once or text=reject (add a reason after reject: " +
          '"reject: not the build folder"); only the owner allows always.',
        how,
      ].join("\n")
    } else {
      subject = `approval for ${row.agent_id}: "${short(body.text, 60)}"`
      text = [
        `Agent ${row.agent_id} asks for approval: ${body.text}`,
        ...(body.options.length
          ? ["", `Options: ${body.options.join(", ")}.`]
          : []),
        "",
        "Answer text=approve or text=reject, then " +
          (body.options.length ? "an option and " : "") +
          'an optional note ("approve tonight: after 22:00").',
        how,
      ].join("\n")
    }
    return { subject, text }
  }

  private finish(
    row: any,
    state: string,
    answer: unknown,
    by: string | null,
    quiet = false,
  ) {
    this.db
      .query(
        `UPDATE asks SET state = ?, answer = ?, answered_by = ?, closed_at = ?
         WHERE id = ? AND state = 'open'`,
      )
      .run(
        state,
        answer === null ? null : JSON.stringify(answer),
        by,
        this.now(),
        row.id,
      )
    if (by && by !== "opencode" && state === "answered")
      this.history.record("ask.answered", {
        agent: row.agent_id,
        data: { id: row.id, kind: row.kind, by },
      })
    if (row.kind === "approval" && state !== "open") {
      this.wake(row.id)
      // an agent's job, approved: it is set now (the owner, 2026-11-09)
      const done = this.row(row.id)
      let setNote = ""
      if (row.job_def && state === "answered") {
        const a = done.answer ? JSON.parse(done.answer) : null
        if (a?.decision === "approve") {
          const def = JSON.parse(row.job_def)
          try {
            this.setJob(def, row.agent_id)
            setNote = `The job ${def.name} is set.`
          } catch (err) {
            setNote =
              `The job ${def.name} could not be set: ` +
              `${(err as Error).message}`
          }
        }
      }
      if (by !== "auto" && !quiet) this.tellApproval(done, setNote)
    }
  }

  // The asking agent is told how its approval ended.
  private tellApproval(row: any, extra = "") {
    const v = this.approvalView(row)
    const body = JSON.parse(row.body)
    const what =
      v.state === "expired"
        ? "rejected (expired)"
        : v.state === "gone"
          ? "closed"
          : String(v.state)
    const by =
      row.answered_by === "owner"
        ? "the owner"
        : row.answered_by
          ? `agent ${row.answered_by}`
          : "nobody"
    // a job's approval is named by its job (the owner, 2026-11-09)
    const named = body.job ? `Job ${body.job}` : body.text
    const parts = [
      v.state === "expired"
        ? `Your approval "${short(named, 80)}" expired unanswered: ` +
          "treat it as rejected."
        : `Your approval "${short(named, 80)}" was ${what} by ${by}.`,
    ]
    if (v.option) parts.push(`Option: ${v.option}.`)
    if (v.note) parts.push(`Note: ${v.note}`)
    if (extra) parts.push(extra)
    try {
      this.notify({
        agent: row.agent_id,
        subject: `approval "${short(named, 60)}" ${what}`,
        text: parts.join(" "),
      })
    } catch {}
  }

  /*
   * An answer by the owner (by = "owner") or by the agent the ask was sent
   * to. The first answer wins.
   */
  answer(id: string, by: string, body: any): AskView {
    if (!body || typeof body !== "object")
      throw new AutocodeError("bad_request", "the body must be an object")
    onlyFields(body, ["text", "answers", "decision", "option"])
    const row = this.row(id)
    if (!row) throw new AutocodeError("no_ask", `no ask ${id}`, 404)
    if (by !== "owner" && row.routed !== `agent:${by}`)
      throw new AutocodeError(
        "forbidden",
        `ask ${id} was not sent to ${by}`,
        403,
      )
    if (row.state !== "open")
      throw new AutocodeError(
        "ask_closed",
        row.answered_by
          ? `ask ${id} is already answered by ${
              row.answered_by === "owner" ? "the owner" : row.answered_by
            }`
          : `ask ${id} is closed (${row.state})`,
        409,
      )
    const text = typeof body.text === "string" ? body.text.trim() : ""
    if (text.length > MAX_TEXT)
      throw new AutocodeError("bad_request", "the answer is too long")
    if (row.kind === "question") {
      const qs = JSON.parse(row.body).questions as Question[]
      const parts: string[] = Array.isArray(body.answers)
        ? body.answers.map((x: unknown) => String(x ?? "").trim())
        : qs.length > 1
          ? text.split("\n").map((x: string) => x.trim())
          : [text]
      if (!parts.some(Boolean))
        throw new AutocodeError("bad_request", "the answer needs text")
      const answer: Record<string, string | string[]> = {}
      qs.forEach((q, i) => {
        const a = parts[i] ?? ""
        if (!a) return
        // the form's own field key (q<i> in OpenCode 2.2.0)
        const key = q.key ?? `q${i}`
        if (q.multiple)
          answer[key] = a
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        else answer[key] = a
      })
      this.finish(row, "answered", { answer }, by)
      this.carry(row, { answer })
    } else if (row.kind === "permission") {
      let decision = String(body.decision ?? "").trim()
      let message = text
      if (!decision) {
        const m = /^(once|always|reject)\b[:\s]*(.*)$/is.exec(text)
        if (!m)
          throw new AutocodeError(
            "bad_request",
            "a permission's answer is once, always or reject",
          )
        decision = m[1]!.toLowerCase()
        message = m[2]!.trim()
      }
      if (!["once", "always", "reject"].includes(decision))
        throw new AutocodeError(
          "bad_request",
          "a permission's answer is once, always or reject",
        )
      if (decision === "always" && by !== "owner")
        throw new AutocodeError(
          "forbidden",
          "only the owner allows always; answer once or reject",
          403,
        )
      this.finish(
        row,
        "answered",
        { decision, ...(message ? { text: message } : {}) },
        by,
      )
      this.carry(row, {
        decision: decision as "once" | "always" | "reject",
        ...(decision === "reject" && message ? { message } : {}),
      })
    } else {
      const options = JSON.parse(row.body).options as string[]
      let decision = String(body.decision ?? "").trim()
      let rest = text
      if (!decision) {
        const m =
          /^(approve|approved|yes|reject|rejected|no)\b[\s:;,.!-]*(.*)$/is.exec(
            text,
          )
        if (!m)
          throw new AutocodeError(
            "bad_request",
            "an approval's answer is approve or reject",
          )
        decision = /^(approve|approved|yes)$/i.test(m[1]!)
          ? "approve"
          : "reject"
        rest = m[2]!.trim()
      }
      if (!["approve", "reject"].includes(decision))
        throw new AutocodeError(
          "bad_request",
          "an approval's answer is approve or reject",
        )
      let option = typeof body.option === "string" ? body.option.trim() : ""
      if (!option && options.length) {
        // "approve tonight: after 22:00": an option first, then the note
        const hit = options.find(
          (o) =>
            rest.toLowerCase() === o.toLowerCase() ||
            rest.toLowerCase().startsWith(`${o.toLowerCase()}:`) ||
            rest.toLowerCase().startsWith(`${o.toLowerCase()} `),
        )
        if (hit) {
          option = hit
          rest = rest.slice(hit.length).replace(/^[:\s]+/, "")
        }
      }
      if (option && options.length && !options.includes(option))
        throw new AutocodeError(
          "bad_request",
          `option must be one of ${options.join(", ")}`,
        )
      this.finish(
        row,
        "answered",
        {
          decision,
          ...(option ? { option } : {}),
          ...(rest ? { text: rest } : {}),
        },
        by,
      )
    }
    return this.view(this.row(id))
  }

  // The agent an ask was sent to cannot answer: a note for the owner.
  escalate(id: string, by: string, body: any): AskView {
    if (!body || typeof body !== "object")
      throw new AutocodeError("bad_request", "the body must be an object")
    onlyFields(body, ["text"])
    const row = this.row(id)
    if (!row) throw new AutocodeError("no_ask", `no ask ${id}`, 404)
    if (row.routed !== `agent:${by}`)
      throw new AutocodeError(
        "forbidden",
        `ask ${id} was not sent to ${by}`,
        403,
      )
    if (row.state !== "open")
      throw new AutocodeError("ask_closed", `ask ${id} is closed`, 409)
    const why = typeof body.text === "string" ? short(body.text, 500) : ""
    const notes = JSON.parse(row.notes) as string[]
    notes.push(`${by} cannot answer${why ? `: ${why}` : ""}`)
    this.db
      .query("UPDATE asks SET notes = ? WHERE id = ?")
      .run(JSON.stringify(notes.slice(-10)), id)
    this.history.record("ask.escalated", {
      agent: by,
      data: { id, from: row.agent_id, why },
    })
    return this.view(this.row(id))
  }

  // Approvals past their expiry: rejected, the agent told.
  tick() {
    for (const row of this.db
      .query(
        "SELECT * FROM asks WHERE state = 'open' AND expires_at IS NOT NULL " +
          "AND expires_at <= ?",
      )
      .all(this.now()) as any[]) {
      this.finish(row, "expired", null, null)
      this.history.record("ask.expired", {
        agent: row.agent_id,
        data: { id: row.id },
      })
    }
  }

  // An unregistered agent's asks close, and asks sent to it go to the owner.
  unregistered(agent: string) {
    for (const row of this.db
      .query("SELECT * FROM asks WHERE agent_id = ? AND state = 'open'")
      .all(agent) as any[])
      this.finish(row, "gone", null, null)
    this.db
      .query(
        "UPDATE asks SET routed = 'owner' WHERE routed = ? AND state = 'open'",
      )
      .run(`agent:${agent}`)
  }

  open(): AskView[] {
    return (
      this.db
        .query("SELECT * FROM asks WHERE state = 'open' ORDER BY created_at")
        .all() as any[]
    ).map((r) => this.view(r))
  }

  all(): AskView[] {
    return (
      this.db.query("SELECT * FROM asks ORDER BY created_at").all() as any[]
    ).map((r) => this.view(r))
  }

  // What an agent has open (it is `waiting` while there is one).
  of(agent: string): AskView[] {
    return (
      this.db
        .query(
          "SELECT * FROM asks WHERE agent_id = ? AND state = 'open' " +
            "AND job_def IS NULL ORDER BY created_at",
        )
        .all(agent) as any[]
    ).map((r) => this.view(r))
  }

  trim(days: number) {
    this.db
      .query("DELETE FROM asks WHERE state != 'open' AND closed_at < ?")
      .run(this.now() - days * 86_400_000)
  }
}
