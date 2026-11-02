/*
 * Scripted OpenAI-compatible model server for tests. No test spends money.
 *
 * Model routes (per namespace, so each OpenCode "machine" can get its own
 * script):
 *   POST /{ns}/v1/chat/completions
 *   GET /{ns}/v1/models
 *   (a bare /v1/... uses the "default" namespace)
 * Control routes:
 *   POST /{ns}/_script {steps, append?}
 *   GET /{ns}/_requests
 *   POST /{ns}/_reset
 *   GET /_health
 */

export interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  cached_tokens?: number
}

export interface ToolCallSpec {
  name: string
  arguments: unknown
  id?: string
}

/*
 * OpenCode's own side requests (session titles, compaction summaries) never
 * take a scripted step unless the step asks for that kind. Unscripted
 * compaction requests get a summary that fills OpenCode's template.
 */
export type RequestKind = "primary" | "title" | "compaction"

function requestKind(messages: any[]): RequestKind {
  const system = messages.find((m) => m?.role === "system")
  if (JSON.stringify(system?.content ?? "").includes("You name conversations"))
    return "title"
  const users = messages
    .filter((m) => m?.role === "user")
    .map((m) => JSON.stringify(m?.content ?? ""))
  if (
    users.some(
      (u) =>
        u.includes("summarize the conversation above") ||
        u.includes("required summary template"),
    )
  )
    return "compaction"
  return "primary"
}

