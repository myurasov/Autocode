/*
 * The agent tools: autocode_me (register, unregister, status, discover,
 * help; compact: tier 0e; jobs, run, finish: tier 0f), autocode_wake (set,
 * list, show, cancel, fire), autocode_message (send, text only; answer,
 * escalate: tier 0d; messages come whole in prompts: Phase 1),
 * autocode_lock (acquire, renew, release, list: tier 0c) and
 * autocode_approval (ask, wait: tier 0d). Their
 * descriptions say enough to use them without the guide (OpenCode sends them
 * with every model call); their results say when things will happen, in the
 * server's zone and from now.
 */

import { localTime, parseDuration } from "@autocode/shared"

export interface MeInput {
  action:
    | "register"
    | "unregister"
    | "status"
    | "discover"
    | "help"
    | "compact"
    | "jobs"
    | "run"
    | "finish"
    | "job_set"
    | "job_delete"
    | "rename"
  job?: string
  text?: string
  // job_set (the owner, 2026-11-09: agents set jobs of their own)
  model?: string
  prompt?: string
  trigger?: string
  run_usd?: number
  host?: string
  to?: string
  timeout?: string
  variant?: string
  opencode_agent?: string
  keep_session?: boolean
  result?: string
  id?: string
  description?: string
  pattern?: string
  topic?: string
}

export const ME_TOOL = {
  name: "autocode_me",
  description:
    "Autocode links OpenCode sessions as agents that wake on schedules and " +
    "message each other. Use the autocode_* tools, not the autocode CLI " +
    "(that is for scripts). Actions: register (id, description), " +
    "unregister, status (your registration, the server's time and zone, " +
    "your wakes, messages waiting, locks, open asks, what you have open " +
    "in the owner's Inbox, spend and context), " +
    "discover " +
    "(pattern), help (topic: the exact rules for wakes, checks, delivery, " +
    "messages, writing to the owner, locks, asks, costs, jobs, prompts, " +
    "scripts), compact " +
    "(compact " +
    "your session after this turn), jobs (the jobs you can run), run (job, " +
    "text: start a run; its result comes to you), finish (result: a run of " +
    "a job ends with it), job_set (job, model, prompt, trigger, run_usd; " +
    "optional host, to, timeout, variant, opencode_agent, keep_session, " +
    "description: set a job of your own, <your ID>:<job>; the owner may " +
    "approve it first; its runs' cost counts for you), job_delete (job: " +
    "one of yours), rename (id: a new ID for you; everything of yours " +
    "comes along).",
  input: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "register",
          "unregister",
          "status",
          "discover",
          "help",
          "compact",
          "jobs",
          "run",
          "finish",
          "job_set",
          "job_delete",
          "rename",
        ],
      },
      job: {
        type: "string",
        description:
          "run, job_set, job_delete: the job's name (yours: <your ID>:<name>; " +
          "the prefix is added)",
      },
      model: {
        type: "string",
        description: "job_set: provider/model for its runs",
      },
      prompt: {
        type: "string",
        description: "job_set: what each run is told (self-contained)",
      },
      trigger: {
        type: "string",
        description:
          'job_set: every 1h | at 09:00 | cron "0 9 * * 1-5" | fire-only ' +
          "(run it with action=run)",
      },
      run_usd: {
        type: "number",
        description: "job_set (required): the most dollars a run may spend",
      },
      host: {
        type: "string",
        description: "job_set: where it runs (default: your own folder)",
      },
      to: {
        type: "string",
        description: "job_set: who gets results (default: you)",
      },
      timeout: {
        type: "string",
        description: "job_set: a run's time limit, 1m to 7d (default 1h)",
      },
      variant: { type: "string", description: "job_set: the model's variant" },
      opencode_agent: {
        type: "string",
        description: "job_set: the OpenCode agent its runs use",
      },
      keep_session: {
        type: "boolean",
        description: "job_set: keep each run's session (default: removed)",
      },
      text: {
        type: "string",
        description: "run: added to the job's prompt, marked as yours",
      },
      result: {
        type: "string",
        description: "finish: your run's result, for whom it goes to",
      },
      id: {
        type: "string",
        description:
          "register: your agent ID, like project:role:name (letters, " +
          "digits, - _ . :); rename: your new ID",
      },
      description: {
        type: "string",
        description:
          "register: what you do, in a sentence; job_set: what the job does",
      },
      pattern: {
        type: "string",
        description: "discover: which agents, like team:* (default *)",
      },
      topic: {
        type: "string",
        description:
          "help: overview, delivery, wakes, checks, recipes, messages, " +
          "owner, locks, asks, costs, jobs, prompts, scripts, trouble, or " +
          "all (the default)",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
}

export type Call = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<any>

// "in 45m", "in 2h 5m", "in 3d 2h", or "now".
export function fromNow(at: number, now: number): string {
  const minutes = Math.round((at - now) / 60_000)
  if (minutes <= 0) return "now"
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
  const days = Math.floor(hours / 24)
  return `in ${days}d${hours % 24 ? ` ${hours % 24}h` : ""}`
}

// The server's clock and zone from GET /v1/me, for telling times.
interface Clock {
  now: number
  tz: string
}

function clockOf(me: any): Clock {
  return {
    now: me?.server?.time ? Date.parse(me.server.time) : Date.now(),
    tz: me?.server?.timezone || "UTC",
  }
}

// "2026-11-03 08:00 PST (in 45m)"
function when(iso: string, c: Clock): string {
  const at = Date.parse(iso)
  return `${localTime(at, c.tz)} (${fromNow(at, c.now)})`
}

function serverLine(me: any, c: Clock): string[] {
  if (!me?.server) return []
  return [
    `Server ${me.server.id}; its time ${localTime(c.now, c.tz)} (${c.tz}).`,
  ]
}

function agentLine(a: any): string {
  const desc = a.description ? `  ${a.description}` : ""
  return `${a.id}  ${a.status}  last active ${a.last_active}${desc}`
}

/*
 * An agent in the error state (tier 0b3): its last turn failed; what
 * Autocode does about it.
 */
