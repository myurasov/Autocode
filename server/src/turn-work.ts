/*
 * The work that outlives its turn (spec, Wakes, "What each wake costs";
 * 1.1.0-rc2, the owner, 2026-11-21: "ok, lets build it!", after a
 * measurement: over a week, $527 of $1,806 wake dollars on one machine were
 * filed under another wake than the one that began the work). A background
 * command or a Subagent is work of the turn that started it, however many
 * other turns run before it ends. The plugin reports such work
 * (work.started: the top-level session and a ref, a command's ID or a
 * Subagent's session); kept here is the prompt that had started the
 * session's turn then (sessions.turn_cause; none for work that the owner's
 * turn started). A notice's turn and a Subagent's steps then go by their
 * work, not by the turn that happens to run.
 */

import type { Database } from "bun:sqlite"

const MAX_REF = 200
const ref_ok = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_REF

export class TurnWork {
  constructor(
    private readonly db: Database,
    private readonly now: () => number,
  ) {}

  /*
   * The plugin reported work of a session: it takes the prompt of the
   * session's turn now; a Subagent's own Subagent takes its parent's. The
   * first report of a work stands (a batch may come twice).
   */
  started(session: unknown, ref: unknown, parent?: unknown) {
    if (typeof session !== "string" || !ref_ok(ref)) return
    const row = this.db
      .query(
        "SELECT turn_cause, turn_kind FROM sessions " +
          "WHERE id = ? AND deleted_at IS NULL",
      )
      .get(session) as {
      turn_cause: string | null
      turn_kind: string | null
    } | null
    if (!row) return
    const from = ref_ok(parent) ? this.causeOf(session, parent) : undefined
    // what started that turn (1.1.0-rc7), taken the same way
    const kind = ref_ok(parent) ? this.kindOf(session, parent) : undefined
    this.db
      .query(
        "INSERT OR IGNORE INTO turn_work (session_id, ref, cause, at, kind) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        session,
        ref,
        from !== undefined ? from : row.turn_cause,
        this.now(),
        from !== undefined ? (kind ?? null) : row.turn_kind,
      )
  }

  /*
   * What started the turn that started a work (a cause's name, 1.1.0-rc7):
   * undefined for work that was never reported, or reported before causes
   * were kept.
   */
  kindOf(session: string, ref: unknown): string | undefined {
    if (!ref_ok(ref)) return undefined
    const row = this.db
      .query("SELECT kind FROM turn_work WHERE session_id = ? AND ref = ?")
      .get(session, ref) as { kind: string | null } | null
    return row?.kind ?? undefined
  }

  /*
   * The prompt (an injection's ID) of the turn that started a work: null
   * for work that no prompt's turn started (the owner's), undefined for
   * work that was never reported.
   */
  causeOf(session: string, ref: unknown): string | null | undefined {
    if (!ref_ok(ref)) return undefined
    const row = this.db
      .query("SELECT cause FROM turn_work WHERE session_id = ? AND ref = ?")
      .get(session, ref) as { cause: string | null } | null
    return row ? row.cause : undefined
  }

  /*
   * An agent unregistered: the work of the sessions its prompts went to is
   * forgotten, and no turn of theirs is its prompt's any more.
   */
  forget(agent: string) {
    this.db
      .query(
        "DELETE FROM turn_work WHERE session_id IN " +
          "(SELECT DISTINCT session_id FROM injections WHERE agent_id = ?)",
      )
      .run(agent)
    this.db
      .query(
        "UPDATE sessions SET turn_cause = NULL WHERE turn_cause IN " +
          "(SELECT id FROM injections WHERE agent_id = ?)",
      )
      .run(agent)
  }

  // Kept as long as the wakes' numbers: history_days, at least 31 days.
  trim(days: number) {
    this.db
      .query("DELETE FROM turn_work WHERE at < ?")
      .run(this.now() - Math.max(days, 31) * 86_400_000)
  }
}
