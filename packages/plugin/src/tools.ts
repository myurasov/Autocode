/*
 * The agent tools: autocode_me (register, unregister, status, discover,
 * help), autocode_wake (set, list, show, cancel, fire) and autocode_message
 * (send, list, read, wait); later tiers add actions and tools. Their
 * descriptions say enough to use them without the guide (OpenCode sends them
 * with every model call); their results say when things will happen, in the
 * server's zone and from now.
 */

import { localTime } from "@autocode/shared"

export interface MeInput {
  action: "register" | "unregister" | "status" | "discover" | "help"
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
    "your wakes and unread messages), discover (pattern), help (topic: " +
    "the exact rules for wakes, checks, delivery, messages, prompts, " +
    "scripts).",
  input: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["register", "unregister", "status", "discover", "help"],
      },
      id: {
        type: "string",
        description:
          "register: your agent ID, like project:role:name (letters, " +
          "digits, - _ . :)",
      },
      description: {
        type: "string",
        description: "register: what you do, in a sentence",
      },
      pattern: {
        type: "string",
        description: "discover: which agents, like kaggle:* (default *)",
      },
      topic: {
        type: "string",
        description:
          "help: overview, delivery, wakes, checks, recipes, messages, " +
          "prompts, scripts, trouble, or all (the default)",
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

function statusLine(a: any): string {
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
      return `Unregistered ${res.unregistered}; your wakes are removed.`
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
        statusLine(a),
        ...serverLine(me, c),
      ]
      const set = me.settings
      if (set)
        lines.push(
          "Delivery: only while this session is idle, at most once per " +
            `${set.min_interval}; messages up to ${set.inline_limit} ` +
            "characters come whole.",
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
      if (me.unread !== undefined)
        lines.push(
          me.unread
            ? `Unread messages: ${me.unread}. See autocode_message list.`
            : "Unread messages: none.",
        )
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
    case "help":
      return deps.guide
        ? deps.guide(input.topic)
        : "error: the guide is not available here"
    default:
      return (
        "error: action must be register, unregister, status, discover " +
        "or help"
      )
  }
}

export interface WakeInput {
  action: "set" | "list" | "show" | "cancel" | "fire"
  name?: string
  text?: string
  trigger?: string
  check?: string
  end?: string
  agent?: string
}

export const WAKE_TOOL = {
  name: "autocode_wake",
  description:
    "Autocode wakes: a prompt Autocode types into your session later (a " +
    "user message starting with [autocode]), only while the session is " +
    "idle (never into a running turn) and at most once per min_interval. " +
    "Actions: set (name, trigger, text; optional check, end; the same name " +
    "replaces the wake), list (when each falls due next), show (name), " +
    "cancel (name), fire (agent, name, text: deliver now, skipping the " +
    "check). Triggers: every 30m [from 09:00]; in 45m (once); at 09:00 or " +
    'at 2026-11-30 18:00 (once); cron "*/30 8-16 * * 1-5" [zone]; idle 30m ' +
    "[repeat] (after that long idle, counted from your last turn's end); " +
    "fire-only (a job you start fires it by ending with: autocode fire me " +
    "NAME). Times are in the server's zone (see autocode_me status). " +
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
          "idle 30m | idle 30m repeat | fire-only",
      },
      check: {
        type: "string",
        description:
          "set, optional: a shell command run in your folder when the wake " +
          "is due; exit 0 wakes you with its output, exit 1 skips the run " +
          "(no model call), other exits fail; 60 s limit",
      },
      end: {
        type: "string",
        description:
          "set, optional: when the wake is removed: " +
          "2026-11-30T17:00:00-08:00, or 2026-11-30 17:00 in the server's " +
          "zone",
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
  action: "send" | "list" | "read" | "wait"
  to?: string
  subject?: string
  text?: string
  file?: string
  reply_to?: string
  id?: string
  path?: string
  seconds?: number
}