function errorLine(a: any, me: any, c: Clock): string {
  const e = a.error ?? {}
  const at = localTime(Date.parse(e.at), c.tz)
  const since =
    e.since && e.since !== e.at
      ? `, failing since ${localTime(Date.parse(e.since), c.tz)}`
      : ""
  const head =
    `Status error: your last turn failed (${e.type}) ` + `at ${at}${since}.`
  const wait = "your wakes and messages wait until a turn succeeds."
  if (!e.retryable)
    return `${head} It is not retried (the owner is told); ${wait}`
  if (!e.next_retry)
    return (
      `${head} Autocode stopped after ${e.retries} retries (the owner is ` +
      `told); ${wait}`
    )
  // Phase 2: a blocked reply's next step
  if (e.recovery === "retry")
    return (
      `${head} The provider's content filter blocked your last reply: ` +
      `Autocode retries once at ${when(e.next_retry, c)}; write it in ` +
      "other, shorter words, long text in a file. Your wakes and messages " +
      "come with it."
    )
  if (e.recovery === "compact")
    return (
      `${head} Blocked again: Autocode compacts this session at ` +
      `${when(e.next_retry, c)}, then retries; save what you need to files.`
    )
  const max = Number(me?.settings?.retry_attempts) || 0
  return (
    `${head} Autocode sends a retry prompt every ` +
    `${me?.settings?.retry_interval ?? "1m"} (${e.retries} sent, ` +
    `${max ? `at most ${max}` : "no limit"}); the next at ` +
    `${when(e.next_retry, c)}. Your wakes and messages come with it.`
  )
}

function statusLine(a: any, me?: any, c?: Clock): string {
  if (a.status === "error" && a.error && c) return errorLine(a, me, c)
  if (a.status === "paused" && a.paused === "cap")
    return (
      "Status paused by your daily cost cap: nothing is delivered until " +
      "tomorrow (the server's zone) or until the owner raises the cap."
    )
  if (a.status === "paused")
    return (
      `Status paused by ${a.paused === "stop-all" ? "Stop All" : "the owner"}` +
      ": nothing is delivered until the owner resumes you."
    )
  if (a.status === "offline")
    return "Status offline: your OpenCode server is not connected to Autocode."
  return `Status ${a.status} on machine ${a.machine}.`
}

export interface MeDeps {
  // The guide, whole or one topic (guide.ts).
  guide?: (topic?: string) => string
}

export async function runMe(
  input: MeInput,
  call: Call,
  deps: MeDeps = {},
): Promise<string> {
  switch (input?.action) {
    case "register": {
      if (!input.id)
        return "error: register needs an id, like project:role:name"
      const res = await call("POST", "/v1/agents", {
        id: input.id,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
      })
      return (
        `Registered as ${res.agent.id} (status ${res.agent.status}). ` +
        "How Autocode works: autocode_me action=help."
      )
    }
    case "unregister": {
      const res = await call("DELETE", "/v1/me")
      return (
        `Unregistered ${res.unregistered}; your wakes are removed and ` +
        "your locks released."
      )
    }
    // in place (1.1.0): the agent stays what it is, under a new ID
    case "rename": {
      if (!input.id) return "error: rename needs id, your new agent ID"
      const res = await call("POST", "/v1/me/rename", { id: input.id })
      return (
        `Renamed: you are ${res.agent.id} now. Your wakes, waiting ` +
        "messages, locks, spend, settings and jobs came along; your " +
        "session's title follows. A message sent to your old ID still " +
        "reaches you."
      )
    }
    case "status": {
      const me = await call("GET", "/v1/me")
      const c = clockOf(me)
      const help = "How Autocode works: autocode_me action=help."
      if (!me.registered)
        return [
          "Not registered. Register with action=register and an id like " +
            "project:role:name.",
          ...serverLine(me, c),
          help,
        ].join("\n")
      const a = me.agent
      const lines = [
        `Registered as ${a.id}${a.description ? `: ${a.description}` : ""}.`,
        statusLine(a, me, c),
        ...serverLine(me, c),
      ]
      const set = me.settings
      if (set)
        lines.push(
          "Delivery: only while this session is idle, at most once per " +
            `${set.min_interval}; messages come whole, into a running turn ` +
            "at its next step.",
        )
      const w = me.wakes
      if (w)
        lines.push(
          !w.count
            ? "Wakes: none."
            : w.next
              ? `Wakes: ${w.count}; next "${w.next.name}" at ` +
                `${when(w.next.due, c)}. See autocode_wake list.`
              : `Wakes: ${w.count}; none due at a known time. ` +
                "See autocode_wake list.",
        )
      /*
       * Whether its wakes need anyone's word (wake_mode, 1.1.0-rc5). The
       * default says so too: agents read its old name, `approve`, as
       * "needs approval" and asked the owner (the owner, 2026-11-22); it is
       * `allow` since 1.1.0-rc6, and `off` is `deny`.
       */
      if (set?.wake_mode === "ask" || set?.wake_mode === "deny")
        lines.push(
          "Periodic wakes (every, cron, idle): " +
            (set.wake_mode === "ask"
              ? "the owner approves each one first (wake_mode ask)."
              : "you cannot set them (wake_mode deny)."),
        )
      else if (set?.wake_mode === "allow")
        lines.push(
          "Wakes: you set them yourself, at once; no approval is needed " +
            "(wake_mode allow).",
        )
      // how many messages wait (for a prompt, a steer or a read)
      if (me.waiting !== undefined)
        lines.push(
          me.waiting
            ? `Messages waiting: ${me.waiting}. See autocode_message list ` +
                "or read."
            : "Messages waiting: none.",
        )
      // spend today and in total, the cap and what is left, the context and
      // its share of the compaction threshold (tiers 0e, 0g)
      if (me.cost) lines.push(costLine(me.cost), ...splitLines(me.cost))
      // open questions, permissions and approvals (tier 0d)
      if (me.asks?.length)
        lines.push(
          `Waiting on: ${me.asks
            .map((a: any) => `${a.kind} ${a.id} (${a.title})`)
            .join("; ")}. Your wakes and messages wait until they close.` +
            (me.asks.some((a: any) => a.kind === "approval")
              ? " An approval that no longer matters: autocode_approval " +
                "action=close id=ID."
              : ""),
        )
      // its open messages and reports in the owner's Inbox, to close what
      // no longer matters (1.1.0-rc4)
      if (me.inbox?.length) {
        const shown = me.inbox.slice(0, OPEN_SHOWN).map((i: any) => {
          const subject = /: "(.*)"$/s.exec(String(i.title))?.[1]
          const cut =
            subject && subject.length > SUBJECT_SHOWN
              ? `${subject.slice(0, SUBJECT_SHOWN - 1)}…`
              : subject
          return (
            `${i.kind} ${i.id}${cut ? ` "${cut}"` : ""} (sent ` +
            `${localTime(Date.parse(i.created_at), c.tz)})`
          )
        })
        const more = me.inbox.length - shown.length
        lines.push(
          `Open in the owner's Inbox: ${shown.join("; ")}` +
            `${more > 0 ? `; and ${more} more` : ""}. One that no longer ` +
            "matters (the owner answered in the session, things changed): " +
            "autocode_message action=close id=ID.",
        )
      }
      const l = me.locks
      if (l && (l.held.length || l.queued.length)) {
        const until = (iso: string) =>
          `${localTime(Date.parse(iso), c.tz)}, ` +
          fromNow(Date.parse(iso), c.now)
        const parts = [
          ...l.held.map(
            (h: any) => `you hold "${h.name}" (until ${until(h.expires)})`,
          ),
          ...l.queued.map(
            (q: any) =>
              `you wait for "${q.name}" (number ${q.position} in the queue)`,
          ),
        ]
        lines.push(`Locks: ${parts.join("; ")}. See autocode_lock list.`)
      }
      lines.push(help)
      return lines.join("\n")
    }
    case "discover": {
      const pattern = input.pattern?.trim() || "*"
      const res = await call(
        "GET",
        `/v1/agents?match=${encodeURIComponent(pattern)}`,
      )
      if (!res.agents.length) return `No agents match ${pattern}.`
      return res.agents.map(agentLine).join("\n")
    }
    case "jobs": {
      const res = await call("GET", "/v1/jobs")
      if (!res.jobs.length) return "No jobs. The owner defines them."
      return [
        "Jobs you can run (autocode_me action=run job=NAME text=...):",
        ...res.jobs.map(
          (j: any) => `${j.name}${j.description ? `: ${j.description}` : ""}`,
        ),
      ].join("\n")
    }
    case "run": {
      if (!input.job) return "error: run needs the job's name"
      const res = await call(
        "POST",
        `/v1/jobs/${encodeURIComponent(input.job)}/run`,
        input.text ? { text: input.text } : {},
      )
      return (
        `Started run ${res.run.id}; its result comes to you as a message ` +
        "from autocode (result of run ...)."
      )
    }
    case "job_set": {
      if (
        !input.job ||
        !input.model ||
        !input.prompt ||
        !input.trigger ||
        input.run_usd === undefined
      )
        return (
          "error: job_set needs job (its name), model, prompt, trigger and " +
          "run_usd"
        )
      const body: Record<string, unknown> = {
        name: input.job,
        model: input.model,
        prompt: input.prompt,
        trigger: input.trigger,
        run_usd: input.run_usd,
      }
      if (input.host) body.host = input.host
      if (input.to) body.to = input.to
      if (input.timeout) body.timeout = input.timeout
      if (input.variant) body.variant = input.variant
      if (input.opencode_agent) body.agent = input.opencode_agent
      if (input.keep_session) body.delete_session = false
      if (input.description) body.description = input.description
      const res = await call("POST", "/v1/me/jobs", body)
      if (res.state === "set")
        return (
          `Job ${res.name} is set. Run it with autocode_me action=run ` +
          `job=${res.name}; every run's cost counts for you.`
        )
      return (
        `Job ${res.name} is with the owner for approval (${res.approval}): ` +
        "it exists once approved, and a notice tells you (approval " +
        `"Job ${res.name}" approved or rejected). Go on with your work.`
      )
    }
    case "job_delete": {
      if (!input.job) return "error: job_delete needs the job's name"
      const res = await call(
        "DELETE",
        `/v1/me/jobs/${encodeURIComponent(input.job)}`,
      )
      return `Deleted the job ${res.deleted}.`
    }
    case "finish": {
      if (!input.result) return "error: finish needs your result"
      const res = await call("POST", "/v1/me/finish", {
        result: input.result,
      })
      return (
        `Finished run ${res.finished}; the result is on its way. Your ` +
        "session ends now: stop here."
      )
    }
    case "compact":
      await call("POST", "/v1/me/compact")
      return (
        "Your session is compacted after this turn ends (a summary " +
        "replaces the conversation; keep your state in files)."
      )
    case "help":
      return deps.guide
        ? deps.guide(input.topic)
        : "error: the guide is not available here"
    default:
      return (
        "error: action must be register, unregister, status, discover, " +
        "help, compact, jobs, run, finish, job_set or job_delete"
      )
  }
}

