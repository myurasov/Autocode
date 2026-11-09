/*
 * Messages and the owner's inbox (spec, Messages; Owner Controls): sending to
 * one agent, a pattern or a list (one copy each, never to the sender), to and
 * from the owner, text only (the owner, 2026-11-07); each copy's state
 * (queued, then delivered: in a prompt, whole, or in the owner's inbox;
 * dropped: its agent unregistered first; Phase 1, the owner 2026-11-08: no
 * reading or waiting); Autocode's own notices
 * (locks, asks sent to an agent, approvals' answers, cost warnings, runs'
 * results); the inbox of messages to the owner and alerts, answered or
 * closed.
 */

import type { Database } from "bun:sqlite"
import {
  AutocodeError,
  checkId,
  isReservedId,
  matchesPattern,
  onlyFields,
  parsePattern,
} from "@autocode/shared"
import type { History } from "./history.ts"

export const MAX_MESSAGE = 32_000
// How much of a text message the owner's list shows (200: the owner,
// 2026-11-03).
export const PREVIEW = 200
const MAX_SUBJECT = 500

const iso = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString()

function randomId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
}

export interface MessageView {
  id: string
  send_id: string
  from: string
  to: string
  subject: string
  reply_to: string | null
  size: number
  state: string
  created_at: string
  delivered_at: string | null
  text?: string
}

export function messageView(row: any, body = false): MessageView {
  return {
    id: row.id,
    send_id: row.send_id,
    from: row.from_id,
    to: row.to_id,
    subject: row.subject,
    reply_to: row.reply_to ?? null,
    size: row.size,
    state: row.state,
    created_at: iso(row.created_at)!,
    delivered_at: iso(row.delivered_at),
    ...(body ? { text: row.body } : {}),
  }
}

export class Messages {
  constructor(
    private readonly db: Database,
    private readonly history: History,
    private readonly now: () => number,
    // A copy for an agent: the injection queue announces it.
    private readonly announce: (agent: string, message: string) => void,
    private readonly inbox: () => Inbox,
  ) {}

  private registered(): string[] {
    return (
      this.db.query("SELECT id FROM agents ORDER BY id").all() as {
        id: string
      }[]
    ).map((r) => r.id)
  }

  /*
   * The recipients a sender's `to` names (refused when none), and the names of
   * a list that are left out (unknown, reserved, the sender).
   */
  private recipients(
    to: unknown,
    from: string,
  ): { to: string[]; skipped: string[] } {
    const parts =
      typeof to === "string"
        ? parsePattern(to)
        : Array.isArray(to) && to.every((t) => typeof t === "string")
          ? parsePattern(to as string[])
          : undefined
    if (!parts?.length)
      throw new AutocodeError(
        "bad_request",
        "to must be an agent ID, a pattern or a list",
      )
    const agents = this.registered()
    const out = new Set<string>()
    const skipped = new Set<string>()
    for (const part of parts) {
      if (part === "owner") {
        if (from !== "owner") out.add("owner")
        continue
      }
      if (part.includes("*")) {
        for (const id of agents)
          if (id !== from && matchesPattern([part], id)) out.add(id)
        continue
      }
      checkId(part, "recipient")
      if (isReservedId(part) || part === from || !agents.includes(part)) {
        if (parts.length === 1)
          throw new AutocodeError(
            "no_recipient",
            part === from
              ? "an agent does not message itself"
              : `no agent ${part} is registered`,
            404,
          )
        skipped.add(part)
        continue
      }
      out.add(part)
    }
    if (!out.size)
      throw new AutocodeError(
        "no_recipient",
        `no registered agent matches ${parts.join(",")}`,
        404,
      )
    return { to: [...out].sort(), skipped: [...skipped].sort() }
  }

