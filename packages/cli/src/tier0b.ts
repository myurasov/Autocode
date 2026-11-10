/*
 * The CLI's tier 0b commands: me, fire and send (a script in an agent's shell
 * acts as its agent with these only: the owner, 2026-11-07; the owner names
 * any agent), and the owner's wakes, wake, messages, inbox, answer, pause,
 * resume, stop-all and resume-all; retry (tier 0b3); locks (tier 0c); and
 * jobs (tier 0f).
 */

import { CliError, type Parsed } from "./args.ts"
import { local, table } from "./commands.ts"
import { type Connection, connect } from "./connect.ts"

const enc = encodeURIComponent

function print(args: Parsed, data: unknown, text: () => string) {
  console.log(
    args.switches.has("json") ? JSON.stringify(data, null, 2) : text(),
  )
}

function usage(text: string): never {
  throw new CliError(`usage: autocode ${text}`, 2)
}

// "me" is the calling agent (a script in its shell); any other word an ID.
async function agentOf(c: Connection, word: string): Promise<string> {
  if (word !== "me") return word
  const me = await c.call("GET", "/v1/me")
  if (!me?.registered)
    throw new CliError("this session is not registered as an agent", 1)
  return me.agent.id as string
}

export async function me(args: Parsed): Promise<number> {
  const res = await connect(args).call("GET", "/v1/me")
  print(args, res, () => {
    if (!res.registered)
      return `this session is not registered (${res.session})`
    const a = res.agent
    return [
      `${a.id}: ${a.status} on ${a.machine} (session ${a.session})`,
      ...(a.description ? [a.description] : []),
    ].join("\n")
  })
  return 0
}

function wakeTable(wakes: any[]): string {
  if (!wakes.length) return "no wakes"
  return table(
    wakes.map((w) => [
      w.agent,
      w.name,
      w.trigger,
      local(w.next),
      w.check ?? "",
      local(w.updated_at),
      String(w.text).split("\n")[0] ?? "",
    ]),
    ["AGENT", "NAME", "TRIGGER", "NEXT", "CHECK", "LAST SET", "TEXT"],
  )
}

export async function wakes(args: Parsed): Promise<number> {
  const c = connect(args)
  const [agent] = args.words
  const res = await c.call(
    "GET",
    agent ? `/v1/agents/${enc(agent)}/wakes` : "/v1/wakes",
  )
  print(args, res.wakes, () => wakeTable(res.wakes))
  return 0
}

export async function wake(args: Parsed): Promise<number> {
  const [sub, who, name] = args.words
  const f = args.flags
  if (sub === "set") {
    if (!who || !name || !f.trigger || !f.text)
      usage(
        "wake set AGENT NAME --trigger TRIGGER --text TEXT " +
          "[--check COMMAND]",
      )
    const res = await connect(args).call(
      "PUT",
      `/v1/agents/${enc(who)}/wakes/${enc(name)}`,
      {
        text: f.text,
        trigger: f.trigger,
        ...(f.check ? { check: f.check } : {}),
      },
    )
    const w = res.wake
    print(
      args,
      w,
      () =>
        `wake ${w.name} of ${w.agent} set: ${w.trigger}; ` +
        (w.next ? `next ${local(w.next)}` : "no time of its own"),
    )
    return 0
  }
  if (sub === "cancel") {
    if (!who || !name) usage("wake cancel AGENT NAME")
    const res = await connect(args).call(
      "DELETE",
      `/v1/agents/${enc(who)}/wakes/${enc(name)}`,
    )
    print(args, res, () => `cancelled wake ${name} of ${who}`)
    return 0
  }
  usage("wake set|cancel ...")
}

export async function fire(args: Parsed): Promise<number> {
  const [who, name] = args.words
  if (!who || !name) usage("fire AGENT|me WAKE [--text TEXT]")
  const c = connect(args)
  const agent = await agentOf(c, who)
  const res = await c.call(
    "POST",
    `/v1/agents/${enc(agent)}/wakes/${enc(name)}/fire`,
    args.flags.text ? { text: args.flags.text } : {},
  )
  print(args, res, () => `fired ${name} of ${agent}`)
  return 0
}

export async function send(args: Parsed): Promise<number> {
  const [to, ...words] = args.words
  const f = args.flags
  if (!to || !words.length || f.file)
    usage("send TO TEXT... [--subject S] [--reply-to ID]")
  const res = await connect(args).call("POST", "/v1/messages", {
    to: to.includes(",") ? to.split(",").filter(Boolean) : to,
    ...(f.subject ? { subject: f.subject } : {}),
    ...(f["reply-to"] ? { reply_to: f["reply-to"] } : {}),
    text: words.join(" "),
  })
  print(
    args,
    res,
    () =>
      `sent to ${res.recipients.join(", ")} ` +
      `(${res.messages.map((m: any) => m.id).join(", ")})` +
      (res.skipped?.length
        ? `; skipped (not registered): ${res.skipped.join(", ")}`
        : ""),
  )
  return 0
}

