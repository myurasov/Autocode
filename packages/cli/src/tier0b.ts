/*
 * The CLI's tier 0b commands: me, wakes and wake, fire, send and messages (an
 * agent's own, from a script in its shell, or the owner's for any agent), and
 * the owner's inbox, answer, pause, resume, stop-all and resume-all.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { extname, resolve } from "node:path"
import { CliError, type Parsed } from "./args.ts"
import { table } from "./commands.ts"
import { type Connection, connect } from "./connect.ts"

const enc = encodeURIComponent

function local(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("sv-SE")
}

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
      String(w.text).split("\n")[0] ?? "",
    ]),
    ["AGENT", "NAME", "TRIGGER", "NEXT", "CHECK", "TEXT"],
  )
}

export async function wakes(args: Parsed): Promise<number> {
  const c = connect(args)
  const [agent] = args.words
  const whoami = await c.call("GET", "/v1/whoami")
  if (whoami.kind === "session" && agent && agent !== "me")
    throw new CliError("in an agent's shell, wakes lists its own only", 2)
  const res =
    whoami.kind === "session"
      ? await c.call("GET", "/v1/me/wakes")
      : await c.call(
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
        "wake set AGENT|me NAME --trigger TRIGGER --text TEXT " +
          "[--check COMMAND] [--end TIME]",
      )
    const c = connect(args)
    const agent = await agentOf(c, who)
    const body = {
      text: f.text,
      trigger: f.trigger,
      ...(f.check ? { check: f.check } : {}),
      ...(f.end ? { end: f.end } : {}),
    }
    const res = await c.call(
      "PUT",
      who === "me"
        ? `/v1/me/wakes/${enc(name)}`
        : `/v1/agents/${enc(agent)}/wakes/${enc(name)}`,
      body,
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
    if (!who || !name) usage("wake cancel AGENT|me NAME")
    const c = connect(args)
    const agent = await agentOf(c, who)
    const res = await c.call(
      "DELETE",
      who === "me"
        ? `/v1/me/wakes/${enc(name)}`
        : `/v1/agents/${enc(agent)}/wakes/${enc(name)}`,
    )
    print(args, res, () => `cancelled wake ${name} of ${agent}`)
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

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
}

// A file's content: text when it reads as UTF-8 text, else base64.
function fileContent(path: string) {
  const bytes = new Uint8Array(readFileSync(path))
  if (!bytes.includes(0))
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
    } catch {}
  return {
    data: Buffer.from(bytes).toString("base64"),
    mime: MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
  }
}

export async function send(args: Parsed): Promise<number> {
  const [to, ...words] = args.words
  const f = args.flags
  if (!to || (!words.length && !f.file) || (words.length && f.file))
    usage("send TO TEXT... | send TO --file PATH [--subject S] [--reply-to ID]")
  const content = f.file
    ? fileContent(resolve(f.file))
    : { text: words.join(" ") }
  const res = await connect(args).call("POST", "/v1/messages", {
    to: to.includes(",") ? to.split(",").filter(Boolean) : to,
    ...(f.subject ? { subject: f.subject } : {}),
    ...(f["reply-to"] ? { reply_to: f["reply-to"] } : {}),
    ...content,
  })
  print(
    args,
    res,
    () =>
      `sent to ${res.recipients.join(", ")} ` +
      `(${res.messages.map((m: any) => m.id).join(", ")})`,
  )
  return 0
}

export async function messages(args: Parsed): Promise<number> {
  const [sub, id] = args.words
  const c = connect(args)
  if (sub === "read") {
    if (!id) usage("messages read ID [--out FILE]")
    const owner = (await c.call("GET", "/v1/whoami")).kind !== "session"
    const res = await c.call(
      "GET",
      owner ? `/v1/messages/${enc(id)}` : `/v1/me/messages/${enc(id)}`,
    )
    const m = res.message
    if (m.kind === "binary" && args.flags.out) {
      const out = resolve(args.flags.out)
      writeFileSync(out, Buffer.from(m.data, "base64"))
      print(args, res, () => `saved ${m.mime} to ${out}`)
      return 0
    }
    print(args, res, () => {
      const head =
        `message ${m.id} from ${m.from}` +
        (m.subject ? `, subject "${m.subject}"` : "") +
        (m.reply_to ? `, in reply to ${m.reply_to}` : "")
      return m.kind === "binary"
        ? `${head}: message ${m.id} is a file (${m.mime}, ${m.size} ` +
            "characters of base64): pass --out FILE to save it"
        : `${head}:\n${m.text}`
    })
    return 0
  }
  if (sub) usage("messages [--all] [--wait SECONDS] | messages read ID")
  const whoami = await c.call("GET", "/v1/whoami")
  if (whoami.kind !== "session") {
    const res = await c.call("GET", "/v1/messages")
    print(args, res.messages, () =>
      res.messages.length
        ? table(
            res.messages.map((m: any) => [
              m.id,
              m.from,
              m.to,
              m.subject,
              m.kind === "binary" ? m.mime : "text",
              String(m.size),
              m.state,
              local(m.created_at),
            ]),
            ["ID", "FROM", "TO", "SUBJECT", "KIND", "SIZE", "STATE", "CREATED"],
          )
        : "no messages",
    )
    return 0
  }
  const all = args.switches.has("all") || args.flags.all !== undefined
  const wait = Number(args.flags.wait ?? 0)
  if (!Number.isFinite(wait) || wait < 0) usage("messages --wait SECONDS")
  let res = await c.call("GET", `/v1/me/messages${all ? "?all=1" : ""}`)
  // the server answers a wait within 240 s: wait again until the end
  const end = Date.now() + wait * 1000
  while (!all && wait && !res.messages.length && Date.now() < end) {
    const left = Math.ceil((end - Date.now()) / 1000)
    const chunk = Math.max(1, Math.min(left, 240))
    res = await c.call(
      "GET",
      `/v1/me/messages?wait=${chunk}`,
      undefined,
      (chunk + 15) * 1000,
    )
  }
  print(args, res.messages, () =>
    res.messages.length
      ? table(
          res.messages.map((m: any) => [
            m.id,
            m.from,
            m.subject,
            m.kind === "binary" ? m.mime : "text",
            String(m.size),
            m.state,
            local(m.created_at),
          ]),
          ["ID", "FROM", "SUBJECT", "KIND", "SIZE", "STATE", "CREATED"],
        )
      : all
        ? "no messages"
        : "no unread messages",
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
            i.title,
            local(i.created_at),
          ]),
          ["ID", "KIND", "AGENT", "TITLE", "CREATED"],
        )
      : "the inbox is empty",
  )
  return 0
}

export async function answer(args: Parsed): Promise<number> {
  const [id, ...words] = args.words
  if (!id || !words.length) usage("answer ID TEXT...")
  const res = await connect(args).call("POST", `/v1/inbox/${enc(id)}/answer`, {
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
