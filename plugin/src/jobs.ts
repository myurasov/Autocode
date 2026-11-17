/*
 * Runs of jobs in this folder (tier 0f): the server's spawn instruction
 * becomes a fresh session (ctx.session.create: this folder, the job's model
 * and variant, its OpenCode agent), remove deletes one (ctx.session.remove),
 * and a run's result, when it ends without finish, is its last reply: the
 * newest assistant message with text (a turn may end on a tool call). A
 * registered session's title is its agent ID, but a run's.
 */

/*
 * The title a registered session takes (the owner, 2026-11-17: "i want
 * opencode sessions to set their names to "@<agent-id>" upon registration"):
 * none for a run's session, which keeps its run's title, or with no agent.
 */
export function agentTitle(agent: string | null, run: boolean): string | null {
  return agent && !run ? `@${agent}` : null
}

/*
 * What still works in the background when a session's model work is done
 * (OpenCode 2.3's idle hook lists it): Subagents and images being made count,
 * as their results come to the session later, in turns of their own; a
 * background shell does not (starting one is the session's choice).
 */
export function backgroundCount(list: unknown): number {
  if (!Array.isArray(list)) return 0
  return list.filter((b) => b?.kind === "subagent" || b?.kind === "image")
    .length
}

/*
 * The Subagent sessions under a session, theirs included, each after the
 * ones under it: what an interrupt of the session must stop too. OpenCode
 * 2.3 runs Subagents in the background, also after their session's turn
 * ended; interrupting the session alone leaves them at work, and their
 * result then starts a turn in it (the review before 1.0.0). `children`
 * lists a session's own; a list that fails counts as empty. At most five
 * levels and a hundred sessions.
 */
export async function subagentSessions(
  children: (parent: string) => Promise<string[]>,
  session: string,
): Promise<string[]> {
  const out: string[] = []
  const seen = new Set([session])
  const under = async (parent: string, level: number) => {
    if (level > 5) return
    let list: string[] = []
    try {
      list = await children(parent)
    } catch {}
    for (const child of list) {
      if (seen.has(child) || seen.size > 100) continue
      seen.add(child)
      await under(child, level + 1)
      out.push(child)
    }
  }
  await under(session, 1)
  return out
}

/*
 * The sessions an interrupt stopped together with Subagents. OpenCode tells
 * a session that its Subagent was stopped, and that notice starts a turn in
 * it: for a short while after the interrupt (ms) a turn that starts there is
 * one to stop too (proven on OpenCode 2.3.0, tests/e2e/stop-all). What
 * Autocode itself types there later (the agent was resumed) forgets it.
 */
export class Stopping {
  private readonly until = new Map<string, number>()

  constructor(private readonly ms = 10_000) {}

  mark(session: string, now: number) {
    this.until.set(session, now + this.ms)
  }

  stops(session: string, now: number): boolean {
    const until = this.until.get(session)
    if (until === undefined) return false
    if (now <= until) return true
    this.until.delete(session)
    return false
  }

  forget(session: string) {
    this.until.delete(session)
  }

  get size(): number {
    return this.until.size
  }
}

/*
 * The counts the idle hook noted, by session and time. A turn's end takes
 * the newest one not after it (the hook runs just before the turn's end is
 * published), so a turn handled late never takes the next turn's count (the
 * review before 1.0.0). A few are kept per session, for sessions whose turn
 * ends are never seen.
 */
export class Background {
  private readonly noted = new Map<string, { at: number; count: number }[]>()

  note(session: string, at: number, count: number) {
    const list = this.noted.get(session) ?? []
    list.push({ at, count })
    this.noted.set(session, list.slice(-20))
  }

  take(session: string, at: number): number {
    const list = this.noted.get(session)
    if (!list) return 0
    const before = list.filter((n) => n.at <= at)
    const rest = list.filter((n) => n.at > at)
    if (rest.length) this.noted.set(session, rest)
    else this.noted.delete(session)
    return before.at(-1)?.count ?? 0
  }

  forget(session: string) {
    this.noted.delete(session)
  }

  get size(): number {
    let n = 0
    for (const list of this.noted.values()) n += list.length
    return n
  }
}

// What ctx.session.create is given for a spawn.
export function spawnInput(directory: string, p: any) {
  const model = String(p?.model ?? "")
  const at = model.indexOf("/")
  return {
    title: String(p?.title ?? p?.run ?? "run"),
    location: { directory },
    ...(at > 0
      ? {
          model: {
            providerID: model.slice(0, at),
            id: model.slice(at + 1),
            ...(p?.variant ? { variant: String(p.variant) } : {}),
          },
        }
      : {}),
    ...(p?.agent ? { agent: String(p.agent) } : {}),
  }
}

const textOf = (m: any) =>
  (Array.isArray(m?.content) ? m.content : [])
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n")
    .trim()

// The text of a session's newest assistant message that has text.
export function lastReply(messages: any[]): string | null {
  const replies = (Array.isArray(messages) ? messages : [])
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m?.type === "assistant")
    // newest first: by time, else by place in the list
    .sort(
      (a, b) =>
        Number(b.m?.time?.created ?? 0) - Number(a.m?.time?.created ?? 0) ||
        b.i - a.i,
    )
  for (const { m } of replies) {
    const text = textOf(m)
    if (text) return text
  }
  return null
}
