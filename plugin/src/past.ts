/*
 * A session's steps as OpenCode's own records keep them (spec, Costs and
 * Caps: Before a session registered): its assistant and compaction messages,
 * each with its cost and time, from the local API's published route (GET
 * /api/session/{id}/message, by type, page by page: the next page by
 * cursor.next, never together with `order`), and the same for its Subagents'
 * sessions (GET /api/session?parentID=). The plugin reads them when the
 * server asks it to account for a session that registered, and reads a
 * compaction's cost when the compaction's turn ends (OpenCode ends one with
 * no session.step.ended).
 */

// A step: its message's ID, when it ended (ms), its dollars.
export type PastStep = [id: string, at: number, usd: number]

// A GET on OpenCode's local API: the body as it came, `data` and `cursor`.
export type Get = (path: string) => Promise<any>

const enc = encodeURIComponent

// The steps among a page of messages: those that have a cost.
export function stepsOf(items: unknown): PastStep[] {
  const out: PastStep[] = []
  if (!Array.isArray(items)) return out
  for (const item of items as any[]) {
    if (!item || typeof item.id !== "string" || !item.id) continue
    const usd = item.cost
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) continue
    const at = Number(item.time?.completed ?? item.time?.created)
    if (!Number.isFinite(at)) continue
    out.push([item.id, at, usd])
  }
  return out
}

// Every page of a list, newest first.
async function pages(
  get: Get,
  path: string,
  limit: number,
  each: (items: any[]) => void | Promise<void>,
  maxPages = 10_000,
) {
  const join = path.includes("?") ? "&" : "?"
  let query = `${join}limit=${limit}&order=desc`
  for (let page = 0; page < maxPages; page++) {
    const res = await get(`${path}${query}`)
    const items = Array.isArray(res?.data) ? res.data : []
    await each(items)
    const next = res?.cursor?.next
    if (!items.length || typeof next !== "string" || !next) return
    query = `${join}limit=${limit}&cursor=${enc(next)}`
  }
}

/*
 * The sessions under a session: its Subagents' and theirs, at most five
 * levels and 5,000 sessions; a list that fails counts as none.
 */
export async function childSessions(
  get: Get,
  session: string,
  limit = 200,
): Promise<string[]> {
  const out: string[] = []
  const seen = new Set([session])
  const under = async (parent: string, level: number) => {
    if (level > 5) return
    const own: string[] = []
    try {
      await pages(
        get,
        `/api/session?parentID=${enc(parent)}`,
        limit,
        (items) => {
          for (const item of items)
            if (typeof item?.id === "string") own.push(item.id)
        },
      )
    } catch {}
    for (const child of own) {
      if (seen.has(child) || seen.size > 5000) continue
      seen.add(child)
      out.push(child)
      await under(child, level + 1)
    }
  }
  await under(session, 1)
  return out
}

/*
 * Accounts for a session: every step of the session and of its Subagents'
 * sessions (before a time, when the server names one: an agent that was
 * registered already had its later steps counted as they ran), handed over
 * in batches; what it read. The session's own messages must be readable; a
 * Subagent's session that went meanwhile is passed over.
 */
export async function account(
  get: Get,
  session: string,
  send: (steps: PastStep[]) => void | Promise<void>,
  options: { before?: number; limit?: number; batch?: number } = {},
): Promise<{ steps: number; usd: number; sessions: number }> {
  const limit = options.limit ?? 200
  const batch = options.batch ?? 500
  let buffer: PastStep[] = []
  let steps = 0
  let usd = 0
  let sessions = 0
  const flush = async (all = false) => {
    while (buffer.length >= batch || (all && buffer.length)) {
      await send(buffer.slice(0, batch))
      buffer = buffer.slice(batch)
    }
  }
  const read = async (id: string) => {
    for (const type of ["assistant", "compaction"])
      await pages(
        get,
        `/api/session/${enc(id)}/message?type=${type}`,
        limit,
        async (items) => {
          for (const step of stepsOf(items)) {
            if (options.before !== undefined && step[1] >= options.before)
              continue
            buffer.push(step)
            steps += 1
            usd += step[2]
          }
          await flush()
        },
      )
    sessions += 1
  }
  await read(session)
  for (const child of await childSessions(get, session, limit))
    try {
      await read(child)
    } catch {}
  await flush(true)
  return { steps, usd: Math.round(usd * 1e6) / 1e6, sessions }
}
