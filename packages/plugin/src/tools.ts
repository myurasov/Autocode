/*
 * The agent tools: autocode_me (register, unregister, status, discover),
 * autocode_wake (set, list, cancel, fire) and autocode_message (send, list,
 * read, wait); later tiers add actions and tools. Descriptions stay short:
 * OpenCode sends them with every model call.
 */

export interface MeInput {
  action: "register" | "unregister" | "status" | "discover"
  id?: string
  description?: string
  pattern?: string
}

export const ME_TOOL = {
  name: "autocode_me",
  description:
    "Autocode: register this session as an agent, unregister, " +
    "see your status, or discover other agents. " +
    "Actions: register (id, description), unregister, status, " +
    "discover (pattern: IDs with * wildcards, or a comma list).",
  input: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["register", "unregister", "status", "discover"],
      },
      id: {
        type: "string",
        description: "register: your agent ID, like project:role:name",
      },
      description: {
        type: "string",
        description: "register: what you do, in a sentence",
      },
      pattern: {
        type: "string",
        description: "discover: which agents, like kaggle:* (default *)",
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

function agentLine(a: any): string {
  const desc = a.description ? `  ${a.description}` : ""
  return `${a.id}  ${a.status}  last active ${a.last_active}${desc}`
}

export async function runMe(input: MeInput, call: Call): Promise<string> {
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
      return `Registered as ${res.agent.id} (status ${res.agent.status}).`
    }
    case "unregister": {
      const res = await call("DELETE", "/v1/me")
      return `Unregistered ${res.unregistered}.`
    }
    case "status": {
      const res = await call("GET", "/v1/me")
      if (!res.registered)
        return (
          "Not registered. Register with action=register and an id like " +
          "project:role:name."
        )
      const a = res.agent
      return [
        `Registered as ${a.id}${a.description ? `: ${a.description}` : ""}.`,
        `Status ${a.status}; machine ${a.machine}; ` +
          `registered ${a.registered_at}; last active ${a.last_active}.`,
      ].join("\n")
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
    default:
      return "error: action must be register, unregister, status or discover"
  }
}

export interface WakeInput {
  action: "set" | "list" | "cancel" | "fire"
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
    "Autocode wakes: prompts Autocode injects into a session later. " +
    "Actions: set (name, trigger, text, check, end), list, cancel (name), " +
    "fire (agent, name, text). Triggers: every 30m, at 09:00, " +
    'cron "0 9 * * 1-5", idle 30m [repeat], fire-only.',
  input: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["set", "list", "cancel", "fire"] },
      name: {
        type: "string",
        description: "the wake's name, like daily-check",
      },
      text: {
        type: "string",
        description: "set: the prompt; fire: your extra text",
      },
      trigger: { type: "string", description: "set: when it runs" },
      check: {
        type: "string",
        description: "set: a command run first; exit 0 wakes, exit 1 skips",
      },
      end: { type: "string", description: "set: when it stops, a time" },
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
    "Autocode messages between agents and the owner. Actions: send (to: an " +
    "ID, a pattern, a list or owner; subject; text or file; reply_to), " +
    "list (unread), read (id; path to save a file), wait (seconds).",
  input: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["send", "list", "read", "wait"] },
      to: {
        type: "string",
        description: "send: team:b, team:*, a:b,c:d or owner",
      },
      subject: { type: "string" },
      text: { type: "string", description: "send: the message" },
      file: {
        type: "string",
        description: "send: a file in your folder, instead of text",
      },
      reply_to: { type: "string", description: "send: a message ID" },
      id: { type: "string", description: "read: the message ID" },
      path: {
        type: "string",
        description: "read: where to save a file message, in your folder",
      },
      seconds: { type: "number", description: "wait: at most this long" },
    },
    required: ["action"],
    additionalProperties: false,
  },
}

export const TOOLS = [ME_TOOL, WAKE_TOOL, MESSAGE_TOOL]

const enc = encodeURIComponent

function wakeLine(w: any): string {
  const parts = [`${w.name}  ${w.trigger}`]
  if (w.next) parts.push(`next ${w.next}`)
  if (w.check) parts.push(`check: ${w.check}`)
  if (w.end) parts.push(`until ${w.end}`)
  return `${parts.join("  ")}\n  ${w.text.split("\n")[0]}`
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
      const w = res.wake
      return (
        `Wake "${w.name}" set: ${w.trigger}` +
        (w.next ? `; next ${w.next}` : "") +
        "."
      )
    }
    case "list": {
      const res = await call("GET", "/v1/me/wakes")
      if (!res.wakes.length) return "No wakes."
      return res.wakes.map(wakeLine).join("\n")
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
      return `Fired wake "${input.name}" of ${agent}.`
    }
    default:
      return "error: action must be set, list, cancel or fire"
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