// Fills every heading of the <template> that OpenCode's compaction prompt
// carries.
export function compactionSummary(messages: any[]): string {
  const text: string | undefined = messages
    .filter((m) => m?.role === "user")
    .map((m): string =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .find((t) => t.includes("<template>"))
  const template: string =
    text?.split("<template>")[1]?.split("</template>")[0] ?? ""
  const headings = template
    .split("\n")
    .filter((line: string) => /^#{2,3} /.test(line.trim()))
  if (!headings.length) return "## Objective\n- (none)\n"
  return (
    `${headings.map((h: string) => `${h.trim()}\n- (none)`).join("\n\n")}` +
    "\n"
  )
}

interface StepBase {
  // Only a request whose messages contain this text takes the step.
  match?: string
  // Only a request for this OpenCode session (its x-opencode-session header)
  // takes the step.
  session?: string
  // Only a request for this model takes the step.
  model?: string
  kind?: RequestKind
  delay_ms?: number
}

export type Step = StepBase &
  (
    | { reply: string; usage?: Usage; reasoning?: string; cut?: undefined }
    | { tool_calls: ToolCallSpec[]; text?: string; usage?: Usage }
    | {
        error: {
          status: number
          body?: unknown
          headers?: Record<string, string>
        }
      }
    | { hang: true }
    | { cut: true; reply?: string }
  )

export interface RecordedRequest {
  at: string
  model: string
  kind: RequestKind
  session: string | null
  stream: boolean
  messages: unknown[]
  tools: string[]
  toolDefs: unknown[]
  step: number | "default"
  headers: Record<string, string>
}

interface Namespace {
  steps: Step[]
  requests: RecordedRequest[]
  served: number
}

export interface FakeModel {
  port: number
  stop: () => void
}

const encoder = new TextEncoder()

function messageText(messages: unknown[]): string {
  return JSON.stringify(messages)
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function usageBlock(
  usage: Usage | undefined,
  promptText: string,
  completionText: string,
) {
  const prompt = usage?.prompt_tokens ?? estimateTokens(promptText)
  const completion = usage?.completion_tokens ?? estimateTokens(completionText)
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: usage?.cached_tokens ?? 0 },
  }
}

function chunk(
  id: string,
  model: string,
  delta: unknown,
  finish: string | null = null,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

function sse(data: unknown): Uint8Array {
  return encoder.encode(
    `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
  )
}

function splitText(text: string): string[] {
  if (text.length <= 4) return [text]
  const mid = Math.ceil(text.length / 2)
  return [text.slice(0, mid), text.slice(mid)]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function startFakeModel(
  options: { port?: number; hostname?: string } = {},
): FakeModel {
  const spaces = new Map<string, Namespace>()
  const space = (name: string) => {
    let ns = spaces.get(name)
    if (!ns) {
      ns = { steps: [], requests: [], served: 0 }
      spaces.set(name, ns)
    }
    return ns
  }

  function takeStep(
    ns: Namespace,
    want: {
      model: string
      text: string
      session: string | null
      kind: RequestKind
    },
  ): { step: Step | undefined; index: number | "default" } {
    const at = ns.steps.findIndex(
      (s) =>
        (!s.match || want.text.includes(s.match)) &&
        (!s.model || s.model === want.model) &&
        (!s.session || s.session === want.session) &&
        (s.kind ?? "primary") === want.kind,
    )
    if (at < 0) return { step: undefined, index: "default" }
    const [step] = ns.steps.splice(at, 1)
    ns.served += 1
    return { step, index: ns.served }
  }

  async function completions(ns: Namespace, req: Request): Promise<Response> {
    const body = (await req.json()) as any
    const model = String(body.model ?? "")
    const messages = Array.isArray(body.messages) ? body.messages : []
    const text = messageText(messages)
    const stream = body.stream === true
    const session = req.headers.get("x-opencode-session")
    const kind = requestKind(messages)
    const { step, index } = takeStep(ns, { model, text, session, kind })
    const headers: Record<string, string> = {}
    for (const [k, v] of req.headers)
      if (k.startsWith("x-") || k === "user-agent") headers[k] = v
    const toolDefs = Array.isArray(body.tools) ? body.tools : []
    ns.requests.push({
      at: new Date().toISOString(),
      model,
      kind,
      session,
      stream,
      messages,
      tools: toolDefs
        .map((t: any) => t?.function?.name ?? t?.name)
        .filter(Boolean),
      toolDefs,
      step: index,
      headers,
    })

    const fallback =
      kind === "title"
        ? "Test session"
        : kind === "compaction"
          ? compactionSummary(messages)
          : "ok"
    const plan: Step = step ?? { reply: fallback }
    if (plan.delay_ms) await sleep(plan.delay_ms)
    if ("error" in plan && plan.error) {
      const errorBody = plan.error.body ?? {
        error: { message: `fake error ${plan.error.status}`, type: "fake" },
      }
      return new Response(JSON.stringify(errorBody), {
        status: plan.error.status,
        headers: {
          "content-type": "application/json",
          ...(plan.error.headers ?? {}),
        },
      })
    }
    const id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`

    if ("hang" in plan && plan.hang) {
      return new Response(
        new ReadableStream({
          start() {},
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }

    if ("cut" in plan && plan.cut) {
      const partial = plan.reply ?? "partial"
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(
              sse(chunk(id, model, { role: "assistant", content: partial })),
            )
            await sleep(50)
            controller.error(new Error("cut stream"))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }

    const reply =
      "reply" in plan ? plan.reply : "text" in plan ? (plan.text ?? "") : ""
    const toolCalls = "tool_calls" in plan ? plan.tool_calls : []
    const usage = usageBlock(
      "usage" in plan ? plan.usage : undefined,
      text,
      reply + JSON.stringify(toolCalls),
    )
    const calls = toolCalls.map((call, i) => ({
      index: i,
      id: call.id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
      type: "function" as const,
      name: call.name,
      args:
        typeof call.arguments === "string"
          ? call.arguments
          : JSON.stringify(call.arguments ?? {}),
    }))
    const finish = calls.length ? "tool_calls" : "stop"

    if (!stream) {
      const message: any = { role: "assistant", content: reply || null }
      if (calls.length)
        message.tool_calls = calls.map((c) => ({
          id: c.id,
          type: c.type,
          function: { name: c.name, arguments: c.args },
        }))
      return Response.json({
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      })
    }

    const reasoning = "reasoning" in plan ? plan.reasoning : undefined
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            sse(chunk(id, model, { role: "assistant", content: "" })),
          )
          if (reasoning)
            controller.enqueue(
              sse(chunk(id, model, { reasoning_content: reasoning })),
            )
          for (const piece of reply ? splitText(reply) : [])
            controller.enqueue(sse(chunk(id, model, { content: piece })))
          for (const c of calls) {
            const [first, second] = splitText(c.args)
            controller.enqueue(
              sse(
                chunk(id, model, {
                  tool_calls: [
                    {
                      index: c.index,
                      id: c.id,
                      type: c.type,
                      function: { name: c.name, arguments: first },
                    },
                  ],
                }),
              ),
            )
            if (second !== undefined)
              controller.enqueue(
                sse(
                  chunk(id, model, {
                    tool_calls: [
                      { index: c.index, function: { arguments: second } },
                    ],
                  }),
                ),
              )
          }
          controller.enqueue(sse(chunk(id, model, {}, finish)))
          controller.enqueue(
            sse({
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [],
              usage,
            }),
          )
          controller.enqueue(sse("[DONE]"))
          controller.close()
        },
      }),
      {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      },
    )
  }

  const server = Bun.serve({
    port: options.port ?? 9000,
    hostname: options.hostname ?? "0.0.0.0",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/_health") return Response.json({ ok: true })
      const parts = url.pathname.split("/").filter(Boolean)
      const name = parts[0] === "v1" ? "default" : (parts.shift() ?? "default")
      const rest = `/${parts.join("/")}`
      const ns = space(name)
      if (rest === "/_script" && req.method === "POST") {
        const body = (await req.json()) as { steps?: Step[]; append?: boolean }
        if (!body.append) ns.steps = []
        ns.steps.push(...(body.steps ?? []))
        return Response.json({ ok: true, queued: ns.steps.length })
      }
      if (rest === "/_requests" && req.method === "GET")
        return Response.json({ requests: ns.requests })
      if (rest === "/_reset" && req.method === "POST") {
        ns.steps = []
        ns.requests = []
        ns.served = 0
        return Response.json({ ok: true })
      }
      if (rest === "/v1/models")
        return Response.json({
          object: "list",
          data: [{ id: "main", object: "model" }],
        })
      if (rest === "/v1/chat/completions" && req.method === "POST")
        return completions(ns, req)
      return Response.json(
        { error: { message: `no route ${req.method} ${url.pathname}` } },
        { status: 404 },
      )
    },
  })

  return { port: server.port ?? 0, stop: () => server.stop(true) }
}

if (import.meta.main) {
  const port = Number(process.env.FAKE_MODEL_PORT ?? 9000)
  const fake = startFakeModel({ port })
  console.log(`fake model listening on ${fake.port}`)
}