export interface WakeInput {
  action: "set" | "list" | "show" | "cancel" | "fire"
  name?: string
  text?: string
  trigger?: string
  check?: string
  check_timeout?: string
  agent?: string
}

export const WAKE_TOOL = {
  name: "autocode_wake",
  description:
    "Autocode wakes: a prompt Autocode types into your session later (a " +
    "user message starting with [autocode]), only while the session is " +
    "idle (never into a running turn) and at most once per min_interval. " +
    "Actions: set (name, trigger, text; optional check, check_timeout; " +
    "the same name replaces the wake; it is set at once and you ask " +
    "nobody, unless autocode_me status says that the owner approves " +
    "periodic wakes first), list (when each falls due next, " +
    "what each cost in the last 7 days), show (name), " +
    "cancel (name), fire (agent, name, text: deliver now, skipping the " +
    "check). Triggers: every 30m [from 09:00]; in 45m (once); at 09:00 or " +
    'at 2026-11-30 18:00 (once); cron "*/30 8-16 * * 1-5" [zone]; idle 30m ' +
    "[repeat] (after that long idle, counted from your last turn's end); " +
    "fire-only (a job you start fires it by ending with: autocode fire me " +
    "NAME); fire-only once (the same, removed once it is fired). every, " +
    "cron and idle may end: add until 2027-03-01 (through that day) or " +
    "until 2027-03-01 18:00; at its end the wake is removed and a notice " +
    "tells you. Times are in the server's zone (see autocode_me status). " +
    "Exact rules: autocode_me action=help topic=wakes.",
  input: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["set", "list", "show", "cancel", "fire"],
      },
      name: {
        type: "string",
        description:
          "the wake's name (letters, digits, - _ . :), like daily-check; " +
          "setting a name again replaces that wake",
      },
      text: {
        type: "string",
        description:
          "set: what you will be told when it runs (what to do, where " +
          "your notes are); fire: your extra text, shown as yours",
      },
      trigger: {
        type: "string",
        description:
          "set: when it runs: every 30m | every 2h from 09:00 | in 45m | " +
          'at 09:00 | at 2026-11-30 18:00 | cron "0 9 * * 1-5" [zone] | ' +
          "idle 30m | idle 30m repeat | fire-only | fire-only once; with " +
          "an end: every 1d until 2027-03-01",
      },
      check: {
        type: "string",
        description:
          "set, optional: a shell command run in your folder when the wake " +
          "is due; exit 0 wakes you with its output, exit 1 skips the run " +
          "(no model call), other exits fail; time limit: the owner's " +
          "check_timeout, 60 s by default, or this wake's check_timeout. " +
          "It may do the routine pass itself and wake you only when " +
          "something needs you",
      },
      check_timeout: {
        type: "string",
        description:
          "set, optional: how long this wake's check may run, like 5m (for " +
          "a check that does the routine pass); at most the owner's " +
          "check_timeout_max, 10m by default",
      },
      agent: {
        type: "string",
        description: "fire: whose wake (default: your own)",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
}

export interface MessageInput {
  action: "send" | "list" | "read" | "wait" | "answer" | "escalate" | "close"
  to?: string
  subject?: string
  text?: string
  reply_to?: string
  id?: string
  from?: string
  seconds?: number
  // to the owner: it needs no answer (1.1.0)
  report?: boolean
}

