/*
 * Autocode's OpenCode 2 plugin: links this OpenCode server's sessions to an
 * Autocode server. It stays out of the way when the machine has no client
 * config.
 */

import { carryOut, formEvent, listOf, permissionEvent } from "./asks.ts"
import { Channel, type Instruction } from "./channel.ts"
import { runCheck } from "./checks.ts"
import { request, ServerError } from "./client.ts"
import { hostId, machineName, processOf, readClientConfig } from "./config.ts"
import { costEvent, windowOf } from "./costs.ts"
import { sessionIsGone } from "./errors.ts"
import {
  agentLine,
  type GuideFacts,
  guideText,
  helpText,
  SKILL_DESCRIPTION,
  SKILL_ID,
} from "./guide.ts"
import { lastReply, spawnInput } from "./jobs.ts"
import {
  activeSessions,
  cancelForm,
  findLocalApi,
  listForms,
  replyForm,
  setEnvironment,
  shellVariables,
} from "./localapi.ts"
import { log } from "./log.ts"
import { SessionTokens } from "./sessions.ts"
import {
  APPROVAL_TOOL,
  type ApprovalInput,
  type Call,
  LOCK_TOOL,
  type LockInput,
  ME_TOOL,
  MESSAGE_TOOL,
  type MeInput,
  type MessageInput,
  runApproval,
  runLock,
  runMe,
  runMessage,
  runWake,
  TOOLS,
  WAKE_TOOL,
  type WakeInput,
} from "./tools.ts"

type Ctx = any

// OpenCode's events of forms (the question tool) and permission requests.
const ASK_EVENTS = [
  "form.created",
  "form.replied",
  "form.cancelled",
  "permission.asked",
  "permission.replied",
] as const

const TURN_EVENTS = {
  "session.execution.started": "started",
  "session.execution.succeeded": "succeeded",
  "session.execution.failed": "failed",
  "session.execution.interrupted": "interrupted",
} as const

