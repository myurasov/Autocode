/*
 * The fake model server (ci/fake-model/server.ts) that OpenCode uses in the
 * Docker suites: scripted replies, tool calls, errors, hangs and cut streams
 * per namespace and session, title and compaction requests, and the request
 * log.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { type FakeModel, startFakeModel } from "../../ci/fake-model/server.ts"

let fake: FakeModel
const base = () => `http://127.0.0.1:${fake.port}`

async function chat(ns: string, body: Record<string, unknown>) {
  return fetch(`${base()}/${ns}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "main",
      messages: [{ role: "user", content: "hi" }],
      ...body,
    }),
    signal: AbortSignal.timeout(5000),
  })
}

async function readEvents(res: Response): Promise<any[]> {
  const text = await res.text()
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)))
}

async function script(ns: string, steps: unknown[]) {
  const res = await fetch(`${base()}/${ns}/_script`, {
    method: "POST",
    body: JSON.stringify({ steps }),
    signal: AbortSignal.timeout(5000),
  })
  expect(res.status).toBe(200)
}

beforeEach(async () => {
  fake ??= startFakeModel({ port: 0, hostname: "127.0.0.1" })
  await fetch(`${base()}/a/_reset`, { method: "POST" })
  await fetch(`${base()}/b/_reset`, { method: "POST" })
})

afterAll(() => fake?.stop())

describe("fake model server", () => {
  test("answers a default reply with usage when nothing is scripted", async () => {
    const res = await chat("a", {
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const events = await readEvents(res)
    const text = events
      .map((e) => e.choices?.[0]?.delta?.content ?? "")
      .join("")
    expect(text).toBe("ok")
    expect(events.at(-1).usage.prompt_tokens).toBeGreaterThan(0)
  })

  test("plays scripted replies in order, with the given usage", async () => {
    await script("a", [
      {
        reply: "first",
        usage: { prompt_tokens: 100, completion_tokens: 7, cached_tokens: 40 },
      },
      { reply: "second" },
    ])
    const one = await readEvents(await chat("a", { stream: true }))
    const two = await readEvents(await chat("a", { stream: true }))
    expect(one.map((e) => e.choices?.[0]?.delta?.content ?? "").join("")).toBe(
      "first",
    )
    const usage = one.find((e) => e.usage)?.usage
    expect(usage).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 7,
      prompt_tokens_details: { cached_tokens: 40 },
    })
    expect(two.map((e) => e.choices?.[0]?.delta?.content ?? "").join("")).toBe(
      "second",
    )
  })

  test("streams tool calls with arguments as JSON", async () => {
    await script("a", [
      { tool_calls: [{ name: "bash", arguments: { command: "echo hi" } }] },
    ])
    const events = await readEvents(await chat("a", { stream: true }))
    const calls = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])
    expect(calls[0].function.name).toBe("bash")
    const args = calls.map((c: any) => c.function.arguments ?? "").join("")
    expect(JSON.parse(args)).toEqual({ command: "echo hi" })
    expect(
      events.find((e) => e.choices?.[0]?.finish_reason)?.choices[0]
        .finish_reason,
    ).toBe("tool_calls")
  })

  test("answers without streaming too", async () => {
    await script("a", [{ reply: "plain" }])
    const res = await chat("a", { stream: false })
    const body = (await res.json()) as any
    expect(body.choices[0].message.content).toBe("plain")
    expect(body.usage.total_tokens).toBeGreaterThan(0)
  })

  test("returns scripted errors with status and headers", async () => {
    await script("a", [
      {
        error: {
          status: 429,
          headers: { "retry-after": "1" },
          body: { error: { message: "slow down" } },
        },
      },
    ])
    const res = await chat("a", { stream: true })
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("1")
  })

  test("a matched step goes to the request that contains its marker", async () => {
    await script("a", [
      { match: "session-two", reply: "for two" },
      { reply: "for anyone" },
    ])
    const first = await readEvents(
      await chat("a", {
        stream: true,
        messages: [{ role: "user", content: "hello from session-one" }],
      }),
    )
    expect(
      first.map((e) => e.choices?.[0]?.delta?.content ?? "").join(""),
    ).toBe("for anyone")
    const second = await readEvents(
      await chat("a", {
        stream: true,
        messages: [{ role: "user", content: "hello from session-two" }],
      }),
    )
    expect(
      second.map((e) => e.choices?.[0]?.delta?.content ?? "").join(""),
    ).toBe("for two")
  })

  test("a step for a session goes only to requests from that OpenCode session", async () => {
    await script("a", [{ session: "ses_two", reply: "for two" }])
    const post = (session: string) =>
      fetch(`${base()}/a/v1/chat/completions`, {
        method: "POST",
        headers: { "x-opencode-session": session },
        body: JSON.stringify({
          model: "main",
          stream: true,
          messages: [{ role: "user", content: "x" }],
        }),
      })
    const one = await readEvents(await post("ses_one"))
    const two = await readEvents(await post("ses_two"))
    expect(one.map((e) => e.choices?.[0]?.delta?.content ?? "").join("")).toBe(
      "ok",
    )
    expect(two.map((e) => e.choices?.[0]?.delta?.content ?? "").join("")).toBe(
      "for two",
    )
    const log = (await (await fetch(`${base()}/a/_requests`)).json()) as any
    expect(log.requests.map((r: any) => r.session)).toEqual([
      "ses_one",
      "ses_two",
    ])
  })

  test("OpenCode's title requests never take a scripted step", async () => {
    await script("a", [{ reply: "scripted" }])
    const title = await readEvents(
      await chat("a", {
        stream: true,
        messages: [
          {
            role: "system",
            content: "You name conversations so the user can find them later.",
          },
          { role: "user", content: "first message" },
        ],
      }),
    )
    expect(
      title.map((e) => e.choices?.[0]?.delta?.content ?? "").join(""),
    ).toBe("Test session")
    const main = await readEvents(await chat("a", { stream: true }))
    expect(main.map((e) => e.choices?.[0]?.delta?.content ?? "").join("")).toBe(
      "scripted",
    )
  })

  test("OpenCode's compaction requests get a summary that fills the template's headings", async () => {
    await script("a", [{ reply: "scripted" }])
    const template =
      "You MUST summarize the conversation above into a structured summary.\n" +
      "<template>\n## Objective\n- [x]\n\n## Work State\n" +
      "### Completed\n- [y]\n</template>"
    const events = await readEvents(
      await chat("a", {
        stream: true,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: template },
        ],
      }),
    )
    const text = events
      .map((e) => e.choices?.[0]?.delta?.content ?? "")
      .join("")
    expect(text).toContain("## Objective")
    expect(text).toContain("### Completed")
    const log = (await (await fetch(`${base()}/a/_requests`)).json()) as any
    expect(log.requests[0].kind).toBe("compaction")
    const main = await readEvents(await chat("a", { stream: true }))
    expect(main.map((e) => e.choices?.[0]?.delta?.content ?? "").join("")).toBe(
      "scripted",
    )
  })

  test("namespaces keep separate scripts and request logs", async () => {
    await script("a", [{ reply: "from a" }])
    const b = await readEvents(await chat("b", { stream: true }))
    expect(b.map((e) => e.choices?.[0]?.delta?.content ?? "").join("")).toBe(
      "ok",
    )
    const logA = (await (await fetch(`${base()}/a/_requests`)).json()) as any
    const logB = (await (await fetch(`${base()}/b/_requests`)).json()) as any
    expect(logA.requests.length).toBe(0)
    expect(logB.requests.length).toBe(1)
    expect(logB.requests[0].messages[0].content).toBe("hi")
  })

  test("records the tools a request offered", async () => {
    await chat("a", {
      stream: true,
      tools: [
        {
          type: "function",
          function: { name: "autocode_me", description: "x", parameters: {} },
        },
      ],
    })
    const log = (await (await fetch(`${base()}/a/_requests`)).json()) as any
    expect(log.requests[0].tools).toEqual(["autocode_me"])
  })

  test("a hang never answers until the client gives up", async () => {
    await script("a", [{ hang: true }])
    const started = Date.now()
    const outcome = await fetch(`${base()}/a/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "main",
        stream: true,
        messages: [{ role: "user", content: "x" }],
      }),
      signal: AbortSignal.timeout(500),
    })
      .then((res) => res.text())
      .then(
        () => "answered",
        () => "aborted",
      )
    expect(outcome).toBe("aborted")
    expect(Date.now() - started).toBeGreaterThanOrEqual(450)
  })

  test("a cut stream ends without [DONE]", async () => {
    await script("a", [{ cut: true, reply: "partial answer" }])
    const res = await chat("a", { stream: true })
    const text = await res.text().catch(() => "")
    expect(text).not.toContain("[DONE]")
  })
})