export const MESSAGE_TOOL = {
  name: "autocode_message",
  description:
    "Autocode messages between agents and the owner. Messages to you come " +
    "whole, in your turn's next step while it runs, else in an injected " +
    "prompt. Actions: send (to: an agent ID, a pattern like team:*, a " +
    "comma list, or owner; subject; text; reply_to; report: true for one " +
    "to the owner that needs no answer), list (what waits for " +
    "you; from, reply_to), read (take what waits now, whole: id, from, " +
    "reply_to; then it is not injected), wait (read that waits for a " +
    "message: seconds, up to max_tool_wait; costs no tokens), answer (id, " +
    "text: answer a question, permission or approval another agent sent " +
    "you), escalate (id, text: say why you cannot; the owner takes it), " +
    "close (id, text: close what you put in the owner's Inbox once it no " +
    "longer matters, as when the owner answered in the session: a message " +
    "or report you sent, or an approval you asked for; text: why, " +
    "required).",
  input: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["send", "list", "read", "wait", "answer", "escalate", "close"],
      },
      to: {
        type: "string",
        description:
          "send: an agent ID (team:b), a pattern (team:*, never you), a " +
          "comma list (a:b,c:d), or owner (the person who runs Autocode)",
      },
      subject: { type: "string", description: "send: a short subject" },
      text: {
        type: "string",
        description:
          "send: the message (at most 32,000 characters; to the owner: " +
          "short, the point first, plain words); answer: the answer; " +
          "escalate: why you cannot answer, in a line or two; close: why " +
          "it no longer matters, in a line",
      },
      reply_to: {
        type: "string",
        description:
          "send: the ID of the message this answers; list, read, wait: only " +
          "the replies to that message",
      },
      id: {
        type: "string",
        description:
          "read, wait: one message's ID; answer, escalate: the ask's ID; " +
          "close: the ID of a message you sent to the owner, or of an " +
          "approval you asked for",
      },
      from: {
        type: "string",
        description:
          "list, read, wait: only messages from this agent (owner, or " +
          "autocode for Autocode's notices)",
      },
      seconds: {
        type: "number",
        description: "wait: at most this long (default 300)",
      },
      report: {
        type: "boolean",
        description:
          "send to owner: true when the message needs no answer or " +
          "decision (what you did or found): the owner's Inbox files it " +
          "as a report",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
}

export interface LockInput {
  action: "acquire" | "renew" | "release" | "list"
  name?: string
  ttl?: string
  max?: number
  mode?: "try" | "queue"
  pattern?: string
}

export const LOCK_TOOL = {
  name: "autocode_lock",
  description:
    "Autocode locks: a named lock shared by agents on every machine, a " +
    "mutex (max 1) or a semaphore (max N places). Actions: acquire (name, " +
    "ttl: required, how long you hold it, like 10m or 6h; max: the " +
    "capacity, set by the acquire that creates it; mode: queue (default: " +
    'wait in the queue; a notice [autocode] lock "NAME" granted comes when ' +
    "it is yours), try (now or refused)), renew (name; ttl), " +
    "release (name: free it, or leave the queue), list (pattern). A hold " +
    "that runs past its ttl is freed, and a notice says so. Exact rules: " +
    "autocode_me action=help topic=locks.",
  input: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["acquire", "renew", "release", "list"],
      },
      name: {
        type: "string",
        description:
          "the lock's name (letters, digits, - _ . :), like gpu:0 or " +
          "data-refresh; shared by every agent on the server",
      },
      ttl: {
        type: "string",
        description:
          "acquire (required), renew (default: the same): how long you " +
          "hold it from the grant, like 10m, 2h, 1d",
      },
      max: {
        type: "number",
        description:
          "acquire: the capacity of a new lock (1 a mutex, the default; N " +
          "a semaphore); leave it out for an existing lock: another " +
          "capacity is refused",
      },
      mode: {
        type: "string",
        enum: ["queue", "try"],
        description:
          "acquire: queue (default; a notice when granted) or try (now or " +
          "refused)",
      },
      pattern: {
        type: "string",
        description: "list: which locks, like gpu:* (default: all)",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
}

export interface ApprovalInput {
  action: "ask" | "wait" | "close"
  text?: string
  options?: string
  expires?: string
  id?: string
  seconds?: number
}

export const APPROVAL_TOOL = {
  name: "autocode_approval",
  description:
    "Autocode approvals: ask the owner (or whom the owner chose) to approve " +
    "something that must not be left to you: a payment, a trade, a " +
    "deployment, deleting data. Actions: ask (text; options: a comma list; " +
    "expires: like 1h, then it counts as rejected), wait (id; seconds: " +
    "hold this call until it is answered, up to max_tool_wait), close (id; " +
    "text: why, required: take back one that no longer matters, as when " +
    "the owner answered in the session; closed is not approved). The answer " +
    'also comes as a notice: [autocode] approval "..." approved or ' +
    "rejected. Until then your wakes and messages wait. Write it short and " +
    "plain: what, why, the options.",
  input: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["ask", "wait", "close"] },
      text: {
        type: "string",
        description:
          "ask: what to approve, the point first, in a sentence or two; " +
          "close: why it no longer matters, in a line",
      },
      options: {
        type: "string",
        description: "ask, optional: choices as a comma list (now, tonight)",
      },
      expires: {
        type: "string",
        description:
          "ask, optional: how long it may wait, like 1h or 2d; then it is " +
          "rejected",
      },
      id: { type: "string", description: "wait, close: the approval's ID" },
      seconds: {
        type: "number",
        description: "wait: at most this long (default 300)",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
}

export const TOOLS = [
  ME_TOOL,
  WAKE_TOOL,
  MESSAGE_TOOL,
  LOCK_TOOL,
  APPROVAL_TOOL,
]

const enc = encodeURIComponent

const PREVIEW = 100

