/*
 * A session's earlier steps, as the plugin reads them from OpenCode's records
 * (spec, Costs and Caps: Before a session registered): the assistant and
 * compaction messages of the session and of its Subagents' sessions, page by
 * page through OpenCode's local API, reported in batches; and a compaction's
 * cost when its turn ends.
 */
import { describe, expect, test } from "bun:test"
import { account, childSessions, stepsOf } from "../../plugin/src/past.ts"

// A message of OpenCode 2.3.0, as GET /api/session/{id}/message gives it.
const assistant = (id: string, completed: number, cost?: number) => ({
  id,
  type: "assistant",
  time: { created: completed - 5000, completed },
  ...(cost === undefined ? {} : { cost }),
  tokens: { input: 2, output: 600 },
})
const compaction = (id: string, created: number, cost?: number) => ({
  id,
  type: "compaction",
  time: { created },
  status: cost === undefined ? "running" : "completed",
  ...(cost === undefined ? {} : { cost }),
})

/*
 * OpenCode's local API, played: sessions with their messages by type, pages
 * of `limit`, the next page by cursor.next, and never `order` with a cursor.
 */
function opencode(
  sessions: Record<string, { parent?: string; messages: any[] }>,
) {
  const asked: string[] = []
  const get = async (path: string): Promise<any> => {
    asked.push(path)
    const url = new URL(path, "http://local")
    const q = url.searchParams
    if (q.has("cursor") && q.has("order"))
      throw new Error("400: a cursor with an order")
    const limit = Number(q.get("limit") ?? 50)
    const from = q.has("cursor") ? Number(atob(q.get("cursor")!)) : 0
    let all: any[]
    if (url.pathname === "/api/session") {
      all = Object.entries(sessions)
        .filter(([, s]) => s.parent === q.get("parentID"))
        .map(([id]) => ({ id }))
    } else {
      const id = decodeURIComponent(url.pathname.split("/")[3] ?? "")
      const session = sessions[id]
      if (!session) throw new Error("404")
      // newest first, as order=desc asks
      all = session.messages
        .filter((m) => m.type === q.get("type"))
        .slice()
        .reverse()
    }
    const page = all.slice(from, from + limit)
    const more = from + limit < all.length
    return {
      data: page,
      cursor: more ? { next: btoa(String(from + limit)) } : {},
    }
  }
  return { get, asked }
}

describe("a page of messages", () => {
  test("a step is a message with a cost: its ID, when it ended, its dollars", () => {
    expect(
      stepsOf([
        assistant("msg_1", 1000, 0.25),
        // still running: no cost yet
        assistant("msg_2", 2000),
        compaction("msg_3", 3000, 0.4),
        { id: "msg_4", type: "assistant", time: {}, cost: 1 },
        { id: "msg_5", type: "assistant", time: { created: 5 }, cost: -1 },
        { id: 6, type: "assistant", time: { created: 5 }, cost: 1 },
        { id: "msg_7", type: "assistant", time: { created: 5 }, cost: "1" },
        null,
      ]),
    ).toEqual([
      ["msg_1", 1000, 0.25],
      ["msg_3", 3000, 0.4],
    ])
  })
})

describe("a session's Subagents", () => {
  test("its own and theirs, five levels deep, through every page", async () => {
    const sessions: Record<string, { parent?: string; messages: any[] }> = {
      ses_top: { messages: [] },
    }
    for (let i = 0; i < 5; i++)
      sessions[`ses_k${i}`] = { parent: "ses_top", messages: [] }
    sessions.ses_g = { parent: "ses_k0", messages: [] }
    let parent = "ses_g"
    for (let level = 3; level <= 7; level++) {
      sessions[`ses_l${level}`] = { parent, messages: [] }
      parent = `ses_l${level}`
    }
    const oc = opencode(sessions)
    const found = await childSessions(oc.get, "ses_top", 2)
    expect(found.sort()).toEqual(
      [
        "ses_g",
        "ses_k0",
        "ses_k1",
        "ses_k2",
        "ses_k3",
        "ses_k4",
        "ses_l3",
        "ses_l4",
        "ses_l5",
      ].sort(),
    )
    // pages of two: the next by its cursor
    expect(oc.asked.filter((p) => p.includes("parentID=ses_top")).length).toBe(
      3,
    )
  })

  test("a list that fails counts as none", async () => {
    const get = async () => {
      throw new Error("500")
    }
    expect(await childSessions(get, "ses_top")).toEqual([])
  })
})

describe("accounting for a session", () => {
  test("every step of the session and its Subagents, compactions too, in batches; it says how much it read", async () => {
    const oc = opencode({
      ses_top: {
        messages: [
          assistant("msg_1", 1000, 1),
          { id: "msg_u", type: "user", time: { created: 1500 } },
          assistant("msg_2", 2000, 2),
          compaction("msg_c", 2500, 0.5),
          assistant("msg_3", 3000, 3),
          assistant("msg_4", 4000),
        ],
      },
      ses_kid: {
        parent: "ses_top",
        messages: [assistant("msg_k1", 2100, 0.25)],
      },
      ses_other: { messages: [assistant("msg_x", 1, 9)] },
    })
    const sent: unknown[][] = []
    const result = await account(
      oc.get,
      "ses_top",
      (steps) => {
        sent.push(steps)
      },
      { limit: 2, batch: 3 },
    )
    expect(result).toEqual({ steps: 5, usd: 6.75, sessions: 2 })
    expect(sent.map((b) => b.length)).toEqual([3, 2])
    expect(sent.flat()).toEqual([
      ["msg_3", 3000, 3],
      ["msg_2", 2000, 2],
      ["msg_1", 1000, 1],
      ["msg_c", 2500, 0.5],
      ["msg_k1", 2100, 0.25],
    ])
    // the first page asks for an order, the later ones only for the cursor
    const pages = oc.asked.filter((p) =>
      p.startsWith("/api/session/ses_top/message?type=assistant"),
    )
    expect(pages.length).toBe(2)
    expect(pages[0]).toContain("order=desc")
    expect(pages[1]).toContain("cursor=")
    expect(pages[1]).not.toContain("order=")
  })

  test("only the steps before a time, when the server says one", async () => {
    const oc = opencode({
      ses_top: {
        messages: [
          assistant("msg_1", 1000, 1),
          assistant("msg_2", 2000, 2),
          assistant("msg_3", 3000, 3),
        ],
      },
    })
    const sent: unknown[][] = []
    const result = await account(
      oc.get,
      "ses_top",
      (steps) => {
        sent.push(steps)
      },
      { before: 2000 },
    )
    expect(result).toEqual({ steps: 1, usd: 1, sessions: 1 })
    expect(sent).toEqual([[["msg_1", 1000, 1]]])
  })

  test("a session whose messages cannot be read fails the whole: nothing half-counted is called whole", async () => {
    const get = async (path: string) => {
      if (path.startsWith("/api/session?")) return { data: [], cursor: {} }
      throw new Error("OpenCode's local API answered 500")
    }
    await expect(account(get, "ses_top", () => {})).rejects.toThrow("500")
  })

  test("a Subagent's session that went meanwhile is passed over", async () => {
    const oc = opencode({
      ses_top: { messages: [assistant("msg_1", 1000, 1)] },
    })
    const get = async (path: string) => {
      if (path.startsWith("/api/session?parentID=ses_top"))
        return { data: [{ id: "ses_gone" }], cursor: {} }
      return oc.get(path)
    }
    const result = await account(get, "ses_top", () => {})
    expect(result).toEqual({ steps: 1, usd: 1, sessions: 1 })
  })
})
