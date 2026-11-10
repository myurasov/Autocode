/*
 * Spawned agents: jobs and their runs (spec, Spawned Agents; tier 0f). The
 * owner defines a job on a host (a plugin instance: its machine and folder)
 * with a model, a prompt, a trigger (every, at, cron, fire-only), where the
 * result goes, a time limit, a cap (run_usd) and delete_session. A run
 * starts on the trigger, by the owner, by an agent, or for an ask routed to
 * job:<name>; the plugin spawns a fresh session in the folder, the server
 * registers it under the run's ID (`<job>:<start, to the minute>`) and
 * prompts it. One run at a time: a scheduled one while another works is
 * skipped, one asked for is refused. A run ends with finish, or idle after
 * a turn with its last reply as the result; the result goes to its
 * destination as a message (the inbox for the owner); then the agent is
 * unregistered and, with delete_session, its session removed once its last
 * turn ends. A run past its time limit or run_usd, or whose turn failed and
 * is not retried, fails: the destination is told, the owner gets an alert,
 * the session is kept until the owner deletes it. A run waits for its host
 * (an unloaded folder is loaded again) up to its time limit.
 */
import type { Database } from "bun:sqlite"
import {
  AutocodeError,
  checkId,
  formatDuration,
  formatTrigger,
  isReservedId,
  nextRun,
  onlyFields,
  parseDuration,
  parsePattern,
  parseTrigger,
  type Trigger,
} from "@autocode/shared"
import { promptId } from "./delivery.ts"
import type { History } from "./history.ts"

const MAX_PROMPT = 32_000
const MAX_RESULT = 32_000
const DEFAULT_TIMEOUT = 3_600_000
// How long a spawn sent to an online host may go unanswered.
const SPAWN_GRACE = 120_000
// How a run was started (`how`); an agent's ID is in `started_by`.
type How = "owner" | "schedule" | "ask" | "agent"

const iso = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString()

export interface JobsDeps {
  db: Database
  history: History
  now: () => number
  tz: () => string
  enqueue: (host: string, type: string, payload: unknown) => string
  instruction: (
    id: string,
  ) =>
    | { acked: boolean; ok: boolean; result: any; error: string | null }
    | undefined
  // notes a new session of a host (the spawned one)
  noteSession: (host: string, session: string) => void
  // registers a session under an ID (never moving it from another session)
  register: (id: string, session: string, description: string) => void
  unregister: (id: string) => void
  // a message from autocode to an agent, or an inbox item for the owner
  tell: (to: string, subject: string, text: string) => void
  alert: (title: string, body: string) => void
  // the run's spend so far, all its days
  spent: (agent: string) => number
  // the asks' notice text for a run started for one
  askText: (ask: string) => string | null
  // the agent that opened an ask
  askedBy: (ask: string) => string | null
  // a run's asks go to the owner when it ends
  released: (agent: string) => void
  // an offline host on this machine: load its folder again
  load: (host: string) => void
}

export class Jobs {
  constructor(private readonly d: JobsDeps) {}

  private get db() {
    return this.d.db
  }

  private row(name: string): any {
    return this.db.query("SELECT * FROM jobs WHERE name = ?").get(name)
  }

  private runRow(id: string): any {
    return this.db.query("SELECT * FROM runs WHERE id = ?").get(id)
  }

  view(row: any) {
    const host = this.db
      .query("SELECT machine, directory, online FROM hosts WHERE id = ?")
      .get(row.host_id) as any
    const last = this.db
      .query(
        "SELECT id, state, started_at FROM runs WHERE job = ? " +
          "AND state != 'skipped' ORDER BY started_at DESC LIMIT 1",
      )
      .get(row.name) as any
    return {
      name: row.name,
      description: row.description,
      host: row.host_id,
      machine: host?.machine ?? null,
      directory: host?.directory ?? null,
      online: !!host?.online,
      model: row.model,
      ...(row.variant ? { variant: row.variant } : {}),
      ...(row.agent ? { agent: row.agent } : {}),
      prompt: row.prompt,
      trigger: formatTrigger(JSON.parse(row.trigger)),
      next: iso(row.next_at),
      to: row.dest,
      timeout: formatDuration(row.timeout_ms),
      run_usd: row.run_usd ?? "off",
      delete_session: !!row.delete_session,
      last_run: last
        ? { id: last.id, state: last.state, started: iso(last.started_at) }
        : null,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    }
  }