// A wake's text in short: its first 100 characters on one line.
function preview(text: string): string {
  const flat = String(text).replace(/\s+/g, " ")
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW)}…` : flat
}

const idleOf = (trigger: string) =>
  /^idle (\S+)( repeat)?(?: until \S+)?$/.exec(trigger)

// An idle trigger's duration ("30m") in ms; 0 when it cannot be read.
function idleMs(text: string): number {
  try {
    return parseDuration(text)
  } catch {
    return 0
  }
}

// The end of a periodic trigger (1.1.0-rc5), as the server writes it.
const endOf = (trigger: string) =>
  / until (\d{4}-\d\d-\d\dT[\d:.]+Z)$/.exec(trigger)?.[1]

// A trigger as an agent reads it: a one-time `at`, and a periodic trigger's
// end, in the server's zone (the server stores them in UTC; `in 45m`
// becomes an `at`).
function shownTrigger(trigger: string, c: Clock): string {
  const at = /^at (\d{4}-\d\d-\d\dT[\d:.]+Z)$/.exec(trigger)
  if (at) return `at ${localTime(Date.parse(at[1]!), c.tz)}`
  const end = endOf(trigger)
  return end
    ? trigger.slice(0, -end.length) + localTime(Date.parse(end), c.tz)
    : trigger
}

// A turn of the agent's runs now (`busy`; a waiting or paused agent may be
// in one too); older servers say only `working`.
const inTurn = (me: any) => me?.agent?.busy ?? me?.agent?.status === "working"

// When a wake falls due, for list and show.
function timing(w: any, c: Clock, working: boolean): string {
  const trigger = String(w.trigger)
  if (trigger === "fire-only") return "runs only when fired"
  if (trigger === "fire-only once")
    return "runs once, when fired, then it is removed"
  const idle = idleOf(trigger)
  // one with an end has no run at the end or after it
  const left = "no run left before its end"
  if (idle) {
    if (w.due) return `due ${when(w.due, c)} if you stay idle`
    // its next run comes that long after a turn's end at the earliest: with
    // an end before then, none comes
    const end = endOf(trigger)
    if (end && c.now + idleMs(idle[1]!) >= Date.parse(end)) return left
    if (working) return `due ${idle[1]} after this turn ends`
    return (
      "ran in this idle stretch; due again " +
      `${idle[1]} after your next turn ends`
    )
  }
  if (w.next) return `next ${when(w.next, c)}`
  return endOf(trigger) ? left : "no run ahead"
}

const dollars = (n: unknown) => `$${Number(n).toFixed(2)}`
const tokens = (n: unknown) => Number(n).toLocaleString("en-US")

// What status says of the agent's spend and context (tiers 0e, 0g).
function costLine(k: any): string {
  const capped = k.daily_usd !== "off" && k.daily_usd !== undefined
  // of it, the runs it started or whose jobs it set (the owner, 2026-11-09)
  const runsToday = Number(k.runs_today_usd ?? 0)
  const runsTotal = Number(k.runs_total_usd ?? 0)
  const today = runsToday > 0 ? `${dollars(runsToday)} of it your runs'` : ""
  let line =
    `Cost today: ${dollars(k.today_usd)}` +
    (capped
      ? ` of your daily cap of ${dollars(k.daily_usd)}` +
        (k.left_usd !== undefined && k.left_usd !== null
          ? ` (${dollars(k.left_usd)} left${today ? `; ${today}` : ""})`
          : today
            ? ` (${today})`
            : "")
      : ` (no daily cap${today ? `; ${today}` : ""})`) +
    (k.total_usd !== undefined
      ? `; in total ${dollars(k.total_usd)}` +
        (runsTotal > 0 ? ` (${dollars(runsTotal)} your runs')` : "")
      : "") +
    "."
  if (k.context) {
    line += ` Context: ${tokens(k.context)} tokens`
    if (k.context_limit) line += ` of the model's ${tokens(k.context_limit)}`
    // without a known window a share of it is its cap (the final review)
    const unknown = k.context_limit ? "" : "; the model's window is not known"
    if (k.compact_at)
      line +=
        `; compacted past ${tokens(k.compact_at)} (compact_at${unknown})` +
        (k.context_share !== null && k.context_share !== undefined
          ? `: ${k.context_share}% of that`
          : "")
    else if (k.compact_at === null)
      line += "; no compaction threshold (compact_at off)"
    line += "."
  }
  return line
}

/*
 * What status says of today's spend by kind and by cause (1.1.0-rc7; an
 * older server says neither, and a day with no spend has nothing to say):
 * the four kinds' dollars and shares, what could not be split, the
 * Subagents' part and the reload; then the causes with a cent or more.
 */
function splitLines(k: any): string[] {
  const s = k?.today_split
  const total = Number(s?.usd) || 0
  if (!s || total < 0.005) return []
  const share = (usd: unknown) =>
    `${Math.round(((Number(usd) || 0) / total) * 100)}%`
  const kinds: [string, unknown][] = [
    ["cache writes", s.cache_write_usd],
    ["cache reads", s.cache_read_usd],
    ["new input", s.input_usd],
    ["output", s.output_usd],
  ]
  const known = kinds.reduce((n, [, usd]) => n + (Number(usd) || 0), 0)
  const rest = Math.max(0, total - known)
  const none = known < 0.005
  let line = "Today by kind: "
  if (none)
    line +=
      `not split ${dollars(rest)} (100%; the model has no prices in ` +
      "OpenCode's list)."
  else
    line +=
      kinds
        .map(([name, usd]) => `${name} ${dollars(usd)} (${share(usd)})`)
        .join(", ") +
      (rest >= 0.005 ? `; not split ${dollars(rest)} (${share(rest)})` : "") +
      "."
  const sub = Number(s.subagents_usd) || 0
  if (sub >= 0.005) line += ` Your Subagents: ${dollars(sub)} (${share(sub)}).`
  const reload = Number(s.reload_usd) || 0
  if (reload >= 0.005)
    line +=
      " Reloading the context at the start of turns: " +
      `${dollars(reload)} (${share(reload)}).`
  const lines = [line]
  const causes = (Array.isArray(k.today_causes) ? k.today_causes : []).filter(
    (c: any) => (Number(c?.usd) || 0) >= 0.005,
  )
  if (causes.length) {
    // "in 9 turns" for the first that has turns, "in 7" after it; nothing
    // for what is no turn of the session (its jobs' runs, a compaction's
    // own cost)
    let worded = false
    const parts = causes.map((c: any) => {
      const n = Number(c.turns) || 0
      if (n <= 0) return `${c.cause} ${dollars(c.usd)}`
      const word = worded ? "" : ` turn${n === 1 ? "" : "s"}`
      worded = true
      return `${c.cause} ${dollars(c.usd)} in ${n}${word}`
    })
    lines.push(`Today by what started the turn: ${parts.join(", ")}.`)
  }
  return lines
}

/*
 * What a wake cost in the last 7 days (1.1.0): the turns its prompts
 * started and their dollars, and how often it fell due and its check
 * skipped it; "" for a wake with nothing to say yet.
 */
function weekOf(w: any): { turns: string; counts: string } | null {
  const k = w?.week
  if (!k || !(k.due || k.skipped || k.turns || k.usd)) return null
  const n = Number(k.turns) || 0
  // of it, what its turns' first steps cost to load the context
  // (1.1.0-rc7)
  const reload = Number(k.reload_usd) || 0
  return {
    turns:
      `${n} turn${n === 1 ? "" : "s"}, ${dollars(k.usd)}` +
      (reload >= 0.005
        ? `, ${dollars(reload)} of it to reload the context`
        : ""),
    counts: `due ${Number(k.due) || 0}, skipped ${Number(k.skipped) || 0}`,
  }
}

