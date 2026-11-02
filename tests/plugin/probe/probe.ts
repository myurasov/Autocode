/*
 * Spike probe: an OpenCode plugin that exposes its plugin context to tests over
 * a small HTTP port, so the spike checks can ask what a plugin can do
 * in-process. Test code only; never installed outside test containers.
 */

type AnyCtx = any

interface Instance {
  dir: string
  ctx: AnyCtx
  info: Record<string, unknown>
}

interface Recorded {
  seq: number
  at: number
  kind: string
  data: unknown
}

const state = (globalThis as any).__autocodeProbe ?? {
  instances: new Map<string, Instance>(),
  records: [] as Recorded[],
  seq: 0,
  server: undefined as any,
  hideTool: new Set<string>(),
  shellEnv: new Map<string, Record<string, string>>(),
  pendingShell: [] as { sessionID: string; command: string; at: number }[],
}
;(globalThis as any).__autocodeProbe = state

function record(kind: string, data: unknown) {
  state.seq += 1
  state.records.push({ seq: state.seq, at: Date.now(), kind, data })
  if (state.records.length > 5000)
    state.records.splice(0, state.records.length - 5000)
}

function safe(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    )
  } catch {
    return String(value)
  }
}

function describe(obj: any, depth = 0): unknown {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === "function") return "function"
  if (typeof obj !== "object" || depth > 2) return typeof obj
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj)) out[key] = describe(obj[key], depth + 1)
  return out
}

function pick(dir: string | undefined): Instance | undefined {
  if (dir) return state.instances.get(dir)
  return state.instances.values().next().value
}

async function invoke(ctx: AnyCtx, path: string, args: unknown[]) {
  const parts = path.split(".")
  const name = parts.pop()!
  let target = ctx
  for (const p of parts) target = target?.[p]
  if (typeof target?.[name] !== "function")
    throw new Error(`not a function: ${path}`)
  return await target[name](...args)
}

function startControl() {
  if (state.server) return
  const port = Number(process.env.PROBE_PORT ?? 4097)
  state.server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      try {
        if (url.pathname === "/info") {
          return Response.json(
            [...state.instances.values()].map((i) => ({
              dir: i.dir,
              info: i.info,
            })),
          )
        }
        if (url.pathname === "/records") {
          const since = Number(url.searchParams.get("since") ?? 0)
          const kind = url.searchParams.get("kind")
          return Response.json(
            state.records.filter(
              (r: Recorded) => r.seq > since && (!kind || r.kind === kind),
            ),
          )
        }
        if (url.pathname === "/call" && req.method === "POST") {
          const body = (await req.json()) as {
            dir?: string
            path: string
            args?: unknown[]
          }
          const inst = pick(body.dir)
          if (!inst)
            return Response.json(
              { ok: false, error: "no instance" },
              { status: 404 },
            )
          try {
            const result = await invoke(inst.ctx, body.path, body.args ?? [])
            return Response.json({ ok: true, result: safe(result) })
          } catch (err: any) {
            return Response.json({
              ok: false,
              error: String(err?.message ?? err),
              name: err?._tag ?? err?.name,
            })
          }
        }
        if (url.pathname === "/hide-tool" && req.method === "POST") {
          const body = (await req.json()) as {
            sessionID: string
            hide: boolean
          }
          if (body.hide) state.hideTool.add(body.sessionID)
          else state.hideTool.delete(body.sessionID)
          return Response.json({ ok: true })
        }
        if (url.pathname === "/shell-env" && req.method === "POST") {
          const body = (await req.json()) as {
            sessionID: string
            env: Record<string, string>
          }
          state.shellEnv.set(body.sessionID, body.env)
          return Response.json({ ok: true })
        }
        return new Response("not found", { status: 404 })
      } catch (err: any) {
        return Response.json(
          { ok: false, error: String(err?.message ?? err) },
          { status: 500 },
        )
      }
    },
  })
}

async function subscribe(ctx: AnyCtx, dir: string) {
  try {
    for await (const event of ctx.event.subscribe()) {
      record("event", { dir, type: event?.type, data: safe(event) })
    }
  } catch (err: any) {
    record("event.error", { dir, error: String(err?.message ?? err) })
  }
}