// Every message (its state: queued, read with how, or dropped), or one
// whole: the owner's; never marks one read.
export async function messages(args: Parsed): Promise<number> {
  const [sub, id] = args.words
  const c = connect(args)
  if (sub === "read") {
    if (!id) usage("messages read ID")
    const res = await c.call("GET", `/v1/messages/${enc(id)}`)
    const m = res.message
    print(
      args,
      res,
      () =>
        `message ${m.id} from ${m.from} to ${m.to}` +
        (m.subject ? `, subject "${m.subject}"` : "") +
        (m.reply_to ? `, in reply to ${m.reply_to}` : "") +
        `:\n${m.text}`,
    )
    return 0
  }
  if (sub) usage("messages | messages read ID")
  const res = await c.call("GET", "/v1/messages")
  print(args, res.messages, () =>
    res.messages.length
      ? table(
          res.messages.map((m: any) => [
            m.id,
            m.from,
            m.to,
            m.subject,
            String(m.size),
            // read, with how (the owner, 2026-11-09)
            m.state === "read" && m.read_via ? `read (${m.read_via})` : m.state,
            local(m.created_at),
          ]),
          ["ID", "FROM", "TO", "SUBJECT", "SIZE", "STATE", "CREATED"],
        )
      : "no messages",
  )
  return 0
}

export async function inbox(args: Parsed): Promise<number> {
  const [sub, id] = args.words
  const c = connect(args)
  if (sub === "close") {
    if (!id) usage("inbox close ID")
    const res = await c.call("POST", `/v1/inbox/${enc(id)}/close`)
    print(args, res, () => `closed ${id}`)
    return 0
  }
  if (sub) usage("inbox [--all] | inbox close ID")
  const all = args.switches.has("all") || args.flags.all !== undefined
  const res = await c.call("GET", `/v1/inbox${all ? "?all=1" : ""}`)
  print(args, res.items, () =>
    res.items.length
      ? table(
          res.items.map((i: any) => [
            i.id,
            i.kind,
            i.agent ?? "",
            // where an ask went (tier 0d): owner, or agent:<id>
            String(i.routed ?? "").replace(/^agent:/, "") || "",
            i.title,
            local(i.created_at),
          ]),
          ["ID", "KIND", "AGENT", "TO", "TITLE", "CREATED"],
        )
      : "the inbox is empty",
  )
  return 0
}

/*
 * Answers an inbox item: a message (the reply goes to the agent), or an ask
 * (tier 0d): a question (an option or words), a permission (once, always or
 * reject: why) or an approval (approve or reject, then an option and a note).
 */
export async function answer(args: Parsed): Promise<number> {
  const [id, ...words] = args.words
  if (!id || !words.length) usage("answer ID TEXT...")
  const path = id.startsWith("ask_")
    ? `/v1/asks/${enc(id)}/answer`
    : `/v1/inbox/${enc(id)}/answer`
  const res = await connect(args).call("POST", path, {
    text: words.join(" "),
  })
  print(args, res, () => `answered ${id}`)
  return 0
}

export async function pause(args: Parsed, resume: boolean): Promise<number> {
  const [agent] = args.words
  if (!agent) usage(`${resume ? "resume" : "pause"} AGENT`)
  const res = await connect(args).call(
    "POST",
    `/v1/agents/${enc(agent)}/${resume ? "resume" : "pause"}`,
  )
  print(args, res, () => `${agent} ${resume ? "resumed" : "paused"}`)
  return 0
}

// Every lock with its holders and queue, one row per holder (tier 0c).
function lockTable(locks: any[]): string {
  if (!locks.length) return "no locks"
  const rows: string[][] = []
  for (const l of locks) {
    const queue = l.queue.map((q: any) => q.agent).join(", ")
    const held = l.holders.length ? l.holders : [null]
    for (const [i, h] of held.entries())
      rows.push([
        i ? "" : l.name,
        i ? "" : String(l.max),
        h?.agent ?? "",
        h ? local(h.expires) : "",
        i ? "" : queue,
      ])
  }
  return table(rows, ["LOCK", "MAX", "HOLDER", "EXPIRES", "QUEUE"])
}

export async function locks(args: Parsed): Promise<number> {
  const [first, name, agent] = args.words
  const c = connect(args)
  if (first === "release") {
    if (!name || !agent) usage("locks release NAME AGENT")
    const whoami = await c.call("GET", "/v1/whoami")
    if (whoami.kind !== "admin")
      throw new CliError(
        "only the owner releases an agent's hold here; an agent releases " +
          "its own in the conversation (autocode_lock action=release)",
        2,
      )
    const res = await c.call("POST", `/v1/locks/${enc(name)}/release`, {
      agent,
    })
    print(args, res, () =>
      res.released === "queued"
        ? `took ${agent} out of the queue of ${name}`
        : `released ${agent}'s hold on ${name}`,
    )
    return 0
  }
  const res = await c.call(
    "GET",
    `/v1/locks${first ? `?match=${enc(first)}` : ""}`,
  )
  print(args, res.locks, () => lockTable(res.locks))
  return 0
}