function setBy(w: any, me: any): string {
  if (w.set_by === me?.agent?.id) return "you"
  return w.set_by === "owner" ? "the owner" : `agent ${w.set_by}`
}

// What `set` tells: when the wake runs, its check, and delivery.
function setText(w: any, me: any): string {
  const c = clockOf(me)
  const trigger = String(w.trigger)
  const working = inTurn(me)
  const parts = [`Wake "${w.name}" set: ${shownTrigger(trigger, c)}.`]
  const idle = idleOf(trigger)
  if (trigger === "fire-only")
    parts.push(
      "It runs only when fired: autocode_wake fire, or " +
        `\`autocode fire me ${w.name}\` from a script.`,
    )
  else if (trigger === "fire-only once")
    parts.push(
      "It runs once, when fired (autocode_wake fire, or " +
        `\`autocode fire me ${w.name}\` from a script), then it is removed.`,
    )
  else if (trigger.startsWith("at "))
    parts.push(
      w.next
        ? `It runs once, at ${when(w.next, c)}, then it is removed.`
        : "It runs once, then it is removed.",
    )
  else if (idle) {
    const counted = w.due
      ? `if your session stays idle, at ${when(w.due, c)}`
      : `once your session has been idle ${idle[1]} (counted from the end ` +
        `of ${working ? "this" : "your next"} turn)`
    parts.push(
      idle[2]
        ? `It falls due ${counted}, and again every ${idle[1]} while you ` +
            "stay idle."
        : `It falls due once per idle stretch: ${counted}.`,
    )
  } else if (w.next) parts.push(`Next run ${when(w.next, c)}.`)
  const end = endOf(trigger)
  if (end)
    parts.push(
      `It ends ${localTime(Date.parse(end), c.tz)}: then it is removed, ` +
        "and a notice tells you.",
    )
  if (w.check)
    parts.push(
      "Before each run its check runs in your folder" +
        (w.check_timeout ? `, for up to ${w.check_timeout}` : "") +
        ": exit 0 wakes you with its output, exit 1 skips that run.",
    )
  const every = me?.settings?.min_interval
  parts.push(
    "Delivered only while your session is idle" +
      (every ? `, at most once per ${every}.` : "."),
  )
  return parts.join(" ")
}

export async function runWake(input: WakeInput, call: Call): Promise<string> {
  switch (input?.action) {
    case "set": {
      if (!input.name || !input.trigger || !input.text)
        return "error: set needs a name, a trigger and a text"
      const res = await call("PUT", `/v1/me/wakes/${enc(input.name)}`, {
        text: input.text,
        trigger: input.trigger,
        ...(input.check ? { check: input.check } : {}),
        ...(input.check_timeout ? { check_timeout: input.check_timeout } : {}),
      })
      // a periodic wake that the owner approves first (wake_mode ask)
      if (res.state === "asked")
        return (
          `Wake "${res.name}" is not set yet: a periodic wake needs the ` +
          `owner's approval here (${res.approval}). It is set once ` +
          "approved, counted from then, and a notice tells you (approval " +
          `"Wake ${res.name}" approved or rejected). Until then a wake of ` +
          "that name stays as it is. Go on with your work, and do not " +
          "rebuild it from one-time wakes."
        )
      // the wake is set: a failed status call only shortens the text
      const me = await call("GET", "/v1/me").catch(() => undefined)
      return setText(res.wake, me)
    }
    case "list":
    case "show": {
      const me = await call("GET", "/v1/me")
      const res = await call("GET", "/v1/me/wakes")
      const c = clockOf(me)
      const working = inTurn(me)
      // its periodic wakes that wait for the owner (wake_mode ask)
      const proposed: any[] = res.proposed ?? []
      const waiting = proposed.length
        ? "Waiting for the owner's approval: " +
          proposed
            .map(
              (p) =>
                `${p.name} (${shownTrigger(String(p.trigger), c)}; ` +
                `approval ${p.approval})`,
            )
            .join("; ") +
          ". Each is set once approved."
        : ""
      if (input.action === "show") {
        if (!input.name) return "error: show needs the wake's name"
        const w = res.wakes.find((x: any) => x.name === input.name)
        const asked = proposed.find((p) => p.name === input.name)
        if (!w && asked)
          return (
            `error: you have no wake "${input.name}" yet: it waits for ` +
            `the owner's approval (${asked.approval})`
          )
        if (!w)
          return (
            `error: you have no wake "${input.name}" ` +
            "(autocode_wake list shows them)"
          )
        return [
          `Wake "${w.name}", set by ${setBy(w, me)} at ` +
            `${localTime(Date.parse(w.updated_at), c.tz)}.`,
          `Trigger: ${shownTrigger(w.trigger, c)}; ${timing(w, c, working)}.`,
          // a change of it that waits for the owner (wake_mode ask)
          ...(asked
            ? [
                "A change waits for the owner's approval " +
                  `(${asked.approval}): ` +
                  `${shownTrigger(String(asked.trigger), c)}. Until then ` +
                  "the wake stays as it is.",
              ]
            : []),
          w.check
            ? `Check: ${w.check} (` +
              (w.check_timeout ? `up to ${w.check_timeout}; ` : "") +
              "exit 0 wakes you with its output, exit 1 skips the run)."
            : "Check: none.",
          "Last ran: " +
            (w.last_fired_at
              ? localTime(Date.parse(w.last_fired_at), c.tz)
              : "never") +
            ".",
          ((k) =>
            k
              ? `Last 7 days: ${k.turns}; it fell due ` +
                `${Number(w.week.due) || 0} times, and its check skipped ` +
                `${Number(w.week.skipped) || 0}.`
              : "Last 7 days: no turns.")(weekOf(w)),
          "Text:",
          w.text,
        ].join("\n")
      }
      if (!res.wakes.length)
        return waiting
          ? `No wakes. ${waiting}`
          : "No wakes. Set one with autocode_wake action=set."
      const lines = [`Server time ${localTime(c.now, c.tz)} (${c.tz}).`]
      for (const w of res.wakes) {
        const parts = [timing(w, c, working)]
        if (w.check)
          parts.push(
            `check: ${w.check}` +
              (w.check_timeout ? ` (up to ${w.check_timeout})` : ""),
          )
        // when it was last set (its schedule counts from then), and by whom
        // when not by you
        const by = setBy(w, me)
        parts.push(
          `last set ${localTime(Date.parse(w.updated_at), c.tz)}` +
            (by === "you" ? "" : ` by ${by}`),
        )
        if (w.last_fired_at)
          parts.push(`last ran ${localTime(Date.parse(w.last_fired_at), c.tz)}`)
        // what it cost (1.1.0): its turns and their dollars
        const week = weekOf(w)
        if (week) parts.push(`last 7 days: ${week.turns} (${week.counts})`)
        lines.push(
          `${w.name}: ${shownTrigger(w.trigger, c)}; ${parts.join("; ")}`,
        )
        lines.push(`  ${preview(w.text)}`)
      }
      if (waiting) lines.push(waiting)
      return lines.join("\n")
    }
    case "cancel": {
      if (!input.name) return "error: cancel needs the wake's name"
      await call("DELETE", `/v1/me/wakes/${enc(input.name)}`)
      return `Cancelled wake "${input.name}".`
    }
    case "fire": {
      if (!input.name) return "error: fire needs the wake's name"
      let agent = input.agent
      if (!agent) {
        const me = await call("GET", "/v1/me")
        if (!me.registered) return "error: register first, or name the agent"
        agent = me.agent.id as string
      }
      await call(
        "POST",
        `/v1/agents/${enc(agent)}/wakes/${enc(input.name)}/fire`,
        input.text ? { text: input.text } : {},
      )
      return (
        `Fired wake "${input.name}" of ${agent}: it comes when that session ` +
        "is idle."
      )
    }
    default:
      return "error: action must be set, list, show, cancel or fire"
  }
}

