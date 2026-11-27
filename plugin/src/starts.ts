/*
 * What started a session's turn (1.1.0-rc2; the owner, 2026-11-20: a wake's
 * cost must count the turns that OpenCode's own notices start). OpenCode
 * announces each input of a session before the turn it starts, and says
 * when it was delivered or cancelled (seen on 2.3.0 in an idle session:
 * session.inbox.enqueued, 2 ms later session.execution.started, then
 * session.inbox.delivered). A typed prompt, the owner's or Autocode's, is
 * `user`; OpenCode's own input, a Subagent's result or a background
 * shell's end, is `synthetic`: a `notice` here. The oldest input that still
 * waits when a turn starts is what started it.
 *
 * Exact attribution (the owner, 2026-11-21: "ok, lets build it!"): a notice
 * names its work, the command or the Subagent, and the server is told which
 * work outlives its turn, so that the notice's turn and a Subagent's steps
 * count for the wake whose turn started the work. A Subagent is reported
 * when its session is created; a command (OpenCode says shell.created and
 * shell.exited for every one, in the foreground too) when it still runs at
 * its session's turn end.
 */

// The most inputs kept for one session (their deliveries were never seen).
const KEPT = 50

/*
 * An inbox item's kind, as the server is told: "user", "notice" (OpenCode's
 * synthetic input), "compaction", or the item's own type when it is another
 * short word; nothing for what is no item.
 */
export function inputKind(item: unknown): string | undefined {
  const type = (item as { type?: unknown } | null | undefined)?.type
  if (typeof type !== "string" || !/^[a-z][a-z-]{0,23}$/.test(type))
    return undefined
  return type === "synthetic" ? "notice" : type
}

/*
 * The work a notice belongs to: a background command's ID (shellID) or a
 * Subagent's session (childID), from the input's metadata; none for any
 * other input.
 */
export function inputRef(item: unknown): string | undefined {
  if (inputKind(item) !== "notice") return undefined
  const meta = (item as any)?.payload?.metadata
  for (const ref of [meta?.shellID, meta?.childID])
    if (typeof ref === "string" && ref && ref.length <= 200) return ref
  return undefined
}

/*
 * What started a turn: the input's kind; for a notice its work; for a
 * typed prompt its ID (1.1.0-rc7). OpenCode announces a prompt under the
 * ID it was given, and Autocode's server gives each of its prompts one: so
 * the server knows which of its prompts started the turn, also a steer
 * prompt that came just after the turn it was meant for had ended.
 */
export interface Starter {
  by: string
  ref?: string
  prompt?: string
}

// A prompt's ID as OpenCode and Autocode's server write them.
const PROMPT_ID = /^[A-Za-z0-9_-]{1,200}$/

// The inputs that wait in each session, oldest first.
export class Inputs {
  private readonly waiting = new Map<string, Map<string, Starter>>()

  // OpenCode announced an input (session.inbox.enqueued).
  enqueued(session: string, id: string, item: unknown) {
    const kind = inputKind(item)
    if (!kind) return
    const ref = inputRef(item)
    const list = this.waiting.get(session) ?? new Map<string, Starter>()
    list.set(id, {
      by: kind,
      ...(ref ? { ref } : {}),
      ...(kind === "user" && PROMPT_ID.test(id) ? { prompt: id } : {}),
    })
    while (list.size > KEPT) list.delete(list.keys().next().value as string)
    this.waiting.set(session, list)
  }

  // It was delivered into a turn, or cancelled.
  settled(session: string, id: string) {
    const list = this.waiting.get(session)
    if (!list?.delete(id)) return
    if (!list.size) this.waiting.delete(session)
  }

  // What starts the turn that starts now: the oldest input that waits.
  starter(session: string): Starter | undefined {
    return this.waiting.get(session)?.values().next().value
  }

  forget(session: string) {
    this.waiting.delete(session)
  }

  // Events were missed (the stream ended): what waits is not known.
  clear() {
    this.waiting.clear()
  }

  get size(): number {
    let n = 0
    for (const list of this.waiting.values()) n += list.size
    return n
  }
}

// The most commands kept in all (their ends were never seen).
const SHELLS_KEPT = 500

/*
 * The commands that run now, by their session. One that still runs when its
 * session's turn ends outlives the turn: it is taken then, once, to be
 * reported as that turn's work.
 */
export class Shells {
  private readonly running = new Map<string, string>()

  // OpenCode started a command (shell.created).
  created(id: string, session: string) {
    if (
      typeof id !== "string" ||
      !id ||
      typeof session !== "string" ||
      !session
    )
      return
    this.running.set(id, session)
    while (this.running.size > SHELLS_KEPT)
      this.running.delete(this.running.keys().next().value as string)
  }

  // It ended (shell.exited).
  exited(id: string) {
    this.running.delete(id)
  }

  // The session's commands that still run, taken out: its turn ended.
  take(session: string): string[] {
    const out: string[] = []
    for (const [id, of] of this.running)
      if (of === session) {
        out.push(id)
        this.running.delete(id)
      }
    return out
  }

  forget(session: string) {
    this.take(session)
  }

  // Events were missed (the stream ended): what runs is not known.
  clear() {
    this.running.clear()
  }

  get size(): number {
    return this.running.size
  }
}
