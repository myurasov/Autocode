/*
 * A tool's wait inside a turn (autocode_message wait, autocode_approval
 * wait) lasts at most the agent's max_tool_wait. The documentation's fact
 * check before 1.0.0: the server caps each call of a wait, and the plugin
 * asked again until `seconds` had passed, so with the default of 5 minutes a
 * wait of 900 s lasted 900 s.
 */
import { describe, expect, test } from "bun:test"
import { waitInCalls } from "../../plugin/src/waits.ts"

// A server that answers nothing: each call lasts what it was asked for, or
// what the server's own cap allows.
function server(cap = Number.POSITIVE_INFINITY) {
  let at = 0
  const calls: number[] = []
  return {
    calls,
    now: () => at,
    elapsed: () => at / 1000,
    ask: async (seconds: number) => {
      calls.push(seconds)
      at += Math.min(seconds, cap) * 1000
      return { messages: [] as string[] }
    },
  }
}
const done = (res: { messages: string[] }) => res.messages.length > 0

describe("a tool's wait", () => {
  test("lasts at most max_tool_wait, in calls of at most 240 s", async () => {
    const s = server()
    await waitInCalls({ seconds: 900, most: async () => 300, ...s, done })
    expect(s.calls).toEqual([240, 60])
    expect(s.elapsed()).toBe(300)
    const long = server()
    await waitInCalls({ seconds: 3600, most: async () => 1800, ...long, done })
    expect(long.elapsed()).toBe(1800)
    expect(Math.max(...long.calls)).toBe(240)
  })

  test("lasts its seconds when they are fewer", async () => {
    const s = server()
    await waitInCalls({ seconds: 120, most: async () => 300, ...s, done })
    expect(s.calls).toEqual([120])
  })

  test("ends at once with an answer", async () => {
    let at = 0
    const res = await waitInCalls({
      seconds: 900,
      most: async () => 300,
      now: () => at,
      ask: async () => {
        at += 5000
        return { messages: ["hello"] }
      },
      done,
    })
    expect(res.messages).toEqual(["hello"])
    expect(at).toBe(5000)
  })

  test("without the setting (the status could not be read): its seconds, or until the server cuts a call short", async () => {
    const s = server()
    await waitInCalls({
      seconds: 500,
      most: async () => {
        throw new Error("down")
      },
      ...s,
      done,
    })
    expect(s.calls).toEqual([240, 240, 20])
    // the server's own cap (a max_tool_wait under 240 s) ends it
    const cut = server(60)
    await waitInCalls({
      seconds: 500,
      most: async () => undefined,
      ...cut,
      done,
    })
    expect(cut.calls).toEqual([240])
    expect(cut.elapsed()).toBe(60)
  })
})
