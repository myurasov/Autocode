/*
 * An agent's model as the server learns it (1.1.0-rc7): at a turn's start
 * already, not only when its first step ends; History says when it changed
 * (agent.model); and for a claude-agent session, which model answered and
 * which was asked for.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ack,
  call,
  hello,
  instructions,
  registered,
  report,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

let t: TestServer
const HOST = "m:1"

const owner = (method: string, path: string, body?: unknown) =>
  call(t.url, t.admin, method, path, body)
const agent = async () => (await owner("GET", "/v1/agents/team:a")).body.agent
const changes = async () =>
  (await owner("GET", "/v1/history?kind=agent.model")).body.history
    .map((h: any) => [h.agent, h.data])
    .reverse()

let steps = 0
const step = (more: Record<string, unknown> = {}) => ({
  type: "cost",
  session: "ses_a",
  usd: 0.01,
  context: 1000,
  limit: 200_000,
  model: "fake/main",
  model_name: "Main 1",
  effort: "high",
  step: `st_${++steps}`,
  ...more,
})
const started = (more: Record<string, unknown> = {}) => ({
  type: "turn.started",
  session: "ses_a",
  by: "user",
  ...more,
})

beforeEach(async () => {
  steps = 0
  t = await testServer()
  await hello(t, HOST)
  await registered(t, HOST, "ses_a", "team:a")
  for (const i of await instructions(t, HOST)) await ack(t, HOST, i.id)
})
afterEach(() => t.stop())

describe("the model at a turn's start", () => {
  test("a turn's start says the session's model: the agent shows it before any step ends", async () => {
    await report(t, HOST, [
      started({
        model: "hub/kimi-k3",
        model_name: "Kimi K3",
        limit: 256_000,
        effort: "max",
      }),
    ])
    expect(await agent()).toMatchObject({
      model: "hub/kimi-k3",
      model_name: "Kimi K3",
      effort: "max",
      status: "working",
    })
    expect((await agent()).cost.context_limit).toBe(256_000)
    // the context is a step's to say
    expect((await agent()).cost.context).toBeNull()
    // a start that says no model (the session could not be read, an older
    // plugin) keeps what is known
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
      started(),
    ])
    expect(await agent()).toMatchObject({ model: "hub/kimi-k3", effort: "max" })
    // "" says the model runs with no effort; a missing name keeps the name
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
      started({ model: "hub/kimi-k3", effort: "" }),
    ])
    expect(await agent()).toMatchObject({
      model: "hub/kimi-k3",
      model_name: "Kimi K3",
      effort: null,
    })
  })

  test("History says agent.model when the model or the effort becomes another; not for the first one", async () => {
    await report(t, HOST, [started(), step()])
    expect(await changes()).toEqual([])
    // the same again: nothing
    await report(t, HOST, [
      step(),
      started({ model: "fake/main", effort: "high" }),
    ])
    expect(await changes()).toEqual([])
    // another model at a turn's start; another effort at a step
    await report(t, HOST, [
      started({ model: "hub/kimi-k3", model_name: "Kimi K3", effort: "high" }),
      step({ model: "hub/kimi-k3", model_name: "Kimi K3", effort: "max" }),
      // a Subagent's step on another model changes nothing of the agent's
      step({ model: "fake/small", context: undefined, sub: "ses_kid" }),
    ])
    expect(await changes()).toEqual([
      [
        "team:a",
        {
          model: "hub/kimi-k3",
          effort: "high",
          was_model: "fake/main",
          was_effort: "high",
        },
      ],
      [
        "team:a",
        {
          model: "hub/kimi-k3",
          effort: "max",
          was_model: "hub/kimi-k3",
          was_effort: "high",
        },
      ],
    ])
  })

  // The review before 1.1.0-rc7: a turn's start is the plugin's word, and
  // what it says is checked before anything is kept.
  test("a turn's start whose model or window is none changes nothing", async () => {
    await report(t, HOST, [
      started({ model: "hub/kimi-k3", limit: 256_000, effort: "max" }),
    ])
    const view = async () => {
      const a = await agent()
      return [a.model, a.effort, a.cost.context_limit]
    }
    expect(await view()).toEqual(["hub/kimi-k3", "max", 256_000])
    for (const bad of [
      // a window that is none: the model is taken, the window stays
      { model: "hub/kimi-k3", limit: 1e300 },
      { model: "hub/kimi-k3", limit: 2.5 },
      { model: "hub/kimi-k3", limit: -5 },
      { model: "hub/kimi-k3", limit: "x" },
      { model: "hub/kimi-k3", limit: 100_000_001 },
      // a model that is none: nothing of the event is taken
      { model: "x".repeat(10_000), limit: 123_456, effort: "low" },
      { model: "", limit: 123_456 },
      { model: 5, limit: 123_456 },
    ])
      await report(t, HOST, [
        { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
        started(bad),
      ])
    expect(await view()).toEqual(["hub/kimi-k3", "max", 256_000])
    expect(await changes()).toEqual([])
  })

  test("a run's model is its job's: no agent.model for a run whose steps change models", async () => {
    await owner("PUT", "/v1/jobs/mail", {
      host: HOST,
      model: "fake/main",
      prompt: "Summarize the mail.",
      trigger: "fire-only",
    })
    expect((await owner("POST", "/v1/jobs/mail/run", {})).status).toBe(201)
    for (let n = 0; n < 2; n++) {
      t.server.tick()
      for (const i of await instructions(t, HOST))
        await ack(
          t,
          HOST,
          i.id,
          i.type === "spawn" ? { session: "ses_run" } : { ok: true },
        )
    }
    await report(t, HOST, [
      started({ session: "ses_run", model: "fake/main" }),
      step({ session: "ses_run" }),
      step({ session: "ses_run", model: "fake/other", effort: "low" }),
      { type: "turn.ended", session: "ses_run", outcome: "succeeded" },
      started({ session: "ses_run", model: "fake/third" }),
    ])
    expect(await changes()).toEqual([])
  })
})

describe("the model that answered", () => {
  const answered = (model: unknown, requested?: unknown) => ({
    type: "answered",
    session: "ses_a",
    model,
    ...(requested === undefined ? {} : { requested }),
  })

  test("the agent's views carry the answering model and the one asked for; History says when they differ or change", async () => {
    await report(t, HOST, [started({ model: "claude-agent/fable" })])
    expect(await agent()).toMatchObject({
      answered_model: null,
      requested_model: null,
    })
    await report(t, HOST, [answered("claude-fable-5-2", "claude-fable-5-2")])
    expect(await agent()).toMatchObject({
      answered_model: "claude-fable-5-2",
      requested_model: "claude-fable-5-2",
    })
    const row = (await owner("GET", "/v1/costs")).body.agents[0]
    expect(row).toMatchObject({
      answered_model: "claude-fable-5-2",
      requested_model: "claude-fable-5-2",
    })
    // as asked, and the first one known: nothing to record
    expect(await changes()).toEqual([])
    // another model answers than the one asked for
    await report(t, HOST, [
      answered("claude-opus-4-8", "claude-fable-5-2"),
      // said again: once
      answered("claude-opus-4-8", "claude-fable-5-2"),
    ])
    expect(await agent()).toMatchObject({
      answered_model: "claude-opus-4-8",
      requested_model: "claude-fable-5-2",
    })
    // and back
    await report(t, HOST, [answered("claude-fable-5-2", "claude-fable-5-2")])
    expect(await changes()).toEqual([
      [
        "team:a",
        {
          answered: "claude-opus-4-8",
          requested: "claude-fable-5-2",
          was_answered: "claude-fable-5-2",
        },
      ],
      [
        "team:a",
        {
          answered: "claude-fable-5-2",
          requested: "claude-fable-5-2",
          was_answered: "claude-opus-4-8",
        },
      ],
    ])
  })

  test("a first answer by another model than asked is recorded; one without a requested model is kept without it", async () => {
    await report(t, HOST, [
      started({ model: "claude-agent/fable" }),
      answered("claude-opus-5", "claude-fable-5-2"),
    ])
    expect(await changes()).toEqual([
      [
        "team:a",
        {
          answered: "claude-opus-5",
          requested: "claude-fable-5-2",
          was_answered: null,
        },
      ],
    ])
    await report(t, HOST, [answered("claude-opus-5")])
    expect(await agent()).toMatchObject({
      answered_model: "claude-opus-5",
      requested_model: null,
    })
  })

  test("what is no model's name is passed over; the two go when the agent moves to another provider", async () => {
    await report(t, HOST, [
      started({ model: "claude-agent/fable" }),
      answered("claude-fable-5-2", "claude-fable-5-2"),
    ])
    for (const bad of ["", 3, null, "x".repeat(300), "a b", "<synthetic>"])
      await report(t, HOST, [answered(bad, "claude-fable-5-2")])
    expect(await agent()).toMatchObject({
      answered_model: "claude-fable-5-2",
      requested_model: "claude-fable-5-2",
    })
    // a session nobody registered says nothing, and the events after it in
    // its batch still count
    const batch = await report(t, HOST, [
      { ...answered("claude-x"), session: "ses_nobody" },
      answered("claude-opus-4-8", "claude-fable-5-2"),
    ])
    expect(batch.status).toBe(200)
    expect(await agent()).toMatchObject({ answered_model: "claude-opus-4-8" })
    expect(
      (await owner("GET", "/v1/agents")).body.agents.map((x: any) => x.id),
    ).toEqual(["team:a"])
    // on the claude-agent provider they stay; on another they go
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
      started({ model: "claude-agent/fable" }),
    ])
    expect((await agent()).answered_model).toBe("claude-opus-4-8")
    await report(t, HOST, [
      { type: "turn.ended", session: "ses_a", outcome: "succeeded" },
      started({ model: "hub/kimi-k3" }),
    ])
    expect(await agent()).toMatchObject({
      answered_model: null,
      requested_model: null,
    })
    // and an agent on another provider, or whose model is not known, has
    // no answering model: the plugin's word is not taken for it
    await report(t, HOST, [answered("claude-fable-5-2", "claude-fable-5-2")])
    expect((await agent()).answered_model).toBeNull()
  })

  test("an agent whose model is not known yet has no answering model", async () => {
    await report(t, HOST, [answered("claude-fable-5-2", "claude-fable-5-2")])
    expect(await agent()).toMatchObject({
      model: null,
      answered_model: null,
      requested_model: null,
    })
  })
})
