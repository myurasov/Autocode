/*
 * What a session spends outside its steps (1.1.2; the owner, 2026-11-27:
 * "yes as 1.1.2"). OpenCode's cache warming keeps a session's cache alive
 * with requests that leave no message, so no step event has their cost.
 * OpenCode tells a plugin the session's totals after every request
 * (session.usage.updated; pinned on real OpenCode by
 * tests/plugin/spike-1-inprocess.test.ts): a step, a title and a compaction
 * move them while a turn runs, a warming ping while the session idles. A
 * rise of the totals in an idle session is therefore a ping.
 */
import { describe, expect, test } from "bun:test"
import { GRACE_MS, Outside, pingEvent } from "../../plugin/src/usage.ts"

const T0 = 1_800_000_000_000
let ids = 0
// OpenCode's announcement of a session's totals.
const totals = (
  cost: number,
  at: number,
  tokens: Record<string, unknown> = {},
) => ({
  id: `evt_${++ids}`,
  type: "session.usage.updated",
  created: at,
  data: {
    sessionID: "ses_a",
    cost,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      ...tokens,
    },
  },
})

describe("usage outside the steps", () => {
  test("a rise of an idle session's totals is a ping: its dollars, its tokens by kind, the announcement's ID and time", () => {
    const o = new Outside()
    // the first totals seen are where the count starts
    expect(o.updated("ses_a", totals(1, T0, { input: 500 }))).toBeUndefined()
    const ping = totals(1.0361, T0 + 60_000, {
      input: 510,
      output: 3,
      reasoning: 2,
      cache: { read: 120_000, write: 40 },
    })
    expect(o.updated("ses_a", ping)).toEqual({
      ref: ping.id,
      at: T0 + 60_000,
      usd: 0.0361,
      tokens: { input: 10, output: 5, read: 120_000, write: 40 },
    })
    // the next one counts from there
    const next = totals(1.0561, T0 + 120_000, {
      input: 515,
      output: 3,
      reasoning: 2,
      cache: { read: 180_000, write: 40 },
    })
    expect(o.updated("ses_a", next)).toEqual({
      ref: next.id,
      at: T0 + 120_000,
      usd: 0.02,
      tokens: { input: 5, output: 0, read: 60_000, write: 0 },
    })
  })

  test("what moves the totals while a turn runs is the turn's: its steps, a title, a compaction", () => {
    const o = new Outside()
    o.updated("ses_a", totals(1, T0))
    o.turn("ses_a", "started", T0 + 1000)
    // a title, a step, another step
    for (const [n, cost] of [1.0005, 1.0028, 1.0052].entries())
      expect(o.updated("ses_a", totals(cost, T0 + 1100 + n))).toBeUndefined()
    o.turn("ses_a", "succeeded", T0 + 2000)
    // a ping a while later counts from the turn's last totals
    expect(o.updated("ses_a", totals(1.0252, T0 + 300_000))?.usd).toBe(0.02)
    // a compaction is a turn of its own
    o.turn("ses_a", "started", T0 + 400_000)
    expect(o.updated("ses_a", totals(1.2, T0 + 400_500))).toBeUndefined()
    o.turn("ses_a", "interrupted", T0 + 401_000)
    expect(o.updated("ses_a", totals(1.22, T0 + 700_000))?.usd).toBe(0.02)
  })

  test("a step that ends marks its session's turn as running, also when the turn's start was not seen", () => {
    const o = new Outside()
    o.updated("ses_a", totals(1, T0))
    // the plugin started in the middle of a turn
    o.step("ses_a")
    expect(o.updated("ses_a", totals(1.5, T0 + 1000))).toBeUndefined()
    o.step("ses_a")
    expect(o.updated("ses_a", totals(2, T0 + 2000))).toBeUndefined()
    o.turn("ses_a", "succeeded", T0 + 3000)
    expect(o.updated("ses_a", totals(2.02, T0 + 300_000))?.usd).toBe(0.02)
  })

  test("just after a turn ended nothing counts: what comes late is the turn's", () => {
    const o = new Outside()
    o.updated("ses_a", totals(1, T0))
    o.turn("ses_a", "started", T0)
    o.turn("ses_a", "succeeded", T0 + 1000)
    expect(
      o.updated("ses_a", totals(1.3, T0 + 1000 + GRACE_MS - 1)),
    ).toBeUndefined()
    // and it is where the next count starts
    expect(o.updated("ses_a", totals(1.32, T0 + 1000 + GRACE_MS))?.usd).toBe(
      0.02,
    )
    expect(GRACE_MS).toBe(5000)
  })

  test("totals that stay or fall, and totals that cannot be read, count for nothing", () => {
    const o = new Outside()
    o.updated("ses_a", totals(1, T0))
    expect(o.updated("ses_a", totals(1, T0 + 60_000))).toBeUndefined()
    // a session cut back to an earlier point
    expect(o.updated("ses_a", totals(0.4, T0 + 120_000))).toBeUndefined()
    expect(o.updated("ses_a", totals(0.42, T0 + 180_000))?.usd).toBe(0.02)
    for (const bad of [
      undefined,
      {},
      { data: {} },
      { data: { cost: "1" } },
      { data: { cost: Number.NaN } },
      { data: { cost: -1 } },
    ])
      expect(o.updated("ses_a", bad)).toBeUndefined()
    // unreadable totals leave the last ones in place
    expect(o.updated("ses_a", totals(0.44, T0 + 240_000))?.usd).toBe(0.02)
  })

  test("without tokens it says none; without a time it says none; without an ID it is named by what it says, the same wherever it is read", () => {
    const read = () => {
      const o = new Outside()
      o.updated("ses_a", { data: { cost: 1 } })
      return o.updated("ses_a", { created: T0, data: { cost: 1.5 } })!
    }
    const found = read()
    expect(found.usd).toBe(0.5)
    expect("tokens" in found).toBe(false)
    expect(found.ref).toBe(`usage-ses_a-${T0}-1.5`)
    // another plugin instance names it the same: it counts once
    expect(read().ref).toBe(found.ref)
    const o = new Outside()
    o.updated("ses_a", { data: { cost: 1 } })
    expect("at" in o.updated("ses_a", { data: { cost: 1.5 } })!).toBe(false)
  })

  test("each session has its own totals; a forgotten session starts again; a new event stream starts every count again", () => {
    const o = new Outside()
    o.updated("ses_a", totals(1, T0))
    expect(o.updated("ses_b", totals(5, T0 + 1000))).toBeUndefined()
    expect(o.updated("ses_b", totals(5.25, T0 + 60_000))?.usd).toBe(0.25)
    o.forget("ses_b")
    expect(o.updated("ses_b", totals(9, T0 + 120_000))).toBeUndefined()
    // totals announced while the stream was down were missed: a rise since
    // then may hold a step
    o.clear()
    expect(o.updated("ses_a", totals(3, T0 + 180_000))).toBeUndefined()
    expect(o.updated("ses_a", totals(3.02, T0 + 240_000))?.usd).toBe(0.02)
  })

  test("a new event stream: no turn is taken to run until one is seen again, and every count starts from the next totals", () => {
    const o = new Outside()
    o.updated("ses_a", totals(1, T0))
    o.turn("ses_a", "started", T0 + 1000)
    // the turn's end was not seen: the stream was down, and is new now
    o.clear()
    // the first totals since: where the count starts (they may hold steps)
    expect(o.updated("ses_a", totals(1.5, T0 + 600_000))).toBeUndefined()
    // the session idles: a ping counts again
    expect(o.updated("ses_a", totals(1.52, T0 + 660_000))?.usd).toBe(0.02)
    // a turn that runs across a new stream shows by its next step's end
    o.turn("ses_a", "started", T0 + 700_000)
    o.clear()
    o.updated("ses_a", totals(1.6, T0 + 701_000))
    o.step("ses_a")
    expect(o.updated("ses_a", totals(1.9, T0 + 702_000))).toBeUndefined()
  })

  test("while a compaction runs nothing is taken from the totals, whatever is known of its turn", () => {
    const o = new Outside()
    o.updated("ses_a", totals(1, T0))
    // its turn's start was not seen (a new stream), its own start was
    o.compaction("ses_a", true)
    expect(o.updated("ses_a", totals(1.4, T0 + 60_000))).toBeUndefined()
    o.compaction("ses_a", false)
    expect(o.updated("ses_a", totals(1.42, T0 + 120_000))?.usd).toBe(0.02)
    // one whose end was not said ends with its turn
    o.compaction("ses_a", true)
    o.turn("ses_a", "failed", T0 + 200_000)
    expect(o.updated("ses_a", totals(1.44, T0 + 300_000))?.usd).toBe(0.02)
    // and with a new stream
    o.compaction("ses_a", true)
    o.clear()
    o.updated("ses_a", totals(1.5, T0 + 400_000))
    expect(o.updated("ses_a", totals(1.52, T0 + 500_000))?.usd).toBe(0.02)
  })

  test("the report of a ping: a generate request's cost, with the model's rates when they are known", () => {
    const ping = {
      ref: "evt_9",
      at: T0,
      usd: 0.0361,
      tokens: { input: 10, output: 5, read: 120_000, write: 0 },
    }
    const rates = { input: 3, output: 15, read: 0.3, write: 3.75 }
    expect(pingEvent("ses_a", ping, rates)).toEqual({
      type: "cost.usage",
      session: "ses_a",
      source: "generate",
      ...ping,
      rates,
    })
    expect("rates" in pingEvent("ses_a", ping)).toBe(false)
  })

  test("dollars are said to a billionth", () => {
    const o = new Outside()
    o.updated("ses_a", totals(0.1, T0))
    expect(o.updated("ses_a", totals(0.1 + 0.2, T0 + 60_000))?.usd).toBe(0.2)
  })
})