// A retry now for an agent in the error state (tier 0b3).
export async function retry(args: Parsed): Promise<number> {
  const [agent] = args.words
  if (!agent) usage("retry AGENT")
  const res = await connect(args).call("POST", `/v1/agents/${enc(agent)}/retry`)
  print(args, res, () => `${agent}: a retry comes now`)
  return 0
}

const agentsText = (ids: string[]) =>
  `${ids.length} agent${ids.length === 1 ? "" : "s"}` +
  (ids.length ? ` (${ids.join(", ")})` : "")

export async function stopAll(args: Parsed): Promise<number> {
  const res = await connect(args).call("POST", "/v1/stop-all")
  print(
    args,
    res,
    () =>
      `paused ${agentsText(res.paused)}; interrupted ` +
      `${res.interrupted.length} session` +
      (res.interrupted.length === 1 ? "" : "s"),
  )
  return 0
}

export async function resumeAll(args: Parsed): Promise<number> {
  const res = await connect(args).call("POST", "/v1/resume-all")
  print(args, res, () => `resumed ${agentsText(res.resumed)}`)
  return 0
}

// Jobs and their runs (tier 0f).
export async function job(args: Parsed): Promise<number> {
  const [sub, name] = args.words
  const f = args.flags
  const c = connect(args)
  if (sub === "set") {
    if (!name || !f.host || !f.model || !f.prompt || !f.trigger)
      usage(
        "job set NAME --host H --model PROVIDER/MODEL --prompt P " +
          "--trigger T [--to TO] [--description D] [--variant V] " +
          "[--agent A] [--timeout 1h] [--run-usd 2] [--keep-session]",
      )
    const res = await c.call("PUT", `/v1/jobs/${enc(name)}`, {
      host: f.host,
      model: f.model,
      prompt: f.prompt,
      trigger: f.trigger,
      ...(f.to ? { to: f.to } : {}),
      ...(f.description ? { description: f.description } : {}),
      ...(f.variant ? { variant: f.variant } : {}),
      ...(f.agent ? { agent: f.agent } : {}),
      ...(f.timeout ? { timeout: f.timeout } : {}),
      ...(f["run-usd"] ? { run_usd: Number(f["run-usd"]) } : {}),
      ...(args.switches.has("keep-session") ? { delete_session: false } : {}),
    })
    const j = res.job
    print(
      args,
      j,
      () =>
        `job ${j.name} set: ${j.trigger} on ${j.host}` +
        (j.next ? `; next ${local(j.next)}` : ""),
    )
    return 0
  }
  if (sub === "list" || !sub) {
    const res = await c.call("GET", "/v1/jobs")
    print(args, res.jobs, () =>
      res.jobs.length
        ? table(
            res.jobs.map((j: any) => [
              j.name,
              `${j.machine}:${j.directory}${j.online ? "" : " (offline)"}`,
              j.model,
              j.trigger,
              local(j.next),
              j.last_run
                ? `${j.last_run.state} ${local(j.last_run.started)}`
                : "",
            ]),
            ["NAME", "WHERE", "MODEL", "TRIGGER", "NEXT", "LAST RUN"],
          )
        : "no jobs",
    )
    return 0
  }
  if (sub === "run") {
    if (!name) usage("job run NAME [--text TEXT]")
    const res = await c.call(
      "POST",
      `/v1/jobs/${enc(name)}/run`,
      f.text ? { text: f.text } : {},
    )
    print(args, res.run, () => `started run ${res.run.id}`)
    return 0
  }
  if (sub === "runs") {
    const res = await c.call(
      "GET",
      `/v1/runs${name ? `?job=${enc(name)}` : ""}`,
    )
    print(args, res.runs, () =>
      res.runs.length
        ? table(
            res.runs.map((r: any) => [
              r.id,
              r.by,
              r.state,
              local(r.started),
              `$${Number(r.cost ?? 0).toFixed(2)}`,
              String(r.result ?? r.reason ?? "")
                .split("\n")[0]!
                .slice(0, 60),
            ]),
            ["RUN", "BY", "STATE", "STARTED", "COST", "RESULT"],
          )
        : "no runs",
    )
    return 0
  }
  if (sub === "delete-session") {
    if (!name) usage("job delete-session RUN")
    const res = await c.call("DELETE", `/v1/runs/${enc(name)}/session`)
    print(args, res, () => `deleted the session ${res.deleted} of ${name}`)
    return 0
  }
  if (sub === "delete") {
    if (!name) usage("job delete NAME")
    const res = await c.call("DELETE", `/v1/jobs/${enc(name)}`)
    print(args, res, () => `deleted job ${name}`)
    return 0
  }
  usage("job set|list|run|runs|delete|delete-session ...")
}