  runView(r: any) {
    return {
      id: r.id,
      job: r.job,
      by: r.started_by,
      how:
        r.how ??
        (r.started_by === "owner" ||
        r.started_by === "schedule" ||
        r.started_by === "ask"
          ? r.started_by
          : "agent"),
      ...(r.extra ? { text: r.extra } : {}),
      session: r.session_id ?? null,
      state: r.state,
      reason: r.reason ?? null,
      result: r.result ?? null,
      cost: r.cost ?? 0,
      started: iso(r.started_at),
      ended: iso(r.ended_at),
      session_kept: r.state === "failed" && !!r.session_id && !r.removed,
      ...(r.result && r.result.length > MAX_RESULT ? { cut: true } : {}),
      ...(r.ask_id ? { ask: r.ask_id } : {}),
      // whom its cost counts for (the owner, 2026-11-09)
      bill_to: r.bill_to ?? `job:${r.job}`,
    }
  }

  set(nameInput: unknown, body: any) {
    const name = checkId(nameInput, "job name")
    if (!body || typeof body !== "object")
      throw new AutocodeError("bad_request", "the body must be an object")
    onlyFields(body, [
      "host",
      "description",
      "model",
      "variant",
      "agent",
      "prompt",
      "trigger",
      "to",
      "timeout",
      "run_usd",
      "delete_session",
    ])
    const host = checkId(body.host, "host ID")
    if (!this.db.query("SELECT 1 FROM hosts WHERE id = ?").get(host))
      throw new AutocodeError("unknown_host", `no host ${host}`, 404)
    const text = (v: unknown, what: string, max: number, need = false) => {
      if (v === undefined || v === null || v === "") {
        if (need) throw new AutocodeError("bad_request", `a job needs ${what}`)
        return null
      }
      if (typeof v !== "string" || v.length > max)
        throw new AutocodeError(
          "bad_request",
          `${what} is text of at most ${max} characters`,
        )
      return v
    }
    const description = text(body.description, "a description", 1000) ?? ""
    const model = text(body.model, "a model (provider/model)", 200, true)!
    if (!/^[^/\s]+\/\S+$/.test(model))
      throw new AutocodeError(
        "bad_request",
        "the model is provider/model, like openai/gpt-5",
      )
    const variant = text(body.variant, "a variant", 100)
    const agent = text(body.agent, "an OpenCode agent", 100)
    const prompt = text(body.prompt, "a prompt", MAX_PROMPT, true)!
    if (typeof body.trigger !== "string")
      throw new AutocodeError("bad_trigger", "a job needs a trigger")
    const now = this.d.now()
    const trigger = parseTrigger(body.trigger, { tz: this.d.tz(), now })
    if (trigger.kind === "idle")
      throw new AutocodeError(
        "bad_trigger",
        "a job's trigger is every, at, cron or fire-only",
      )
    const to = String(body.to ?? "owner")
    if (to !== "owner") {
      const parts = parsePattern(to)
      if (!parts?.length) throw new AutocodeError("bad_request", "bad to")
      for (const p of parts)
        if (!p.includes("*")) {
          checkId(p, "destination")
          if (isReservedId(p) && p !== "owner")
            throw new AutocodeError("bad_request", `${p} is reserved`)
        }
    }
    let timeout = DEFAULT_TIMEOUT
    if (body.timeout !== undefined && body.timeout !== null) {
      timeout = parseDuration(body.timeout)
      if (timeout < 60_000 || timeout > 7 * 86_400_000)
        throw new AutocodeError(
          "bad_request",
          "a run's time limit is from 1m to 7d",
        )
    }
    let runUsd: number | null = null
    if (
      body.run_usd !== undefined &&
      body.run_usd !== null &&
      body.run_usd !== "off"
    ) {
      runUsd = Number(body.run_usd)
      if (!Number.isFinite(runUsd) || runUsd <= 0 || runUsd > 10_000)
        throw new AutocodeError(
          "bad_request",
          "run_usd is dollars above 0, or off",
        )
    }
    const deleteSession = body.delete_session !== false
    // an every's runs keep to the time it was set (no drift from late ticks)
    const next = nextRun(trigger, now, { tz: this.d.tz(), anchor: now })
    const before = this.row(name)
    this.db
      .query(
        `INSERT INTO jobs (name, description, host_id, model, variant, agent,
           prompt, trigger, next_at, dest, timeout_ms, run_usd,
           delete_session, created_at, updated_at, anchor_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET description = excluded.description,
           host_id = excluded.host_id, model = excluded.model,
           variant = excluded.variant, agent = excluded.agent,
           prompt = excluded.prompt, trigger = excluded.trigger,
           next_at = excluded.next_at, dest = excluded.dest,
           timeout_ms = excluded.timeout_ms, run_usd = excluded.run_usd,
           delete_session = excluded.delete_session,
           updated_at = excluded.updated_at, anchor_at = excluded.anchor_at`,
      )
      .run(
        name,
        description,
        host,
        model,
        variant,
        agent,
        prompt,
        JSON.stringify(trigger),
        next,
        to,
        timeout,
        runUsd,
        deleteSession ? 1 : 0,
        now,
        now,
        now,
      )
    this.d.history.record("job.set", {
      data: { name, trigger: formatTrigger(trigger), replaced: !!before },
    })
    return { status: before ? 200 : 201, job: this.view(this.row(name)) }
  }

