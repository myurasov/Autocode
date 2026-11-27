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
 * and says nothing when anything is missing. Its file work does not hold
 * the plugin's event loop.
 */
import { open, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Get } from "./past.ts"

// The harness names its sessions and messages by such IDs.
const ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
// A model's name as a provider writes it; the harness may add the model's
// window in brackets ("claude-x[1m]"), which is not part of the name.
const MODEL =
  /^([A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199})(?:\[[A-Za-z0-9]{1,20}\])?$/
// The most of a transcript's end that is read.
const TAIL = 4 * 1024 * 1024
// The most sessions whose last report, or transcript's place, is kept.
const KEPT = 1000

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

// A model's name without a bracket suffix; none for what is no name.
function modelName(value: unknown): string | undefined {
  return typeof value === "string" ? MODEL.exec(value)?.[1] : undefined
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
    const model = modelName(d.message?.model)
    if (!model) continue
    const requested = modelName(d.requestedModel)
    const found: Answered = { model, ...(requested ? { requested } : {}) }
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

const isFile = async (path: string) =>
  (await stat(path).catch(() => undefined))?.isFile() === true

// Where each session's transcript was found last, by its config folder.
const places = new Map<string, string>()

/*
 * The transcript of one of the harness's sessions, under whichever project
 * folder holds it; none for a name that is no session's ID. Where it was
 * found is kept, so that the folders are listed once per session and not
 * at every turn's end; a file that is no longer there is looked for again.
 */
export async function transcriptOf(
  home: string,
  session: string,
): Promise<string | undefined> {
  if (!ID.test(session)) return undefined
  const key = `${home}\n${session}`
  const kept = places.get(key)
  if (kept && (await isFile(kept))) return kept
  places.delete(key)
  const projects = join(home, "projects")
  const folders = await readdir(projects).catch(() => [] as string[])
  for (const folder of folders) {
    const path = join(projects, folder, `${session}.jsonl`)
    if (!(await isFile(path))) continue
    places.set(key, path)
    while (places.size > KEPT)
      places.delete(places.keys().next().value as string)
    return path
  }
  return undefined
}

// The end of a regular file as text, at most `max` bytes of it.
export async function tailOf(
  path: string,
  max = TAIL,
): Promise<string | undefined> {
  const file = await open(path, "r").catch(() => undefined)
  if (!file) return undefined
  try {
    const info = await file.stat()
    if (!info.isFile()) return undefined
    const length = Math.min(info.size, max)
    const buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, info.size - length)
    return buffer.toString("utf8")
  } catch {
    return undefined
  } finally {
    await file.close().catch(() => {})
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
  const path = await transcriptOf(home, native.session)
  const text = path ? await tailOf(path) : undefined
  return text ? answeredIn(text, native.message) : undefined
}

/*
 * What the plugin said last for each session, so that it reports the
 * answering model only when it is another. A session is forgotten when it
 * leaves the claude-agent provider, registers or is deleted, and all are
 * when the plugin says hello again: the server forgets an agent's
 * answering model at the first two, and the next answer is said anew.
 */
export class Said {
  private readonly last = new Map<string, string>()

  // Whether this is another than was said last for the session; it is
  // then what was said last.
  news(session: string, found: Answered): boolean {
    const key = `${found.model}\n${found.requested ?? ""}`
    if (this.last.get(session) === key) return false
    this.last.delete(session)
    this.last.set(session, key)
    while (this.last.size > KEPT)
      this.last.delete(this.last.keys().next().value as string)
    return true
  }

  forget(session: string) {
    this.last.delete(session)
  }

  clear() {
    this.last.clear()
  }

  get size(): number {
    return this.last.size
  }
}