export default {
  id: "autocode-probe",
  setup: async (ctx: AnyCtx) => {
    const dir = String(ctx.location?.directory ?? process.cwd())
    const info = {
      app: safe(ctx.app),
      location: safe(ctx.location),
      options: safe(ctx.options),
      ctx: describe(ctx),
      sessionKeys: Object.keys(ctx.session ?? {}),
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => k.startsWith("OPENCODE") || k === "HOME",
        ),
      ),
      argv: process.argv,
      pid: process.pid,
      cwd: process.cwd(),
    }
    state.instances.set(dir, { dir, ctx, info })
    record("setup", { dir })
    startControl()
    void subscribe(ctx, dir)

    await ctx.tool.transform((tools: any) => {
      tools.add({
        name: "probe_whoami",
        options: { codemode: false },
        description: "Probe: report the calling session.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input: unknown, tctx: any) => {
          let parentID: unknown
          try {
            parentID =
              (await ctx.session.get({ sessionID: tctx.sessionID }))
                ?.parentID ?? null
          } catch (err: any) {
            parentID = `error: ${err?.message ?? err}`
          }
          const out = {
            sessionID: tctx.sessionID,
            agent: tctx.agent,
            messageID: tctx.messageID,
            callID: tctx.id,
            parentID,
          }
          record("whoami", out)
          return { content: JSON.stringify(out) }
        },
      })
      tools.add({
        name: "probe_wait",
        options: { codemode: false },
        description: "Probe: wait some seconds, then return.",
        input: {
          type: "object",
          properties: { seconds: { type: "number" } },
          required: ["seconds"],
          additionalProperties: false,
        },
        execute: async (input: any, tctx: any) => {
          const started = Date.now()
          record("wait.start", {
            sessionID: tctx.sessionID,
            seconds: input.seconds,
          })
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Number(input.seconds) * 1000)
            tctx.signal?.addEventListener?.("abort", () => {
              clearTimeout(timer)
              record("wait.abort", {
                sessionID: tctx.sessionID,
                after: Date.now() - started,
              })
              resolve()
            })
          })
          record("wait.end", {
            sessionID: tctx.sessionID,
            waited: Date.now() - started,
          })
          return {
            content: `waited ${Math.round((Date.now() - started) / 1000)} s`,
          }
        },
      })
    })

    await ctx.session.hook("context", (event: any) => {
      record("context", {
        sessionID: event.sessionID,
        agent: event.agent,
        tools: Object.keys(event.tools ?? {}),
      })
      if (state.hideTool.has(event.sessionID)) delete event.tools.probe_whoami
    })

    await ctx.tool.hook("execute.before", (event: any) => {
      record("tool.before", {
        tool: event.tool,
        sessionID: event.sessionID,
        agent: event.agent,
        input: safe(event.input),
      })
      const command = event?.input?.command
      if (typeof command === "string")
        state.pendingShell.push({
          sessionID: event.sessionID,
          command,
          at: Date.now(),
        })
    })

    await ctx.tool.hook("execute.after", (event: any) => {
      record("tool.after", {
        tool: event.tool,
        sessionID: event.sessionID,
        status: event.status,
      })
    })

    await ctx.shell.hook("create.before", (event: any) => {
      // The oldest pending shell call with this exact command is the one being
      // created now.
      const at = state.pendingShell.findIndex(
        (p: any) => p.command === event.command,
      )
      const match = at >= 0 ? state.pendingShell.splice(at, 1)[0] : undefined
      record("shell.before", {
        command: event.command,
        cwd: event.cwd,
        shell: event.shell,
        timeout: event.timeout,
        envKeys: Object.keys(event.env ?? {}).filter(
          (k) => k.startsWith("OPENCODE") || k.startsWith("AUTOCODE"),
        ),
        matchedSession: match?.sessionID ?? null,
      })
      event.env.PROBE_SHELL = "1"
      if (match) {
        event.env.PROBE_SESSION = match.sessionID
        for (const [k, v] of Object.entries(
          state.shellEnv.get(match.sessionID) ?? {},
        ))
          event.env[k] = v as string
      }
    })

    return () => {
      state.instances.delete(dir)
    }
  },
}