  send(from: string, body: any) {
    if (!body || typeof body !== "object")
      throw new AutocodeError("bad_request", "the body must be an object")
    onlyFields(body, ["to", "subject", "text", "reply_to"])
    const subject = body.subject ?? ""
    if (
      typeof subject !== "string" ||
      subject.length > MAX_SUBJECT ||
      [...subject].some((ch) => ch.charCodeAt(0) < 32 || ch === "\u007f")
    )
      throw new AutocodeError(
        "bad_request",
        `a subject is one line of at most ${MAX_SUBJECT} characters`,
      )
    if (typeof body.text !== "string" || !body.text.length)
      throw new AutocodeError("bad_request", "a message needs text")
    const content: string = body.text
    if (content.length > MAX_MESSAGE)
      throw new AutocodeError(
        "too_large",
        `a message is at most ${MAX_MESSAGE} characters; this one is ` +
          `${content.length}`,
      )
    let replyTo: string | null = null
    if (body.reply_to !== undefined && body.reply_to !== null) {
      replyTo = String(body.reply_to)
      // only a message the sender sent or got
      if (
        !this.db
          .query(
            "SELECT 1 FROM messages " +
              "WHERE id = ? AND (from_id = ? OR to_id = ?)",
          )
          .get(replyTo, from, from)
      )
        throw new AutocodeError("no_message", `no message ${replyTo}`, 404)
    }
    const { to, skipped } = this.recipients(body.to, from)
    const sendId = randomId("s_")
    const toSpec = Array.isArray(body.to) ? body.to.join(",") : String(body.to)
    const now = this.now()
    const insert = this.db.prepare(
      `INSERT INTO messages (id, send_id, from_id, to_id, to_spec, subject,
         reply_to, body, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const messages: { id: string; to: string }[] = []
    this.db.transaction(() => {
      for (const recipient of to) {
        const id = randomId("m_")
        insert.run(
          id,
          sendId,
          from,
          recipient,
          toSpec,
          subject,
          replyTo,
          content,
          content.length,
          now,
        )
        messages.push({ id, to: recipient })
      }
    })()
    for (const m of messages) {
      if (m.to === "owner") {
        this.inbox().open("message", {
          agent: from,
          message: m.id,
          title: `Message from ${from}${subject ? `: "${subject}"` : ""}`,
          body: content,
        })
        this.delivered(m.id)
      } else this.announce(m.to, m.id)
    }
    this.history.record("message.sent", {
      agent: from === "owner" ? null : from,
      data: {
        send: sendId,
        from,
        to: toSpec,
        recipients: to,
        size: content.length,
      },
    })
    return { send_id: sendId, recipients: to, skipped, messages }
  }

  /*
   * A notice from Autocode itself to an agent (a lock granted, expired,
   * released by the owner or its place in the queue taken away: tier 0c),
   * announced like any message.
   */
  notice(agent: string, subject: string, text: string): string {
    const id = randomId("m_")
    this.db
      .query(
        `INSERT INTO messages (id, send_id, from_id, to_id, to_spec, subject,
           body, size, created_at)
         VALUES (?, ?, 'autocode', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        randomId("s_"),
        agent,
        agent,
        subject,
        text,
        text.length,
        this.now(),
      )
    this.announce(agent, id)
    this.history.record("message.sent", {
      agent,
      data: {
        from: "autocode",
        to: agent,
        recipients: [agent],
        size: text.length,
        kind: "notice",
        subject,
      },
    })
    return id
  }

  /*
   * An agent unregistered: Autocode's notices to it that wait go; the other
   * messages that wait are dropped (the owner still sees them, and the
   * history says so), for no prompt will carry them (the final review).
   */
  dropNotices(agent: string) {
    this.db
      .query(
        "DELETE FROM messages WHERE to_id = ? AND from_id = 'autocode' " +
          "AND state = 'queued'",
      )
      .run(agent)
    const waiting = this.db
      .query(
        "SELECT id, from_id FROM messages WHERE to_id = ? AND state = 'queued'",
      )
      .all(agent) as { id: string; from_id: string }[]
    this.db
      .query(
        "UPDATE messages SET state = 'dropped' WHERE to_id = ? " +
          "AND state = 'queued'",
      )
      .run(agent)
    for (const m of waiting)
      this.history.record("message.dropped", {
        agent,
        data: { id: m.id, from: m.from_id, why: "unregistered" },
      })
  }

  // In a prompt (or the owner's inbox): delivered.
  delivered(id: string) {
    this.db
      .query(
        "UPDATE messages SET state = 'delivered', delivered_at = ? " +
          "WHERE id = ? AND state = 'queued'",
      )
      .run(this.now(), id)
  }

  requeue(id: string) {
    this.db
      .query(
        "UPDATE messages SET state = 'queued', delivered_at = NULL " +
          "WHERE id = ?",
      )
      .run(id)
  }

  row(id: string): any {
    return this.db.query("SELECT * FROM messages WHERE id = ?").get(id)
  }

  // How many of an agent's messages wait for its next prompt (Phase 1).
  waiting(agent: string): number {
    return (
      this.db
        .query(
          "SELECT COUNT(*) AS n FROM messages WHERE to_id = ? " +
            "AND state = 'queued'",
        )
        .get(agent) as any
    ).n
  }

  // The owner reads any message whole (its state stays).
  ownerRead(id: string): MessageView {
    const row = this.row(id)
    if (!row) throw new AutocodeError("no_message", `no message ${id}`, 404)
    return messageView(row, true)
  }

  // The owner's view: every message, newest first, without bodies; a text
  // message carries its first PREVIEW characters.
  all(filter: { agent?: string; limit?: number } = {}): MessageView[] {
    const limit = Math.min(Math.max(1, filter.limit ?? 200), 1000)
    const rows = filter.agent
      ? this.db
          .query(
            "SELECT * FROM messages WHERE from_id = ? OR to_id = ? " +
              "ORDER BY created_at DESC, rowid DESC LIMIT ?",
          )
          .all(filter.agent, filter.agent, limit)
      : this.db
          .query(
            "SELECT * FROM messages ORDER BY created_at DESC, rowid DESC " +
              "LIMIT ?",
          )
          .all(limit)
    return (rows as any[]).map((r) => ({
      ...messageView(r),
      preview: String(r.body).slice(0, PREVIEW),
    }))
  }

  // Message bodies go with the history (history_days).
  trim(days: number) {
    this.db
      .query("DELETE FROM messages WHERE created_at < ?")
      .run(this.now() - days * 86_400_000)
  }
}

export interface InboxItem {
  id: string
  kind: "message" | "alert" | "question" | "permission" | "approval"
  agent: string | null
  message_id: string | null
  title: string
  body: string
  created_at: string
  closed_at: string | null
  answer: string | null
}

export class Inbox {
  constructor(
    private readonly db: Database,
    private readonly history: History,
    private readonly now: () => number,
    private readonly messages: () => Messages,
  ) {}