  list() {
    return (
      this.db.query("SELECT * FROM jobs ORDER BY name").all() as any[]
    ).map((r) => this.view(r))
  }

  // What agents see of the jobs: names and descriptions.
  listForAgents() {
    return (
      this.db
        .query("SELECT name, description FROM jobs ORDER BY name")
        .all() as any[]
    ).map((r) => ({ name: r.name, description: r.description }))
  }

  remove(nameInput: unknown) {
    const name = checkId(nameInput, "job name")
    if (!this.row(name))
      throw new AutocodeError("no_job", `no job ${name}`, 404)
    this.db.query("DELETE FROM jobs WHERE name = ?").run(name)
    this.d.history.record("job.deleted", { data: { name } })
    return { deleted: name }
  }

  runs(job?: string | null) {
    return (
      (job
        ? this.db
            .query("SELECT * FROM runs WHERE job = ? ORDER BY started_at DESC")
            .all(job)
        : this.db
            .query("SELECT * FROM runs ORDER BY started_at DESC LIMIT 500")
            .all()) as any[]
    ).map((r) => this.runView(r))
  }

  private active(job: string): any {
    return this.db
      .query(
        "SELECT * FROM runs WHERE job = ? AND state IN ('starting', 'running')",
      )
      .get(job)
  }

  // Whether a job can take a run now (an ask routed to it, tier 0d).
  idle(job: string): boolean {
    return !!this.row(job) && !this.active(job)
  }