// Who sent a message, as the prompt says it.
const sender = (from: string) =>
  from === "owner"
    ? "the owner"
    : from === "autocode"
      ? "Autocode"
      : `agent ${from}`

// A message's head: its ID, who sent it, its subject, what it answers.
function messageHead(m: any): string {
  return (
    `${m.id} from ${sender(m.from)}` +
    (m.subject ? `, subject "${m.subject}"` : "") +
    (m.reply_to ? `, in reply to ${m.reply_to}` : "")
  )
}

// The messages read returned, whole and quoted, and how many more wait.
function readText(res: any): string {
  const out = (res.messages as any[]).map(
    (m) =>
      `Message ${messageHead(m)}:\n` +
      String(m.text)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n"),
  )
  if (res.left)
    out.push(`${res.left} more wait${res.left === 1 ? "s" : ""}: read again.`)
  return out.join("\n\n")
}

const NONE_WAIT = "No messages wait for you."

// The filters list, read and wait take.
function filterOf(input: MessageInput): Record<string, string> {
  const out: Record<string, string> = {}
  if (input.id) out.id = input.id
  if (input.from) out.from = input.from
  if (input.reply_to) out.reply_to = input.reply_to
  return out
}

export async function runMessage(
  input: MessageInput,
  call: Call,
  wait?: (body: Record<string, unknown>) => Promise<any>,
): Promise<string> {
  switch (input?.action) {
    case "send": {
      if (!input.to) return "error: send needs to (an ID, a pattern or owner)"
      if (!input.text) return "error: send needs text"
      const to = input.to.includes(",")
        ? input.to
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : input.to.trim()
      const res = await call("POST", "/v1/messages", {
        to,
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.reply_to ? { reply_to: input.reply_to } : {}),
        text: input.text,
        // to the owner, needing no answer (1.1.0)
        ...(input.report === true ? { report: true } : {}),
      })
      const ids = res.messages.map((m: any) => m.id).join(", ")
      const skipped: string[] = res.skipped ?? []
      // an old ID that forwarded to a renamed agent (1.1.0)
      const renamed = Object.entries(res.renamed ?? {})
        .map(([old, now]) => ` ${old} is ${now} now: use that ID.`)
        .join("")
      return (
        `Sent to ${res.recipients.join(", ")} (${ids})` +
        (input.report === true ? ", as a report." : ".") +
        (skipped.length
          ? ` Skipped (not registered): ${skipped.join(", ")}.`
          : "") +
        renamed
      )
    }
    case "list": {
      const q = new URLSearchParams()
      if (input.from) q.set("from", input.from)
      if (input.reply_to) q.set("reply_to", input.reply_to)
      const qs = q.toString()
      const res = await call("GET", `/v1/me/messages${qs ? `?${qs}` : ""}`)
      if (!res.messages.length) return NONE_WAIT
      const lines = (res.messages as any[]).map(
        (m) => `Waiting: ${messageHead(m)}, ${m.size} characters.`,
      )
      return `${lines.join("\n")} Read it with autocode_message read.`
    }
    case "read": {
      const res = await call("POST", "/v1/me/messages/read", filterOf(input))
      return res.messages.length ? readText(res) : NONE_WAIT
    }
    case "wait": {
      const seconds = Math.max(1, Math.min(Number(input.seconds) || 300, 3600))
      const body = { ...filterOf(input), wait: seconds }
      const res = wait
        ? await wait(body)
        : await call("POST", "/v1/me/messages/read", body)
      if (res.messages.length) return readText(res)
      return (
        `No message came within ${seconds} seconds; one that comes later is ` +
        "in your next prompt or turn."
      )
    }
    case "answer": {
      if (!input.id || !input.text)
        return "error: answer needs the ask's id and your text"
      const res = await call("POST", `/v1/asks/${enc(input.id)}/answer`, {
        text: input.text,
      })
      const kind = String(res?.ask?.kind ?? "ask")
      return kind === "approval"
        ? `Answered ${input.id} (approval); the asking agent is told.`
        : `Answered ${input.id} (${kind}); the asking agent's turn goes on ` +
            "with it."
    }
    case "escalate": {
      if (!input.id) return "error: escalate needs the ask's id"
      await call("POST", `/v1/asks/${enc(input.id)}/escalate`, {
        text: input.text ?? "",
      })
      return `Handed ${input.id} to the owner, with your reason.`
    }
    case "close":
      return closeOwn(input.id, input.text, call)
    default:
      return (
        "error: autocode_message has send, list, read, wait, answer, " +
        "escalate and close"
      )
  }
}

// How many of its open Inbox items an agent's status names, and how much
// of each one's subject.
const OPEN_SHOWN = 5
const SUBJECT_SHOWN = 60

/*
 * Closes what the agent itself put into the owner's Inbox and that no longer
 * matters (1.1.0-rc4; the owner, 2026-11-22): a message or report it sent,
 * or an approval it asked for. The same call from both tools.
 */
async function closeOwn(
  id: string | undefined,
  why: string | undefined,
  call: Call,
): Promise<string> {
  if (!id)
    return (
      "error: close needs the id of a message you sent to the owner, or " +
      "of an approval you asked for"
    )
  // the owner reads it in History: there must be one
  if (!why?.trim())
    return "error: close needs text: why it no longer matters, in a line"
  const res = await call("POST", "/v1/me/inbox/close", { id, text: why })
  const item = res.item
  // a job or a wake it asked to set never made it wait
  if (item.kind === "approval" && item.job)
    return (
      `Closed approval ${item.id}: the job ${item.job} is not set. ` +
      "Closed is not approved."
    )
  if (item.kind === "approval" && item.wake)
    return (
      `Closed approval ${item.id}: the wake ${item.wake} is not set. ` +
      "Closed is not approved."
    )
  if (item.kind === "approval")
    return (
      `Closed approval ${item.id}: you no longer wait for it, and your ` +
      "wakes and messages come again. Closed is not approved: act only " +
      "on what the owner told you."
    )
  return (
    `Closed your ${item.report ? "report" : "message"} ` +
    `${item.message_id ?? item.id} in the owner's Inbox.`
  )
}