export default {
  id: "autocode",
  setup: async (ctx: Ctx) => {
    const config = readClientConfig()
    if (!config) {
      log(
        "no client config: the plugin stays off (run autocode plugin install)",
      )
      return
    }
    const directory = String(ctx.location?.directory ?? process.cwd())
    const host = hostId(directory)
    const instance = crypto.randomUUID()
    // This OpenCode server's local API, where the plugin sets each session's
    // shell values; none when the plugin cannot reach it (spec, Shell values).
    const api = await findLocalApi()

    // This folder's top-level sessions the plugin knows of, and the registered
    // ones with their agent IDs (the server tells it).
    const mine = new Set<string>()
    // sessions spawned for runs of jobs (their turns report their reply)
    const runs = new Set<string>()
    const registered = new Map<string, string>()

    const channel: Channel = new Channel({
      config,
      host,
      instance,
      machine: machineName(),
      directory,
      opencodeVersion: String(ctx.app?.version ?? ""),
      process: processOf(),
      shellValues: api !== undefined,
      log,
      onInstruction: (instruction: Instruction) => handle(instruction),
      goneSessions: async (sessions) => {
        const gone: string[] = []
        for (const sessionID of sessions) {
          try {
            await ctx.session.get({ sessionID })
          } catch (err) {
            if (sessionIsGone(err)) gone.push(sessionID)
          }
        }
        return gone
      },
      // The newest top-level sessions of this folder (ctx.session.list covers
      // every folder unless told one).
      sessions: async () => {
        const page = await ctx.session.list({
          directory,
          parentID: null,
          limit: 200,
        })
        const list = (Array.isArray(page?.data) ? page.data : [])
          .filter((s: any) => typeof s?.id === "string" && !s.parentID)
          .map((s: any) => ({
            id: s.id as string,
            directory: String(s.location?.directory ?? directory),
          }))
        for (const s of list) mine.add(s.id)
        return list
      },
      active: async () => (api ? activeSessions(api) : undefined),
      onHello: (reply) => {
        registered.clear()
        for (const [session, agent] of Object.entries(reply?.registered ?? {}))
          if (typeof agent === "string") {
            registered.set(session, agent)
            mine.add(session)
          }
        void ctx.skill?.reload?.().catch?.(() => {})
        // the sessions that are runs of jobs (a restarted plugin forgot them)
        for (const session of Array.isArray(reply?.runs) ? reply.runs : [])
          if (typeof session === "string") runs.add(session)
        // questions and permissions already pending (tier 0d)
        void reportPending([...registered.keys()])
      },
    })

    // Tokens kept in OpenCode's plugin storage, per server URL and session.
    const tokenKey = (session: string) =>
      `token/${encodeURIComponent(config.url)}/${session}`
    const tokens = new SessionTokens({
      store: ctx.storage
        ? {
            get: async (session) => {
              const v = await ctx.storage.get(tokenKey(session))
              return typeof v === "string" ? v : undefined
            },
            set: (session, token) => ctx.storage.set(tokenKey(session), token),
            remove: (session) => ctx.storage.remove(tokenKey(session)),
          }
        : undefined,
      parentOf: async (sessionID) => {
        const info = await ctx.session.get({ sessionID })
        return info?.parentID || undefined
      },
      requestToken: async (session) => {
        /*
         * Only the first connection is worth a short wait; while the server is
         * known to be down (or the wrong one), fail at once, so that tools and
         * shells never wait on it. A superseded instance still asks: the server
         * answers it.
         */
        if (
          !channel.reachable &&
          (channel.state !== "starting" || !(await channel.whenConnected(1000)))
        )
          throw new Error("the Autocode server is not reachable")
        const res = await request(
          config.url,
          config.consumer_token,
          "POST",
          `/v1/hosts/${encodeURIComponent(host)}` +
            `/sessions/${encodeURIComponent(session)}/token`,
          { instance, directory },
          3000,
        )
        return res.token as string
      },
    })

    // Calls the agent API as the session (a Subagent as its top-level session);
    // a refused token is renewed once.
    const callAs = async (
      sessionID: string,
      method: string,
      path: string,
      body?: unknown,
      timeoutMs = 10_000,
      signal?: AbortSignal,
    ) => {
      const root = await tokens.root(sessionID)
      for (let attempt = 0; ; attempt++) {
        const token = await tokens.token(root)
        try {
          return await request(
            config.url,
            token,
            method,
            path,
            body,
            timeoutMs,
            signal,
          )
        } catch (err) {
          if (
            err instanceof ServerError &&
            err.status === 401 &&
            attempt === 0
          ) {
            await tokens.drop(root)
            continue
          }
          throw err
        }
      }
    }

    // The values a session's shells (and its checks) carry.
    const valuesFor = async (root: string) => ({
      AUTOCODE_URL: config.url,
      AUTOCODE_TOKEN: await tokens.token(root),
      AUTOCODE_SERVER_ID: channel.serverId ?? "",
      AUTOCODE_SESSION: root,
    })

    /*
     * Shell values: each session's environment holds its top-level session's
     * values on top of OpenCode's own environment, set before each of the
     * session's shell calls (not only the first) and again after a rotation.
     * An OpenCode client (the TUI, an editor's extension) sets a session's
     * environment to its own when it opens the session, which drops the
     * values, and nothing tells the plugin (the owner, 2026-11-08: shells
     * without AUTOCODE_TOKEN). `shellSet` is the sessions the plugin set, for
     * a rotation.
     */
    const shellSet = new Map<string, { root: string; token: string }>()
    const shellPending = new Map<string, Promise<void>>()
    const putShellValues = async (session: string, root: string) => {
      if (!api) return
      const values = await valuesFor(root)
      await setEnvironment(api, session, shellVariables(process.env, values))
      shellSet.set(session, { root, token: values.AUTOCODE_TOKEN })
    }
    // Once per session at a time; a failure leaves the shell as it was.
    const shellValuesFor = (session: string, root: string) => {
      let pending = shellPending.get(session)
      if (!pending) {
        pending = putShellValues(session, root)
          .catch((err) =>
            log(`no shell values for ${session}: ${(err as Error).message}`),
          )
          .finally(() => shellPending.delete(session))
        shellPending.set(session, pending)
      }
      return pending
    }
    // After a rotation: each of the root's sessions, once any setting still
    // under way (with the old token) is done.
    const renewShellValues = async (root: string) => {
      const sessions = [...shellSet]
        .filter(([, set]) => set.root === root)
        .map(([session]) => session)
      await Promise.all(
        sessions.map(async (session) => {
          await shellPending.get(session)
          await shellValuesFor(session, root)
        }),
      )
    }

    // The server's instructions for this host's sessions.
    const handle = async (instruction: Instruction): Promise<unknown> => {
      const p = instruction.payload ?? {}
      const session = String(p.session ?? "")
      switch (instruction.type) {
        case "token":
          // The owner rotated the session's token: the old one is dead; get a
          // new one now, and put it into the shells that had the old one.
          await tokens.drop(session)
          await tokens.token(session)
          await renewShellValues(session)
          return { renewed: true }
        case "inject": {
          // queue: a prompt that meets a running turn waits for its end
          await ctx.session.prompt({
            sessionID: session,
            id: String(p.prompt_id),
            text: String(p.text),
            delivery: "queue",
          })
          return { injected: true }
        }
        case "answer":
          // a question's or permission's answer (tier 0d)
          log(`answer ${p.kind} ${p.ref} in ${session}`)
          return await carryOut(p, {
            formReply: (i) => {
              if (!api) throw new Error("no local API for forms")
              return replyForm(api, i)
            },
            formCancel: (i) => {
              if (!api) throw new Error("no local API for forms")
              return cancelForm(api, i)
            },
            permissionReply: (i) => ctx.permission.reply(i),
          })
        case "spawn": {
          // a run of a job: a fresh session in this folder (tier 0f)
          const created = await ctx.session.create(spawnInput(directory, p))
          const id = String(created?.id ?? created?.data?.id ?? "")
          if (!id) throw new Error("no session was created")
          mine.add(id)
          runs.add(id)
          log(`spawned ${id} for ${p.run}`)
          return { session: id }
        }
        case "remove":
          // a finished run's session (delete_session), or a failed one the
          // owner deleted
          log(`remove ${session}`)
          await ctx.session.remove({ sessionID: session })
          return { removed: session }
        case "compact":
          // a context past compact_at, or asked for (tier 0e)
          log(`compact ${session}`)
          return await ctx.session.compact({
            sessionID: session,
            delivery: "queue",
          })
        case "interrupt":
          return await ctx.session.interrupt({
            sessionID: session,
            resume: false,
          })
        case "check": {
          // always the session's shell: the CLI there never uses the owner's
          // token, even when the session's values could not be had
          const env: Record<string, string | undefined> = {
            ...process.env,
            AUTOCODE_SESSION: session,
          }
          try {
            Object.assign(env, await valuesFor(session))
          } catch {}
          return await runCheck({
            command: String(p.command),
            directory: String(p.directory || directory),
            timeoutMs: Number(p.timeout_ms) || 60_000,
            outputLimit: Number(p.output_limit) || 0,
            env,
          })
        }
        case "registration":
          if (typeof p.agent === "string") {
            registered.set(session, p.agent)
            mine.add(session)
          } else registered.delete(session)
          return { ok: true }
        case "ping":
          return { pong: true }
        default:
          throw new Error(`unknown instruction ${instruction.type}`)
      }
    }

    // What the guide says of this host (the server's ID once connected).
    const guideFacts = (): GuideFacts => ({
      serverId: channel.serverId,
      url: config.url,
      shellValues: api !== undefined,
      tools: TOOLS,
    })
    const asTool = (
      tool: { name: string; description: string; input: unknown },
      run: (
        input: any,
        call: Call,
        sessionID: string,
        // OpenCode's: aborted when the session stops the call
        signal?: AbortSignal,
      ) => Promise<string>,
    ) => ({
      ...tool,
      options: { codemode: false },
      execute: async (input: any, tctx: any) => {
        try {
          const call: Call = (method, path, body) =>
            callAs(tctx.sessionID, method, path, body)
          return {
            content: await run(input, call, tctx.sessionID, tctx.signal),
          }
        } catch (err) {
          const e = err as ServerError
          const code = e instanceof ServerError ? ` (${e.code})` : ""
          return { content: `error${code}: ${e.message}` }
        }
      },
    })
    await ctx.tool.transform((tools: any) => {
      tools.add(
        asTool(ME_TOOL, (input: MeInput, call) =>
          runMe(input, call, {
            guide: (topic) => helpText(guideFacts(), topic),
          }),
        ),
      )
      tools.add(
        asTool(WAKE_TOOL, (input: WakeInput, call) => runWake(input, call)),
      )
      tools.add(
        asTool(MESSAGE_TOOL, (input: MessageInput, call) =>
          runMessage(input, call),
        ),
      )
      tools.add(
        asTool(LOCK_TOOL, (input: LockInput, call) => runLock(input, call)),
      )
      tools.add(
        asTool(APPROVAL_TOOL, (input: ApprovalInput, call, sessionID, signal) =>
          runApproval(input, call, async (id, seconds) => {
            /*
             * The server answers within 240 s (or max_tool_wait); wait again
             * until the end, but not when it answered early while still
             * open: max_tool_wait cut the wait.
             */
            const end = Date.now() + seconds * 1000
            for (;;) {
              const left = Math.ceil((end - Date.now()) / 1000)
              const chunk = Math.max(1, Math.min(left, 240))
              const asked = Date.now()
              const res = await callAs(
                sessionID,
                "GET",
                `/v1/me/approvals/${encodeURIComponent(id)}?wait=${chunk}`,
                undefined,
                (chunk + 15) * 1000,
                signal,
              )
              if (
                res.approval?.state !== "open" ||
                Date.now() >= end - 1000 ||
                Date.now() - asked < (chunk - 2) * 1000
              )
                return res
            }
          }),
        ),
      )
    })

    // OpenCode awaits this before it builds the shell's environment, so the
    // session's values are in place for each shell.
    await ctx.tool.hook("execute.before", async (event: any) => {
      if (!api || event.tool !== "shell" || typeof event.sessionID !== "string")
        return
      try {
        await shellValuesFor(
          event.sessionID,
          await tokens.root(event.sessionID),
        )
      } catch (err) {
        log(`no shell values: ${(err as Error).message}`)
      }
    })

    /*
     * The agent guide (spec, Agent Tools): the `autocode` skill for every
     * session, and one line of system text in each model call of a registered
     * session (a Subagent gets its top-level session's).
     */
    try {
      await ctx.skill?.transform?.((editor: any) => {
        editor.add({
          id: SKILL_ID,
          name: "Autocode",
          description: SKILL_DESCRIPTION,
          // the plugin's own folder: nothing is written there
          path: `${import.meta.dir}/SKILL.md`,
          content: guideText(guideFacts()),
        })
      })
    } catch (err) {
      log(`no autocode skill: ${(err as Error).message}`)
    }
    await ctx.session.hook("context", async (event: any) => {
      if (typeof event?.sessionID !== "string" || !registered.size) return
      let agent = registered.get(event.sessionID)
      if (!agent) {
        const root = await tokens.root(event.sessionID).catch(() => "")
        agent = root ? registered.get(root) : undefined
      }
      if (agent && Array.isArray(event.system))
        event.system.push({
          type: "text",
          text: agentLine(agent, channel.serverId),
        })
    })

    /*
     * New top-level sessions of this folder, deleted sessions and turns are
     * reported to the server; the subscription is renewed if its stream ends.
     * (It carries every folder's events: only this folder's are this host's.)
     */
    const events = new AbortController()
    const ours = (event: any, session: string) => {
      const dir = event?.location?.directory
      return dir ? dir === directory : mine.has(session)
    }
    /*
     * The questions and permission prompts of registered sessions that are
     * pending now (at each hello: none is missed across a reconnect); the
     * server keeps one ask per form or request, and closes the ones OpenCode
     * no longer has (asks.pending: the refs listed, and any reported while
     * listing). A session whose list failed is left out.
     */
    let listing: Set<string> | undefined
    const reportPending = async (sessions: string[]) => {
      const seen = new Set<string>()
      listing = seen
      const pending: Record<string, string[]> = {}
      for (const sessionID of sessions) {
        const refs: string[] = []
        let ok = true
        try {
          if (api)
            for (const form of await listForms(api, sessionID)) {
              const event = formEvent(sessionID, form)
              if (event) {
                channel.report(event)
                refs.push(event.ref)
              }
            }
          else ok = false
        } catch {
          ok = false
        }
        try {
          for (const request of listOf(
            await ctx.permission.list({ sessionID }),
          )) {
            const event = permissionEvent(sessionID, request)
            if (event) {
              channel.report(event)
              refs.push(event.ref)
            }
          }
        } catch {
          ok = false
        }
        if (ok) pending[sessionID] = refs
      }
      if (listing === seen) listing = undefined
      for (const session of Object.keys(pending))
        pending[session]!.push(...seen)
      channel.report({ type: "asks.pending", pending })
    }
    // A Subagent's ask is its top-level session's.
    const askSession = async (session: string) =>
      tokens.root(session).catch(() => session)
    // The sessions running a turn now, when the local API can tell: after a
    // gap in the event stream, and every minute, so no lost event leaves a
    // session busy (or idle) for long.
    const reportActive = async () => {
      if (!api) return
      const sessions = await activeSessions(api).catch(() => undefined)
      if (sessions) channel.report({ type: "turns.active", sessions })
    }
    const activeTimer = api
      ? setInterval(() => void reportActive(), 60_000)
      : undefined
    /*
     * A model step's cost and context (tier 0e): a Subagent's counts for its
     * top-level session; the context is the top-level session's own.
     */
    const windows = new Map<string, number | undefined>()
    const windowFor = async (ref: any) => {
      const key = `${ref?.providerID}/${ref?.id}`
      if (!windows.has(key)) {
        const list = await ctx.model.list({}).catch(() => undefined)
        const n = windowOf(listOf(list), ref)
        // a failed list is asked again next time
        if (n === undefined) return undefined
        windows.set(key, n)
      }
      return windows.get(key)
    }
    const onStep = async (event: any) => {
      const data = event?.data ?? {}
      const raw = data.sessionID
      if (typeof raw !== "string" || !ours(event, raw)) return
      const session = await askSession(raw)
      if (!registered.has(session)) return
      const info = await ctx.session
        .get({ sessionID: raw })
        .catch(() => undefined)
      // a session without a model of its own runs OpenCode's default one
      let ref = info?.model
      let limit = ref ? await windowFor(ref) : undefined
      if (!ref) {
        const def = await ctx.model.default({}).catch(() => undefined)
        const m =
          def && typeof def === "object" && "data" in def ? def.data : def
        if (m?.id) {
          ref = { providerID: m.providerID, id: m.id }
          const n = Number(m.limit?.context)
          limit = Number.isFinite(n) && n > 0 ? n : await windowFor(ref)
        }
      }
      const report = costEvent(session, data, {
        ...(ref?.id ? { model: `${ref.providerID}/${ref.id}` } : {}),
        ...(limit ? { limit } : {}),
      })
      if (!report) return
      // a Subagent's context is not its parent's
      if (session !== raw) report.context = undefined as any
      channel.report(report)
    }
    // OpenCode's form and permission events, as asks (tier 0d).
    const onAskEvent = async (event: any) => {
      const data = event?.data ?? {}
      const raw =
        event.type === "form.created" ? data.form?.sessionID : data.sessionID
      if (typeof raw !== "string" || !ours(event, raw)) return
      const session = await askSession(raw)
      if (!registered.has(session)) return
      log(`${event.type} in ${session}`)
      if (event.type === "form.created") {
        const ask = formEvent(session, data.form)
        if (ask) {
          listing?.add(ask.ref)
          channel.report(ask)
        }
      } else if (event.type === "permission.asked") {
        const ask = permissionEvent(session, data)
        if (ask) {
          listing?.add(ask.ref)
          channel.report(ask)
        }
      } else {
        const ref =
          event.type === "permission.replied" ? data.requestID : data.id
        if (typeof ref !== "string") return
        channel.report({
          type: "ask.settled",
          session,
          ref,
          how:
            event.type === "form.cancelled"
              ? "cancelled"
              : event.type === "permission.replied"
                ? String(data.reply ?? "replied")
                : "answered",
        })
      }
    }
    // the step reports of each session, chained in order
    const steps = new Map<string, Promise<void>>()
    let subscribed = 0
    const watch = async () => {
      while (!events.signal.aborted) {
        if (subscribed++) void reportActive()
        try {
          const types = [
            "session.created",
            "session.deleted",
            ...Object.keys(TURN_EVENTS),
            ...ASK_EVENTS,
            "session.step.ended",
          ]
          for await (const event of ctx.event.subscribe({
            types,
            signal: events.signal,
          })) {
            const data = event?.data
            if ((ASK_EVENTS as readonly string[]).includes(event.type)) {
              void onAskEvent(event)
              continue
            }
            if (event.type === "session.step.ended") {
              // in order per session; a turn's end waits for its steps
              const sid = String(data?.sessionID ?? "")
              const prev = steps.get(sid) ?? Promise.resolve()
              const next = prev.then(() => onStep(event)).catch(() => {})
              steps.set(sid, next)
              void next.finally(() => {
                if (steps.get(sid) === next) steps.delete(sid)
              })
              continue
            }
            if (typeof data?.sessionID !== "string") continue
            const session = data.sessionID as string
            if (event.type === "session.deleted") {
              channel.report({ type: "session.deleted", session })
              // its token is dead: no need to keep it
              void tokens.drop(session)
            } else if (event.type === "session.created") {
              if (!data.parentID && data.location?.directory === directory) {
                mine.add(session)
                channel.report({ type: "session.created", session, directory })
              }
            } else if (event.type in TURN_EVENTS) {
              if (!ours(event, session)) continue
              // a Subagent's turn is part of its session's turn
              if ((await tokens.root(session).catch(() => session)) !== session)
                continue
              const outcome =
                TURN_EVENTS[event.type as keyof typeof TURN_EVENTS]
              // the turn's steps are reported first (their cost counts)
              if (outcome !== "started") await steps.get(session)
              // OpenCode's own time of the event orders them at the server
              const at = Number(event.created) || Date.now()
              // a run of a job ends with its last reply (tier 0f)
              const reply =
                outcome === "succeeded" && runs.has(session)
                  ? lastReply(
                      await ctx.session
                        .context({ sessionID: session })
                        .catch(() => []),
                    )
                  : null
              channel.report(
                outcome === "started"
                  ? { type: "turn.started", session, at }
                  : {
                      type: "turn.ended",
                      session,
                      outcome,
                      at,
                      ...(data.error?.type ? { error: data.error.type } : {}),
                      ...(reply ? { reply } : {}),
                    },
              )
            }
          }
        } catch (err) {
          if (!events.signal.aborted)
            log(`event stream ended: ${(err as Error).message}`)
        }
        if (!events.signal.aborted) await Bun.sleep(5000)
      }
    }
    void watch()

    channel.start()
    log(`started for ${directory} as ${host}`)
    return async () => {
      events.abort()
      if (activeTimer) clearInterval(activeTimer)
      await channel.stop()
    }
  },
}