  /*
   * Starts a run: by the owner, an agent (its ID in `by`), the schedule, or
   * an ask (its ID in `ask`). Refused while another runs (or one started
   * this minute), except a scheduled one, which is recorded as skipped.
   */
  start(
    nameInput: unknown,
    how: How,
    by: string,
    text?: unknown,
    ask?: string,
  ) {
    const name = checkId(nameInput, "job name")
    const job = this.row(name)
    if (!job) throw new AutocodeError("no_job", `no job ${name}`, 404)
    const extra =
      text === undefined || text === null || text === ""
        ? null
        : String(text).slice(0, 4000)
    const now = this.d.now()
    const id = `${name}:${new Date(now).toISOString().slice(0, 16)}`
    const busy = this.active(name)
    const skip = (reason: string) => {
      this.db
        .query(
          `INSERT OR IGNORE INTO runs (id, job, started_by, how, state,
             reason, started_at, ended_at)
           VALUES (?, ?, 'schedule', 'schedule', 'skipped', ?, ?, ?)`,
        )
        .run(`${id}:skipped`, name, reason, now, now)
      this.d.history.record("run.skipped", { data: { job: name, reason } })
      return undefined
    }
    if (busy) {
      if (how === "schedule") return skip(`${busy.id} still works`)
      throw new AutocodeError(
        "job_busy",
        `job ${name} is running: ${busy.id}, started by ${this.starter(busy)}`,
        409,
      )
    }
    if (this.runRow(id)) {
      if (how === "schedule") return skip(`${id} was started this minute`)
      throw new AutocodeError(
        "job_busy",
        `a run ${id} was started this minute; try again in a minute`,
        409,
      )
    }
    this.db
      .query(
        `INSERT INTO runs (id, job, started_by, how, extra, state,
           started_at, ask_id, bill_to)
         VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?)`,
      )
      .run(
        id,
        name,
        by,
        how,
        extra,
        now,
        ask ?? null,
        this.billTo(job, how, by, ask),
      )
    this.d.history.record("run.started", {
      data: { id, job: name, by, how },
    })
    this.spawn(this.runRow(id), job)
    return this.runView(this.runRow(id))
  }

  /*
   * Whom a run's cost counts for (the owner, 2026-11-09, rc2): the agent
   * that set its job; else the agent that started it, or the one that asked
   * (an ask's run); a run started by a run, or asking, counts for whom that
   * run counts for; else (the owner, a schedule) the job's own row.
   */
  private billTo(job: any, how: How, by: string, ask?: string): string {
    const up = (id: string | null): string | null => {
      if (!id) return null
      const parent = this.runRow(id)
      return parent ? (parent.bill_to ?? `job:${parent.job}`) : id
    }
    if (job.created_by) return job.created_by
    if (how === "agent") return up(by) ?? `job:${job.name}`
    if (how === "ask")
      return up(ask ? this.d.askedBy(ask) : null) ?? `job:${job.name}`
    return `job:${job.name}`
  }

  // Who started a run, in words.
  private starter(run: any): string {
    const how = run.how ?? run.started_by
    return how === "owner"
      ? "the owner"
      : how === "schedule"
        ? "its schedule"
        : how === "ask"
          ? "an ask"
          : `agent ${run.started_by}`
  }

  /*
   * Sends the spawn when the job's host is online; an offline host on this
   * machine is loaded again first (an unloaded folder), and the run waits.
   */
  private spawn(run: any, job: any) {
    const host = this.db
      .query("SELECT online FROM hosts WHERE id = ?")
      .get(job.host_id) as any
    if (!host?.online) {
      try {
        this.d.load(job.host_id)
      } catch {}
      return
    }
    const instruction = this.d.enqueue(job.host_id, "spawn", {
      run: run.id,
      title: run.id,
      model: job.model,
      ...(job.variant ? { variant: job.variant } : {}),
      ...(job.agent ? { agent: job.agent } : {}),
    })
    this.db
      .query(
        "UPDATE runs SET instruction_id = ?, spawn_host = ?, " +
          "spawned_at = ? WHERE id = ?",
      )
      .run(instruction, job.host_id, this.d.now(), run.id)
  }

  // Where a run's result goes: the starting agent, else the job's.
  private dest(run: any, job: any): string {
    if ((run.how ?? "agent") === "agent") return run.started_by
    return job?.dest ?? "owner"
  }

  private prompt(run: any, job: any): string {
    const who = this.starter(run)
    const dest = this.dest(run, job)
    const parts = [job.prompt]
    if (run.extra) {
      const quoted = String(run.extra)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")
      parts.push(`Added by ${who}:\n${quoted}`)
    }
    if (run.ask_id) {
      const ask = this.d.askText(run.ask_id)
      if (ask) parts.push(ask)
    }
    parts.push(
      `— You are the run ${run.id} of job ${job.name}, started by ` +
        "Autocode. End it with autocode_me action=finish result=<your " +
        `result>; the result goes to ${dest === "owner" ? "the owner" : dest}.`,
    )
    return parts.join("\n\n")
  }