export const MESSAGE_TOOL = {
  name: "autocode_message",
  description:
    "Autocode messages between agents and the owner. New messages arrive " +
    "in an injected prompt (short ones whole). Actions: send (to: an agent " +
    "ID, a pattern like team:*, a comma list, or owner; subject; text or " +
    "file; reply_to), list (your unread messages), read (id; path to save " +
    "a file), wait (seconds: holds this call until a message comes, up to " +
    "max_tool_wait; costs no tokens).",
  input: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["send", "list", "read", "wait"] },
      to: {
        type: "string",
        description:
          "send: an agent ID (team:b), a pattern (team:*, never you), a " +
          "comma list (a:b,c:d), or owner (the person who runs Autocode)",
      },
      subject: { type: "string", description: "send: a short subject" },
      text: {
        type: "string",
        description: "send: the message (at most 32,000 characters)",
      },
      file: {
        type: "string",
        description:
          "send: a file in your folder to send instead of text (about " +
          "24 KB at most for a binary file)",
      },
      reply_to: {
        type: "string",
        description: "send: the ID of the message this answers",
      },
      id: { type: "string", description: "read: the message ID" },
      path: {
        type: "string",
        description: "read: where to save a file message, in your folder",
      },
      seconds: {
        type: "number",
        description: "wait: at most this long (default 300)",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
}

export const TOOLS = [ME_TOOL, WAKE_TOOL, MESSAGE_TOOL]

const enc = encodeURIComponent

const PREVIEW = 100

