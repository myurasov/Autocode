/*
 * Autocode's OpenCode 2 plugin: links this OpenCode server's sessions to an
 * Autocode server. It stays out of the way when the machine has no client
 * config.
 */
import { Channel, type Instruction } from "./channel.ts"
import { request, ServerError } from "./client.ts"
import { hostId, machineName, processOf, readClientConfig } from "./config.ts"
import { sessionIsGone } from "./errors.ts"
import { findLocalApi, setEnvironment, shellVariables } from "./localapi.ts"
import { log } from "./log.ts"
import { SessionTokens } from "./sessions.ts"
import { ME_TOOL, type MeInput, runMe } from "./tools.ts"

type Ctx = any

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

    const channel = new Channel({
      config,
      host,
      instance,
      machine: machineName(),
      directory,
      opencodeVersion: String(ctx.app?.version ?? ""),
      process: processOf(),
      shellValues: api !== undefined,
      log,
      onInstruction: async (instruction: Instruction) => {
        if (instruction.type === "token") {
          // The owner rotated the session's token: the old one is dead; get a
          // new one now, and put it into the shells that had the old one.
          const session = String(instruction.payload?.session ?? "")
          tokens.drop(session)
          await tokens.token(session)
          await renewShellValues(session)
          return { renewed: true }
        }
        if (instruction.type === "ping") return { pong: true }
        throw new Error(`unknown instruction ${instruction.type}`)
      },
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
        return (Array.isArray(page?.data) ? page.data : [])
          .filter((s: any) => typeof s?.id === "string" && !s.parentID)
          .map((s: any) => ({
            id: s.id as string,
            directory: String(s.location?.directory ?? directory),
          }))
      },
    })

    const tokens = new SessionTokens({
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
    ) => {
      const root = await tokens.root(sessionID)
      for (let attempt = 0; ; attempt++) {
        const token = await tokens.token(root)
        try {
          return await request(config.url, token, method, path, body, 10_000)
        } catch (err) {
          if (
            err instanceof ServerError &&
            err.status === 401 &&
            attempt === 0
          ) {
            tokens.drop(root)
            continue
          }
          throw err
        }
      }
    }

    /*
     * Shell values: each session's environment holds its top-level session's
     * values on top of OpenCode's own environment, set before the session's
     * first shell call and again after a rotation. `shellSet` is what each
     * session's environment holds now.
     */
    const shellSet = new Map<string, { root: string; token: string }>()
    const shellPending = new Map<string, Promise<void>>()
    const putShellValues = async (session: string, root: string) => {
      if (!api) return
      const token = await tokens.token(root)
      if (shellSet.get(session)?.token === token) return
      await setEnvironment(
        api,
        session,
        shellVariables(process.env, {
          AUTOCODE_URL: config.url,
          AUTOCODE_TOKEN: token,
          AUTOCODE_SERVER_ID: channel.serverId ?? "",
          AUTOCODE_SESSION: root,
        }),
      )
      shellSet.set(session, { root, token })
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

    await ctx.tool.transform((tools: any) => {
      tools.add({
        ...ME_TOOL,
        options: { codemode: false },
        execute: async (input: MeInput, tctx: any) => {
          try {
            const text = await runMe(input, (method, path, body) =>
              callAs(tctx.sessionID, method, path, body),
            )
            return { content: text }
          } catch (err) {
            const e = err as ServerError
            const code = e instanceof ServerError ? ` (${e.code})` : ""
            return { content: `error${code}: ${e.message}` }
          }
        },
      })
    })

    // OpenCode awaits this before it builds the shell's environment, so the
    // session's values are in place for its first shell.
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
     * New top-level sessions of this folder and deleted sessions are reported
     * to the server; the subscription is renewed if its stream ends. (It
     * carries every folder's events: only this folder's new sessions are this
     * host's.)
     */
    const events = new AbortController()
    const watch = async () => {
      while (!events.signal.aborted) {
        try {
          const types = ["session.created", "session.deleted"]
          for await (const event of ctx.event.subscribe({
            types,
            signal: events.signal,
          })) {
            const data = event?.data
            if (typeof data?.sessionID !== "string") continue
            if (event.type === "session.deleted")
              channel.report({
                type: "session.deleted",
                session: data.sessionID,
              })
            else if (
              event.type === "session.created" &&
              !data.parentID &&
              data.location?.directory === directory
            )
              channel.report({
                type: "session.created",
                session: data.sessionID,
                directory,
              })
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
      await channel.stop()
    }
  },
}