  // The scheduler's part: spawns settle and limits are checked first, then
  // due jobs start (a run that just failed no longer counts as working).
  tick() {
    const now = this.d.now()
    for (const run of this.db
      .query("SELECT * FROM runs WHERE state = 'starting'")
      .all() as any[]) {
      const job = this.row(run.job)
      const limit = job?.timeout_ms ?? DEFAULT_TIMEOUT
      // no spawn yet: its host was offline; it waits up to the time limit
      if (!run.instruction_id) {
        if (now - run.started_at >= limit)
          this.fail(run, "the session could not start: its host is offline")
        else if (job) this.spawn(run, job)
        continue
      }
      const done = this.d.instruction(run.instruction_id)
      if (done?.acked) {
        const session = done.ok ? String(done.result?.session ?? "") : ""
        if (!session) {
          this.fail(
            run,
            `the session could not start: ${done.error ?? "no session"}`,
          )
          continue
        }
        const host = run.spawn_host ?? job?.host_id
        try {
          if (host) this.d.noteSession(host, session)
          this.d.register(run.id, session, `run of job ${run.job}`)
        } catch (err) {
          this.db
            .query("UPDATE runs SET session_id = ? WHERE id = ?")
            .run(session, run.id)
          this.fail(
            this.runRow(run.id),
            `could not register: ${(err as Error).message}`,
          )
          continue
        }
        this.db
          .query(
            "UPDATE runs SET state = 'running', session_id = ? WHERE id = ?",
          )
          .run(session, run.id)
        if (job && host)
          this.d.enqueue(host, "inject", {
            session,
            prompt_id: promptId(now),
            text: this.prompt(this.runRow(run.id), job),
          })
      } else if (!done) {
        // the instruction went (expired): send it again
        this.db
          .query("UPDATE runs SET instruction_id = NULL WHERE id = ?")
          .run(run.id)
      } else if (now - (run.spawned_at ?? run.started_at) > SPAWN_GRACE)
        this.fail(run, "the session could not start: the host did not answer")
    }
    for (const run of this.db
      .query("SELECT * FROM runs WHERE state = 'running'")
      .all() as any[]) {
      const job = this.row(run.job)
      const limit = job?.timeout_ms ?? DEFAULT_TIMEOUT
      if (now - run.started_at >= limit) {
        const host = this.hostOf(run, job)
        if (host && run.session_id)
          this.d.enqueue(host, "interrupt", { session: run.session_id })
        this.fail(run, `time limit (${formatDuration(limit)})`)
      }
    }
    for (const job of this.db
      .query("SELECT * FROM jobs WHERE next_at IS NOT NULL AND next_at <= ?")
      .all(now) as any[]) {
      const t = JSON.parse(job.trigger) as Trigger
      const next =
        t.kind === "at"
          ? null
          : nextRun(t, now, {
              tz: this.d.tz(),
              anchor: job.anchor_at ?? job.created_at ?? now,
            })
      this.db
        .query("UPDATE jobs SET next_at = ? WHERE name = ?")
        .run(next, job.name)
      try {
        this.start(job.name, "schedule", "schedule")
      } catch {}
    }
    /*
     * A spawn that answered after its run failed: the session it made is
     * removed (nothing else knows it).
     */
    for (const run of this.db
      .query(
        "SELECT * FROM runs WHERE state = 'failed' AND session_id IS NULL " +
          "AND instruction_id IS NOT NULL AND removed = 0",
      )
      .all() as any[]) {
      const done = this.d.instruction(run.instruction_id)
      if (!done) {
        this.db.query("UPDATE runs SET removed = 1 WHERE id = ?").run(run.id)
        continue
      }
      if (!done.acked) continue
      const session = done.ok ? String(done.result?.session ?? "") : ""
      if (session && run.spawn_host)
        this.d.enqueue(run.spawn_host, "remove", { session })
      this.db.query("UPDATE runs SET removed = 1 WHERE id = ?").run(run.id)
    }
  }

