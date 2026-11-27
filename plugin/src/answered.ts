/*
 * The model that answered a claude-agent session (spec, Costs and Caps:
 * The model that answered; 1.1.0-rc7). OpenCode records the model that was
 * asked for; which model answered is only in the harness's own transcript.
 * OpenCode's last assistant message of the session names the harness's
 * session and message on its content (`native.sessionID`,
 * `native.messageID`); the harness keeps that session's transcript at
 * <its config folder>/projects/<folder>/<sessionID>.jsonl, where the
 * answer's line (`uuid`: that message) says `message.model` and
 * `requestedModel`.
 *
 * Neither the `native` field nor the transcript's layout is a published
 * interface: this module is the one place that depends on them. It reads
 * at most the end of the file, never a file whose name is not such an ID,
 * and says nothing when anything is missing.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Get } from "./past.ts"

// The harness names its sessions and messages by such IDs.
const ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
// A model's name as a provider writes it.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/
// The most of a transcript's end that is read.
const TAIL = 4 * 1024 * 1024

// The harness's own session and message behind an OpenCode message.
export interface Native {
  session: string
  message: string
}

// The model that answered, and the one that was asked for when the
// transcript says it.
export interface Answered {
  model: string
  requested?: string
}

// Of an assistant message of OpenCode's: the last content block that names
// the harness's session and message.
export function nativeOf(message: unknown): Native | undefined {
  const content = (message as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content)) return undefined
  for (let i = content.length - 1; i >= 0; i--) {
    const native = content[i]?.native
    if (
      typeof native?.sessionID === "string" &&
      typeof native?.messageID === "string"
    )
      return { session: native.sessionID, message: native.messageID }
  }
  return undefined
}

/*
 * Which model answered, from a transcript's text (its end): the line of
 * that message; else the last answer of the main thread. A Subagent's
 * thread in the same file and the harness's own made-up answers (a model
 * that is no model's name) are passed over.
 */
export function answeredIn(
  text: string,
  message?: string,
): Answered | undefined {
  const lines = text.split("\n")
  let last: Answered | undefined
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ""
    if (!line.includes('"assistant"')) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d?.type !== "assistant" || d.isSidechain) continue
    const model = d.message?.model
    if (typeof model !== "string" || !MODEL.test(model)) continue
    const found: Answered = {
      model,
      ...(typeof d.requestedModel === "string" && MODEL.test(d.requestedModel)
        ? { requested: d.requestedModel }
        : {}),
    }
    if (message && d.uuid === message) return found
    last ??= found
    // without a message to look for, the last answer is the one
    if (!message) return last
  }
  return last
}

// The harness's config folder: CLAUDE_CONFIG_DIR, else .claude in the home.
export function harnessHome(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
}

// The transcript of one of the harness's sessions, under whichever project
// folder holds it; none for a name that is no session's ID.
export function transcriptOf(
  home: string,
  session: string,
): string | undefined {
  if (!ID.test(session)) return undefined
  const projects = join(home, "projects")
  let folders: string[]
  try {
    folders = readdirSync(projects)
  } catch {
    return undefined
  }
  for (const folder of folders) {
    const path = join(projects, folder, `${session}.jsonl`)
    if (existsSync(path)) return path
  }
  return undefined
}

// The end of a file as text, at most `max` bytes of it.
export function tailOf(path: string, max = TAIL): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const size = fstatSync(fd).size
    const length = Math.min(size, max)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString("utf8")
  } catch {
    return undefined
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd)
      } catch {}
  }
}

/*
 * The model that answered an OpenCode session last: from its last assistant
 * message (OpenCode's local API) to the harness's transcript. Undefined
 * when the message names no harness session, the transcript is not there,
 * or it holds no answer; an API that cannot be read throws.
 */
export async function answeredBy(
  get: Get,
  session: string,
  home = harnessHome(),
): Promise<Answered | undefined> {
  const res = await get(
    `/api/session/${encodeURIComponent(session)}/message` +
      "?type=assistant&limit=1&order=desc",
  )
  const native = nativeOf(Array.isArray(res?.data) ? res.data[0] : undefined)
  if (!native) return undefined
  const path = transcriptOf(home, native.session)
  const text = path ? tailOf(path) : undefined
  return text ? answeredIn(text, native.message) : undefined
}
