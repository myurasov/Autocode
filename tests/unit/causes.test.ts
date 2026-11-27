/*
 * What started a turn, from the summary of the prompt that started it, and
 * how a step's dollars are divided among the kinds (1.1.0-rc7).
 */
import { describe, expect, test } from "bun:test"
import { promptCause } from "@autocode/server/causes"
import { splitStep, stepTokens } from "@autocode/server/cost-parts"

const summary = (header: string[], more: Record<string, unknown> = {}) => ({
  header,
  wakes: [],
  messages: [],
  ...more,
})

describe("the cause of a prompt's turn", () => {
  test("one cause per prompt, by the first of what it carries", () => {
    expect(promptCause(summary(['wake "hourly"'], { wakes: ["hourly"] }))).toBe(
      "wake",
    )
    expect(promptCause(summary(["1 message"], { messages: ["m_1"] }))).toBe(
      "message",
    )
    // a wake goes before the messages that came along
    expect(
      promptCause(
        summary(['wake "w"', "2 messages"], {
          wakes: ["w"],
          messages: ["m_1", "m_2"],
        }),
      ),
    ).toBe("wake")
    // Autocode's own notices, by their subjects
    expect(
      promptCause(summary(["result of run r_1"], { notices: ["m_1"] })),
    ).toBe("job")
    expect(promptCause(summary(["run r_1 failed"], { notices: ["m_1"] }))).toBe(
      "job",
    )
    expect(
      promptCause(summary(['approval "Deploy" approved'], { notices: ["m"] })),
    ).toBe("ask")
    expect(
      promptCause(summary(['question from team:b: "Which?"'], { notices: [] })),
    ).toBe("ask")
    expect(
      promptCause(summary(["compaction done"], { notices: ["m_1"] })),
    ).toBe("compaction")
    expect(
      promptCause(summary(['lock "gpu" granted'], { notices: ["m"] })),
    ).toBe("other")
    expect(promptCause(summary(["cost warning"], { notices: ["m"] }))).toBe(
      "other",
    )
    // "compaction done" comes with what waited: the messages' turn
    expect(
      promptCause(
        summary(["compaction done", "1 message"], {
          notices: ["m_0"],
          messages: ["m_1"],
        }),
      ),
    ).toBe("message")
    // the compaction notice, a retry and a resume go first
    expect(
      promptCause(
        summary(["compaction next"], { retry: 0, compact_notice: true }),
      ),
    ).toBe("compaction")
    expect(promptCause(summary(["compaction next"], { retry: 0 }))).toBe(
      "compaction",
    )
    expect(
      promptCause(
        summary(["retry 2", "1 message"], { retry: 2, messages: ["m"] }),
      ),
    ).toBe("retry")
    expect(promptCause(summary(["resume"], { retry: 0 }))).toBe("retry")
  })

  test("a summary that says its cause is taken at its word; what cannot be read is other", () => {
    expect(promptCause({ cause: "job", wakes: ["w"], header: [] })).toBe("job")
    // not a cause a prompt can have
    expect(promptCause({ cause: "owner", wakes: ["w"], header: [] })).toBe(
      "wake",
    )
    expect(promptCause({ cause: "nonsense", header: ["1 message"] })).toBe(
      "other",
    )
    for (const bad of [null, undefined, "x", 3, {}, { header: "x" }])
      expect(promptCause(bad)).toBe("other")
  })
})

describe("a step's dollars by kind", () => {
  const rates = { input: 3, output: 15, read: 0.3, write: 3.75 }
  const tokens = { input: 1000, output: 2000, read: 100_000, write: 20_000 }

  test("in the proportion of tokens times rate, adding up to the step's dollars", () => {
    expect(splitStep(0.138, tokens, rates)).toEqual({
      input: 0.003,
      output: 0.03,
      read: 0.03,
      write: 0.075,
    })
    const twice = splitStep(0.276, tokens, rates)!
    expect(twice.write).toBeCloseTo(0.15, 9)
    expect(twice.input + twice.output + twice.read + twice.write).toBeCloseTo(
      0.276,
      9,
    )
    // a free step is split into nothing
    expect(splitStep(0, tokens, rates)).toEqual({
      input: 0,
      output: 0,
      read: 0,
      write: 0,
    })
  })

  // The review before 1.1.0-rc7: each part was rounded to a millionth of
  // a dollar, so a thousand small steps showed parts of 107% of the spend.
  test("the parts add up to the step's dollars, however small the step", () => {
    const even = { input: 1, output: 1, read: 0, write: 0 }
    const flat = { input: 1, output: 1, read: 1, write: 1 }
    const tiny = splitStep(0.0000016, even, flat)!
    expect(tiny.input + tiny.output + tiny.read + tiny.write).toBeCloseTo(
      0.0000016,
      12,
    )
    expect(tiny.input).toBeCloseTo(0.0000008, 12)
    let sum = 0
    for (let i = 0; i < 1000; i++) {
      const part = splitStep(0.0000149, tokens, rates)!
      for (const usd of Object.values(part))
        expect(usd).toBeGreaterThanOrEqual(0)
      sum += part.input + part.output + part.read + part.write
    }
    expect(sum).toBeCloseTo(0.0149, 9)
  })

  test("not split without tokens, without rates, or with nothing to weigh", () => {
    expect(splitStep(1, null, rates)).toBeNull()
    expect(splitStep(1, tokens, undefined)).toBeNull()
    expect(
      splitStep(1, tokens, { input: 0, output: 0, read: 0, write: 0 }),
    ).toBeNull()
    expect(
      splitStep(1, { input: 0, output: 0, read: 0, write: 0 }, rates),
    ).toBeNull()
    for (const bad of [
      { input: -1, output: 1, read: 1, write: 1 },
      { input: Number.NaN, output: 1, read: 1, write: 1 },
      { input: 1, output: 1, read: 1 },
      { input: "3", output: 1, read: 1, write: 1 },
      { input: 1e9, output: 1, read: 1, write: 1 },
      "x",
      [],
    ])
      expect(splitStep(1, tokens, bad)).toBeNull()
  })

  test("a step's tokens: whole numbers of a sane size, each kind on its own", () => {
    expect(stepTokens({ tokens })).toEqual(tokens)
    expect(
      stepTokens({
        tokens: { input: 10.6, output: "x", read: -5, write: 1e12 },
      }),
    ).toEqual({ input: 11, output: 0, read: 0, write: 0 })
    expect(stepTokens({ tokens: { input: 5 } })).toEqual({
      input: 5,
      output: 0,
      read: 0,
      write: 0,
    })
    expect(stepTokens({})).toBeNull()
    expect(stepTokens({ tokens: "x" })).toBeNull()
  })
})