  // The host of a run's session (where it was spawned).
  private hostOf(run: any, job: any): string | null {
    return (
      (
        this.db
          .query("SELECT host_id FROM sessions WHERE id = ?")
          .get(run.session_id ?? "") as any
      )?.host_id ??
      run.spawn_host ??
      job?.host_id ??
      null
    )
  }

  // The host's sessions that are runs now (told at its hello: the plugin
  // reports their last replies).
  runSessionsOf(host: string): string[] {
    return (
      this.db
        .query(
          `SELECT r.session_id FROM runs r
           JOIN sessions s ON s.id = r.session_id
           WHERE r.state = 'running' AND s.host_id = ? ORDER BY r.session_id`,
        )
        .all(host) as any[]
    ).map((r) => r.session_id)
  }

  /*
   * A turn of a run's session ended: a finished run's session is removed now
   * (delete_session); past run_usd the run fails; idle with its last reply
   * and nothing pending, it succeeds.
   */
  turnEnded(agent: string, reply: string | null, pending: boolean) {
    this.removePending(agent)
    const run = this.db
      .query("SELECT * FROM runs WHERE id = ? AND state = 'running'")
      .get(agent) as any
    if (!run) return
    const job = this.row(run.job)
    const spent = this.d.spent(agent)
    this.db.query("UPDATE runs SET cost = ? WHERE id = ?").run(spent, run.id)
    if (job?.run_usd && spent > job.run_usd) {
      this.fail(
        this.runRow(run.id),
        `run cap ($${spent.toFixed(2)} of $${Number(job.run_usd).toFixed(2)})`,
      )
      return
    }
    if (!pending && reply) this.succeed(this.runRow(run.id), reply)
  }

  // A run's turn failed and will not be retried (or retries ran out).
  turnsFailed(agent: string, reason: string) {
    const run = this.db
      .query("SELECT * FROM runs WHERE id = ? AND state = 'running'")
      .get(agent) as any
    if (run) this.fail(run, reason)
  }

  // A run's session whose removal waits for its last turn's end.
  private removePending(id: string) {
    const run = this.db
      .query("SELECT * FROM runs WHERE id = ? AND remove_pending = 1")
      .get(id) as any
    if (!run) return
    this.removeSession(run)
  }

  private removeSession(run: any) {
    const host = this.hostOf(run, this.row(run.job))
    if (host && run.session_id)
      this.d.enqueue(host, "remove", { session: run.session_id })
    this.db
      .query("UPDATE runs SET removed = 1, remove_pending = 0 WHERE id = ?")
      .run(run.id)
  }

  // A turn of a session ended; when it was a finished run's, its removal.
  sessionTurnEnded(session: string) {
    const run = this.db
      .query("SELECT * FROM runs WHERE session_id = ? AND remove_pending = 1")
      .get(session) as any
    if (run) this.removeSession(run)
  }

  // autocode_me finish.
  finish(agent: string, body: any) {
    if (!body || typeof body !== "object")
      throw new AutocodeError("bad_request", "the body must be an object")
    onlyFields(body, ["result"])
    const run = this.db
      .query("SELECT * FROM runs WHERE id = ? AND state = 'running'")
      .get(agent) as any
    if (!run)
      throw new AutocodeError(
        "not_a_run",
        `${agent} is not a run of a job`,
        409,
      )
    if (typeof body.result !== "string" || !body.result.trim())
      throw new AutocodeError("bad_request", "finish needs a result")
    this.succeed(run, body.result)
    return { finished: run.id }
  }