  open(
    kind: "message" | "alert",
    item: { agent?: string; message?: string; title: string; body?: string },
  ): string {
    const id = randomId("ib_")
    this.db
      .query(
        `INSERT INTO inbox (id, kind, agent_id, message_id, title, body,
           created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        kind,
        item.agent ?? null,
        item.message ?? null,
        item.title,
        item.body ?? "",
        this.now(),
      )
    this.history.record("inbox.opened", {
      agent: item.agent ?? null,
      data: { id, kind, title: item.title },
    })
    return id
  }

  private view(row: any): InboxItem {
    return {
      id: row.id,
      kind: row.kind,
      agent: row.agent_id ?? null,
      message_id: row.message_id ?? null,
      title: row.title,
      body: row.body,
      created_at: iso(row.created_at)!,
      closed_at: iso(row.closed_at),
      answer: row.answer ?? null,
    }
  }

  // Messages and alerts; the server adds the asks (tier 0d).
  list(all = false): InboxItem[] {
    const rows = this.db
      .query(
        `SELECT * FROM inbox ${all ? "" : "WHERE closed_at IS NULL"}
         ORDER BY created_at, rowid`,
      )
      .all() as any[]
    return rows.map((r) => this.view(r))
  }

  private openItem(id: string): any {
    const row = this.db.query("SELECT * FROM inbox WHERE id = ?").get(id) as any
    if (!row) throw new AutocodeError("no_item", `no inbox item ${id}`, 404)
    if (row.closed_at)
      throw new AutocodeError("closed", `inbox item ${id} is closed`, 409)
    return row
  }

  // Answers a message: the owner's reply goes back to the agent.
  answer(id: string, body: any): InboxItem {
    const row = this.openItem(id)
    if (row.kind !== "message")
      throw new AutocodeError(
        "bad_request",
        "only a message is answered; close an alert",
      )
    const text = body?.text
    if (typeof text !== "string" || !text.trim())
      throw new AutocodeError("bad_request", "the answer needs text")
    // the question may be gone with the history: then a plain message
    const known =
      row.message_id &&
      this.db.query("SELECT 1 FROM messages WHERE id = ?").get(row.message_id)
    this.messages().send("owner", {
      to: row.agent_id,
      text,
      ...(known ? { reply_to: row.message_id } : {}),
    })
    this.db
      .query("UPDATE inbox SET closed_at = ?, answer = ? WHERE id = ?")
      .run(this.now(), text, id)
    this.history.record("inbox.answered", {
      agent: row.agent_id,
      data: { id },
    })
    return this.view(this.db.query("SELECT * FROM inbox WHERE id = ?").get(id))
  }

  close(id: string): InboxItem {
    this.openItem(id)
    this.db
      .query("UPDATE inbox SET closed_at = ? WHERE id = ?")
      .run(this.now(), id)
    this.history.record("inbox.closed", { data: { id } })
    return this.view(this.db.query("SELECT * FROM inbox WHERE id = ?").get(id))
  }

  // Closed items go with the history.
  trim(days: number) {
    this.db
      .query("DELETE FROM inbox WHERE closed_at IS NOT NULL AND closed_at < ?")
      .run(this.now() - days * 86_400_000)
  }

  // Unregistering closes the agent's open items.
  closeForAgent(agent: string) {
    this.db
      .query(
        "UPDATE inbox SET closed_at = ? " +
          "WHERE agent_id = ? AND closed_at IS NULL",
      )
      .run(this.now(), agent)
  }
}