// Who holds a lock, for its text.
function heldBy(lock: any, me?: string): string {
  const who = (lock?.holders ?? []).map((h: any) =>
    h.agent === me ? `${h.agent} (you)` : h.agent,
  )
  return who.length ? who.join(", ") : "nobody"
}

const places = (max: number) => (max > 1 ? ` (${max} places)` : "")

const QUEUE_TAIL =
  ' When it is yours, a notice comes: [autocode] lock "NAME" granted ' +
  "(your ttl counts from then). Release it to leave the queue."

export async function runLock(input: LockInput, call: Call): Promise<string> {
  const name = input?.name?.trim()
  const path = (action: string) => `/v1/locks/${enc(name!)}/${action}`
  switch (input?.action) {
    case "acquire": {
      if (!name || !input.ttl)
        return (
          "error: acquire needs a name and a ttl (how long you hold it, " +
          "like 10m or 6h)"
        )
      const res = await call("POST", path("acquire"), {
        ttl: input.ttl,
        mode: input.mode ?? "queue",
        ...(input.max === undefined ? {} : { max: input.max }),
      })
      // the server's clock and zone for the times; the local one without
      const me = await call("GET", "/v1/me").catch(() => undefined)
      const c = clockOf(me)
      if (res.granted)
        return (
          `You hold lock "${name}" until ${when(res.expires, c)}. Renew it ` +
          "before then (action=renew); release it when you are done."
        )
      const tail = QUEUE_TAIL.replace("NAME", name)
      return (
        `Lock "${name}"${places(res.lock.max)} is held by ` +
        `${heldBy(res.lock, me?.agent?.id)}; you are number ${res.position} ` +
        `in the queue.${tail}`
      )
    }
    case "renew": {
      if (!name) return "error: renew needs the lock's name"
      const res = await call(
        "POST",
        path("renew"),
        input.ttl ? { ttl: input.ttl } : {},
      )
      const me = await call("GET", "/v1/me").catch(() => undefined)
      return `Renewed: you hold lock "${name}" until ${when(
        res.expires,
        clockOf(me),
      )}.`
    }
    case "release": {
      if (!name) return "error: release needs the lock's name"
      const res = await call("POST", path("release"), {})
      return res.released === "queued"
        ? `Left the queue of lock "${name}".`
        : `Released lock "${name}".`
    }
    case "list": {
      const pattern = input.pattern?.trim()
      const me = await call("GET", "/v1/me")
      const res = await call(
        "GET",
        `/v1/locks${pattern ? `?match=${enc(pattern)}` : ""}`,
      )
      if (!res.locks.length)
        return pattern
          ? `No locks match ${pattern}.`
          : "No locks. The first acquire creates one."
      const c = clockOf(me)
      const self = me?.agent?.id
      const lines = [`Server time ${localTime(c.now, c.tz)} (${c.tz}).`]
      for (const l of res.locks) {
        const kind = l.max > 1 ? `${l.max} places` : "mutex"
        const held = l.holders.length
          ? `held by ${l.holders
              .map(
                (h: any) =>
                  `${h.agent === self ? `${h.agent} (you)` : h.agent} ` +
                  `until ${when(h.expires, c)}`,
              )
              .join(", ")}`
          : "free"
        const queue = l.queue.length
          ? `; queued: ${l.queue.map((q: any) => q.agent).join(", ")}`
          : ""
        lines.push(`${l.name} (${kind}): ${held}${queue}`)
      }
      return lines.join("\n")
    }
    default:
      return "error: action must be acquire, renew, release or list"
  }
}

// How an approval stands, in a line.
function approvalLine(a: any): string {
  const by =
    a.by === "owner"
      ? " by the owner"
      : a.by === "auto"
        ? " (by the setting approval_mode=allow)"
        : a.by && a.by === a.agent
          ? " by you"
          : a.by
            ? ` by agent ${a.by}`
            : ""
  const state =
    a.state === "expired"
      ? "expired: it counts as rejected"
      : a.state === "gone"
        ? "closed"
        : String(a.state)
  const extra = [
    a.option ? `Option: ${a.option}.` : "",
    a.note ? `Note: ${a.note}` : "",
  ].filter(Boolean)
  return `${state}${by}.${extra.length ? ` ${extra.join(" ")}` : ""}`
}

export async function runApproval(
  input: ApprovalInput,
  call: Call,
  wait?: (id: string, seconds: number) => Promise<any>,
): Promise<string> {
  switch (input?.action) {
    case "ask": {
      if (!input.text) return "error: ask needs the text to approve"
      const options = input.options
        ? input.options
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean)
        : undefined
      const res = await call("POST", "/v1/me/approvals", {
        text: input.text,
        ...(options?.length ? { options } : {}),
        ...(input.expires ? { expires: input.expires } : {}),
      })
      const a = res.approval
      if (a.state !== "open") return `Approval ${a.id} is ${approvalLine(a)}`
      const who = String(a.routed).startsWith("agent:")
        ? `agent ${String(a.routed).slice("agent:".length)} (the owner ` +
          "sees it too)"
        : "the owner"
      const me = await call("GET", "/v1/me").catch(() => undefined)
      const c = clockOf(me)
      return (
        `Approval ${a.id} is with ${who}. The answer comes as a notice ` +
        '([autocode] approval "…" approved or rejected); until then your ' +
        "wakes and messages wait." +
        (a.expires
          ? ` It expires at ${when(a.expires, c)}: then it counts as ` +
            "rejected."
          : "") +
        ` To wait for it now: autocode_approval action=wait id=${a.id}.`
      )
    }
    case "wait": {
      if (!input.id) return "error: wait needs the approval's id"
      const seconds = Math.max(1, Math.min(Number(input.seconds) || 300, 3600))
      const res = wait
        ? await wait(input.id, seconds)
        : await call("GET", `/v1/me/approvals/${enc(input.id)}?wait=${seconds}`)
      const a = res.approval
      if (a.state === "open")
        return (
          `Approval ${a.id} is not answered yet (waited up to ${seconds} ` +
          "seconds). The answer comes as a notice."
        )
      return `Approval ${a.id}: ${approvalLine(a)}`
    }
    case "close":
      return closeOwn(input.id, input.text, call)
    default:
      return "error: action must be ask, wait or close"
  }
}