  private succeed(run: any, result: string) {
    const job = this.row(run.job)
    // the whole result stays in the run; the message is cut
    const whole = result.slice(0, 1_000_000)
    this.db
      .query(
        "UPDATE runs SET state = 'succeeded', result = ?, ended_at = ?, " +
          "cost = ? WHERE id = ?",
      )
      .run(whole, this.d.now(), this.d.spent(run.id), run.id)
    this.d.history.record("run.finished", {
      data: { id: run.id, job: run.job, result: whole.slice(0, 2000) },
    })
    try {
      this.d.tell(
        this.dest(run, job),
        `result of run ${run.id}`,
        whole.slice(0, MAX_RESULT) +
          (whole.length > MAX_RESULT
            ? "\n\n(cut; the whole result is in the run: autocode job runs " +
              `${run.job} --json, or the Jobs page)`
            : ""),
      )
    } catch {}
    this.end(run, !!job?.delete_session)
  }

  private fail(run: any, reason: string) {
    const job = this.row(run.job)
    this.db
      .query(
        "UPDATE runs SET state = 'failed', reason = ?, ended_at = ?, " +
          "cost = ? WHERE id = ?",
      )
      .run(reason, this.d.now(), this.d.spent(run.id), run.id)
    this.d.history.record("run.failed", {
      data: { id: run.id, job: run.job, reason },
    })
    const dest = this.dest(run, job)
    if (dest !== "owner")
      try {
        this.d.tell(dest, `run ${run.id} failed`, `It failed: ${reason}.`)
      } catch {}
    const session = this.runRow(run.id)?.session_id
    this.d.alert(
      `Run ${run.id} failed: ${reason}`,
      session
        ? `Its session ${session} is kept for you to look at; delete it on ` +
            `the Jobs page or with autocode job delete-session ${run.id}.`
        : "No session was made.",
    )
    // a failed run's session is kept until the owner deletes it
    this.end(run, false)
  }

  /*
   * A run ended: its agent goes (when registered), the asks sent to it go to
   * the owner, and with delete_session its session is removed once the turn
   * that ended it ends (at once when no turn runs).
   */
  private end(run: any, remove: boolean) {
    const r = this.runRow(run.id)
    // only while the ID is the run's (another session may hold it)
    const holder = (
      this.db
        .query("SELECT session_id FROM agents WHERE id = ?")
        .get(run.id) as any
    )?.session_id
    if (holder && holder === r?.session_id) {
      try {
        this.d.unregister(run.id)
      } catch {}
      try {
        this.d.released(run.id)
      } catch {}
    }
    if (!remove || !r?.session_id) return
    const busy = !!(
      this.db
        .query("SELECT busy FROM sessions WHERE id = ?")
        .get(r.session_id) as any
    )?.busy
    if (busy)
      this.db
        .query("UPDATE runs SET remove_pending = 1 WHERE id = ?")
        .run(run.id)
    else this.removeSession(r)
  }

  // The owner deletes a kept failed run's session.
  deleteSession(id: string) {
    const run = this.runRow(id)
    if (!run) throw new AutocodeError("no_run", `no run ${id}`, 404)
    if (run.state === "starting" || run.state === "running")
      throw new AutocodeError(
        "run_running",
        `run ${id} is still running; its session goes when it ends`,
        409,
      )
    if (!run.session_id || run.removed)
      throw new AutocodeError(
        "no_session",
        `run ${id} has no session kept`,
        409,
      )
    const host = this.hostOf(run, this.row(run.job))
    if (!host) throw new AutocodeError("no_host", "its host is gone", 409)
    this.removeSession(run)
    this.d.history.record("run.session_deleted", { data: { id } })
    return { deleted: run.session_id }
  }

  // The run an ask started (tier 0d's job:<name>).
  runForAsk(ask: string): string | null {
    return (
      (
        this.db
          .query(
            "SELECT id FROM runs WHERE ask_id = ? ORDER BY started_at DESC",
          )
          .get(ask) as any
      )?.id ?? null
    )
  }

  trim(days: number) {
    this.db
      .query("DELETE FROM runs WHERE ended_at IS NOT NULL AND ended_at < ?")
      .run(this.d.now() - days * 86_400_000)
  }
}