// A wake's text in short: its first 100 characters on one line.
function preview(text: string): string {
  const flat = String(text).replace(/\s+/g, " ")
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW)}…` : flat
}

const idleOf = (trigger: string) => /^idle (\S+)( repeat)?$/.exec(trigger)

// When a wake falls due, for list and show.
function timing(w: any, c: Clock, working: boolean): string {
  const trigger = String(w.trigger)
  if (trigger === "fire-only") return "runs only when fired"
  const idle = idleOf(trigger)
  if (idle) {
    if (w.due) return `due ${when(w.due, c)} if you stay idle`
    if (working) return `due ${idle[1]} after this turn ends`
    return (
      "ran in this idle stretch; due again " +
      `${idle[1]} after your next turn ends`
    )
  }
  if (w.next) return `next ${when(w.next, c)}`
  return "no run ahead"
}

function setBy(w: any, me: any): string {
  if (w.set_by === me?.agent?.id) return "you"
  return w.set_by === "owner" ? "the owner" : `agent ${w.set_by}`
}

// What `set` tells: when the wake runs, its check and end, and delivery.
function setText(w: any, me: any): string {
  const c = clockOf(me)
  const trigger = String(w.trigger)
  const working = me?.agent?.status === "working"
  const parts = [`Wake "${w.name}" set: ${trigger}.`]
  const idle = idleOf(trigger)
  if (trigger === "fire-only")
    parts.push(
      "It runs only when fired: autocode_wake fire, or " +
        `\`autocode fire me ${w.name}\` from a script.`,
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
  if (w.check)
    parts.push(
      "Before each run its check runs in your folder: exit 0 wakes you " +
        "with its output, exit 1 skips that run.",
    )
  if (w.end)
    parts.push(`It is removed at ${localTime(Date.parse(w.end), c.tz)}.`)
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
        ...(input.end ? { end: input.end } : {}),
      })
      const me = await call("GET", "/v1/me")
      return setText(res.wake, me)
    }
    case "list":
    case "show": {
      const me = await call("GET", "/v1/me")
      const res = await call("GET", "/v1/me/wakes")
      const c = clockOf(me)
      const working = me?.agent?.status === "working"
      if (input.action === "show") {
        if (!input.name) return "error: show needs the wake's name"
        const w = res.wakes.find((x: any) => x.name === input.name)
        if (!w)
          return (
            `error: you have no wake "${input.name}" ` +
            "(autocode_wake list shows them)"
          )
        return [
          `Wake "${w.name}", set by ${setBy(w, me)} at ` +
            `${localTime(Date.parse(w.updated_at), c.tz)}.`,
          `Trigger: ${w.trigger}; ${timing(w, c, working)}.`,
          w.check
            ? `Check: ${w.check} (exit 0 wakes you with its output, exit 1 ` +
              "skips the run)."
            : "Check: none.",
          `Ends: ${w.end ? localTime(Date.parse(w.end), c.tz) : "never"}.`,
          "Last ran: " +
            (w.last_fired_at
              ? localTime(Date.parse(w.last_fired_at), c.tz)
              : "never") +
            ".",
          "Text:",
          w.text,
        ].join("\n")
      }
      if (!res.wakes.length)
        return "No wakes. Set one with autocode_wake action=set."
      const lines = [`Server time ${localTime(c.now, c.tz)} (${c.tz}).`]
      for (const w of res.wakes) {
        const parts = [timing(w, c, working)]
        if (w.check) parts.push(`check: ${w.check}`)
        if (w.end) parts.push(`ends ${localTime(Date.parse(w.end), c.tz)}`)
        // when it was last set (its schedule counts from then), and by whom
        // when not by you
        const by = setBy(w, me)
        parts.push(
          `last set ${localTime(Date.parse(w.updated_at), c.tz)}` +
            (by === "you" ? "" : ` by ${by}`),
        )
        if (w.last_fired_at)
          parts.push(`last ran ${localTime(Date.parse(w.last_fired_at), c.tz)}`)
        lines.push(`${w.name}: ${w.trigger}; ${parts.join("; ")}`)
        lines.push(`  ${preview(w.text)}`)
      }
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

// Reading and writing files in the agent's folder (files.ts).
export interface Files {
  read(path: string): Promise<{ text: string } | { data: string; mime: string }>
  write(path: string, base64: string): Promise<string>
}

function messageLine(m: any): string {
  const subject = m.subject ? ` "${m.subject}"` : ""
  const what = m.kind === "binary" ? `${m.mime}, ` : ""
  const sender = m.from === "owner" ? "the owner" : m.from
  return (
    `${m.id}  from ${sender}${subject}  ` +
    `${what}${m.size} characters  ${m.state}`
  )
}

export async function runMessage(
  input: MessageInput,
  call: Call,
  files: Files,
  wait?: (seconds: number) => Promise<any>,
): Promise<string> {
  switch (input?.action) {
    case "send": {
      if (!input.to) return "error: send needs to (an ID, a pattern or owner)"
      if (!input.text === !input.file)
        return "error: send needs either text or file"
      const content = input.file
        ? await files.read(input.file)
        : { text: input.text }
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
        ...content,
      })
      const ids = res.messages.map((m: any) => m.id).join(", ")
      return `Sent to ${res.recipients.join(", ")} (${ids}).`
    }
    case "list": {
      const res = await call("GET", "/v1/me/messages")
      if (!res.messages.length) return "No unread messages."
      return res.messages.map(messageLine).join("\n")
    }
    case "read": {
      if (!input.id) return "error: read needs the message's id"
      const res = await call("GET", `/v1/me/messages/${enc(input.id)}`)
      const m = res.message
      const sender = m.from === "owner" ? "the owner" : `agent ${m.from}`
      const head =
        `Message ${m.id} from ${sender}` +
        (m.subject ? `, subject "${m.subject}"` : "") +
        (m.reply_to ? `, in reply to ${m.reply_to}` : "")
      if (m.kind !== "binary") return `${head}:\n${m.text}`
      if (!input.path)
        return (
          `${head}: a file (${m.mime}, ${m.size} characters of base64). ` +
          "Read it again with a path to save it."
        )
      const saved = await files.write(input.path, m.data)
      return `${head}: saved ${m.mime} to ${saved}.`
    }
    case "wait": {
      const seconds = Math.max(1, Math.min(Number(input.seconds) || 300, 3600))
      const res = wait
        ? await wait(seconds)
        : await call("GET", `/v1/me/messages?wait=${seconds}`)
      if (!res.messages.length)
        return `No new messages within ${seconds} seconds.`
      return res.messages.map(messageLine).join("\n")
    }
    default:
      return "error: action must be send, list, read or wait"
  }
}
