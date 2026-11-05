/*
 * Starts the Autocode server: opens the database in the data folder, defines
 * the API routes, serves the API and the web UI on the listen addresses, and
 * runs the scheduler (wakes and injections) and maintenance on timers.
 */

import type { Database } from "bun:sqlite"
import { chmodSync, existsSync, writeFileSync } from "node:fs"
import { hostname as osHostname } from "node:os"
import { join } from "node:path"
import {
  AutocodeError,
  checkId,
  machineName,
  parseDuration,
  parseListen,
  resolveSettings,
  VERSION,
} from "@autocode/shared"
import { Agents } from "./agents.ts"
import { ensureDataDir, resolveServerId, tailscaleAddress } from "./config.ts"
import { Delivery } from "./delivery.ts"
import { History } from "./history.ts"
import { Hosts } from "./hosts.ts"
import { json, openapi, type Route, router } from "./http.ts"
import { type FindService, findService, Loader } from "./loader.ts"
import { Inbox, Messages } from "./messages.ts"
import { Retries } from "./retries.ts"
import { SettingsStore } from "./settings-store.ts"
import { openStore } from "./store.ts"
import {
  authenticate,
  ensureOwnerTokens,
  issueSessionToken,
  pruneTokens,
} from "./tokens.ts"
import { notRegistered, Wakes } from "./wakes.ts"
import { type WebFiles, webHandler } from "./web.ts"

export interface Clock {
  now(): number
}

export interface ServerOptions {
  dataDir: string
  id?: string
  /*
   * In the listen setting's format, joined with commas:
   * "localhost,tailscale:4848", "127.0.0.1:0" (0: a free port). Without it, the
   * listen setting.
   */
  listen?: string[]
  clock?: Clock
  pollWait?: number
  offlineAfter?: number
  takeoverGraceMs?: number
  maintenanceEvery?: number
  // How often the scheduler runs (ms; 0: never, tests call tick()).
  tickEvery?: number
  // This machine's name (hosts on it get unloaded folders loaded again), and
  // how to find its background service (tests replace both).
  machine?: string
  findService?: FindService
  presetTokens?: { admin?: string; consumer?: string }
  hostname?: string
  web?: WebFiles
  // The machine's Tailscale address (tests replace it); a missing one is looked
  // for every rebindEveryMs.
  tailscale?: () => string | undefined
  rebindEveryMs?: number
  log?: (line: string) => void
}

export interface RunningServer {
  id: string
  url: string
  // Grows when a Tailscale address that was missing at the start appears.
  urls: string[]
  port: number
  firstStartTokens?: { admin?: string; consumer?: string }
  db: Database
  stop(): Promise<void>
  maintenance(): void
  // One scheduler run: due wakes, checks, injections.
  tick(): void
  enqueue(host: string, type: string, payload: unknown): string
  instruction(
    id: string,
  ):
    | { acked: boolean; ok: boolean; result: unknown; error: string | null }
    | undefined
  checkpoint(): Promise<void>
}

export async function startServer(
  options: ServerOptions,
): Promise<RunningServer> {
  const log = options.log ?? ((line: string) => console.log(line))
  const clock = options.clock ?? { now: () => Date.now() }
  const now = () => clock.now()
  const id = resolveServerId(
    options.id,
    options.dataDir,
    options.hostname ?? osHostname(),
  )
  ensureDataDir(options.dataDir)
  // The database is the owner's alone (token hashes, agents, history): 0600,
  // and SQLite gives its -wal and -shm files the database file's mode.
  const dbPath = join(options.dataDir, "autocode.db")
  if (!existsSync(dbPath)) writeFileSync(dbPath, "", { mode: 0o600 })
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
    if (existsSync(file)) chmodSync(file, 0o600)
  const db = openStore(dbPath)
  const firstStartTokens = ensureOwnerTokens(
    db,
    options.dataDir,
    options.presetTokens,
    now(),
  )
  db.query(
    "INSERT INTO server (key, value) VALUES ('id', ?) " +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(id)

  const pollWait = options.pollWait ?? 50
  const history = new History(db, now)
  const settings = new SettingsStore(db)
  const hosts = new Hosts(db, history, now, {
    serverId: id,
    pollWait,
    offlineAfter: options.offlineAfter ?? pollWait + 15,
    redeliverAfter: 30,
    takeoverGraceMs: options.takeoverGraceMs,
  })
  const tz = () => String(settings.value("timezone")) || "UTC"
  const wakes = new Wakes(db, history, now, tz)
  let messages: Messages
  const inbox = new Inbox(db, history, now, () => messages)
  // a failed turn's error state and its retries (tier 0b3)
  const retries = new Retries(db, history, settings, inbox, now)
  hosts.onTurnEnded = (agent, outcome, error) =>
    retries.turnEnded(agent, outcome, error)
  const delivery = new Delivery(
    db,
    history,
    hosts,
    settings,
    wakes,
    () => messages,
    inbox,
    now,
    retries,
    new Loader(
      history,
      options.machine ?? machineName(options.hostname ?? osHostname()),
      options.findService ?? findService,
      now,
    ),
  )
  messages = new Messages(
    db,
    history,
    now,
    delivery.enqueueMessage,
    () => inbox,
  )
  const agents = new Agents(
    db,
    history,
    hosts,
    now,
    (agent) => inbox.closeForAgent(agent),
    (agent) => delivery.cancelPending(agent),
  )
  history.record("server.started", { data: { id, version: VERSION } })

  // The calling session's agent ID; a session that is not registered has no
  // wakes or messages.
  const me = (caller: { session?: string } | undefined): string => {
    const agent = caller?.session ? agents.agentOfSession(caller.session) : ""
    if (!agent) throw notRegistered()
    return agent
  }
  // Who acts: the owner (admin token) or the calling agent.
  const actor = (caller: any): string =>
    caller?.kind === "admin" ? "owner" : me(caller)
  const agentParam = (value: string | undefined): string => {
    const agent = checkId(value, "agent ID")
    agents.get(agent)
    return agent
  }

  const sessionDeleted = (session: string) => {
    const row = db
      .query("SELECT host_id FROM sessions WHERE id = ?")
      .get(session) as any
    history.record("session.deleted", {
      session,
      host: row?.host_id ?? null,
      agent: agents.agentOfSession(session) ?? null,
    })
  }

  const routes: Route[] = [
    {
      method: "GET",
      path: "/v1/info",
      access: "public",
      summary: "server ID and version",
      handler: () => ({ id, version: VERSION }),
    },
    {
      method: "GET",
      path: "/v1/whoami",
      access: ["admin", "consumer", "session"],
      summary: "the kind of the calling token",
      handler: ({ caller }) =>
        caller?.session
          ? { kind: caller.kind, session: caller.session }
          : { kind: caller?.kind },
    },
    {
      method: "POST",
      path: "/v1/hosts/:host/hello",
      access: ["consumer"],
      summary: "a plugin instance says hello",
      handler: async ({ params, body }) =>
        hosts.hello(params.host!, await body()),
    },
    {
      method: "GET",
      path: "/v1/hosts/:host/next",
      access: ["consumer"],
      summary: "long-poll for instructions",
      handler: async ({ params, url, req }) => {
        const wait = Number(url.searchParams.get("wait") ?? pollWait)
        if (!Number.isFinite(wait) || wait < 0)
          throw new AutocodeError("bad_request", "wait must be seconds")
        return hosts.next(
          params.host!,
          url.searchParams.get("instance"),
          wait,
          req.signal,
        )
      },
    },
    {
      method: "POST",
      path: "/v1/hosts/:host/events",
      access: ["consumer"],
      summary: "acknowledgements and events from a plugin",
      handler: async ({ params, body }) =>
        hosts.events(params.host!, await body(), sessionDeleted),
    },
    {
      method: "POST",
      path: "/v1/hosts/:host/sessions/:session/token",
      access: ["consumer"],
      summary: "a token for one of the host's sessions",
      handler: async ({ params, body }) => {
        const host = params.host!
        checkId(host, "host ID")
        const session = checkId(params.session, "session ID")
        const input = await body()
        if (!db.query("SELECT 1 FROM hosts WHERE id = ?").get(host))
          throw new AutocodeError(
            "unknown_host",
            `host ${host} has not said hello`,
            404,
          )
        // A deleted session never comes back (a late call from it must not take
        // its agent ID back).
        if (
          (
            db
              .query("SELECT deleted_at FROM sessions WHERE id = ?")
              .get(session) as any
          )?.deleted_at
        )
          throw new AutocodeError(
            "session_gone",
            `session ${session} was deleted`,
            410,
          )
        const directory =
          typeof input?.directory === "string" ? input.directory : ""
        hosts.noteSessions(host, [{ id: session, directory }])
        const token = issueSessionToken(db, session, now())
        history.record("session.token", {
          session,
          host,
          agent: agents.agentOfSession(session) ?? null,
        })
        return { token, session, server: { id } }
      },
    },
    {
      method: "GET",
      path: "/v1/hosts",
      access: ["admin", "consumer"],
      summary: "the plugin instances the server knows",
      handler: () => ({ hosts: hosts.list() }),
    },
    {
      method: "POST",
      path: "/v1/agents",
      access: ["session", "admin"],
      summary: "register an agent",
      handler: async ({ caller, body }) => {
        const result = agents.register(caller!, await body())
        return json({ agent: result.agent }, result.status)
      },
    },
    {
      method: "GET",
      path: "/v1/agents",
      access: ["session", "admin", "consumer"],
      summary: "discover agents by pattern",
      handler: ({ caller, url }) => ({
        agents: agents.list(
          url.searchParams.get("match"),
          caller!.kind === "session" ? "discover" : "owner",
        ),
      }),
    },
    {
      method: "GET",
      path: "/v1/agents/:id",
      access: ["admin", "consumer"],
      summary: "one agent",
      handler: ({ params }) => ({ agent: agents.get(params.id!) }),
    },
    {
      method: "PATCH",
      path: "/v1/agents/:id",
      access: ["admin"],
      summary: "change an agent's description",
      handler: async ({ params, body }) => ({
        agent: agents.patch(params.id!, await body()),
      }),
    },
    {
      method: "DELETE",
      path: "/v1/agents/:id",
      access: ["admin"],
      summary: "unregister an agent",
      handler: ({ params }) =>
        agents.unregister(checkId(params.id, "agent ID"), "owner"),
    },
    {
      method: "POST",
      path: "/v1/agents/:id/token/rotate",
      access: ["admin"],
      summary: "replace an agent's session token",
      handler: ({ params }) => agents.rotate(params.id!),
    },
    {
      method: "GET",
      path: "/v1/me",
      access: ["session"],
      summary:
        "the calling session's registration and status, the server's time " +
        "and zone, the delivery settings, its wakes and unread messages",
      handler: ({ caller }) => {
        const res: any = agents.me(caller!.session!)
        const agent: string | undefined = res.registered
          ? res.agent.id
          : undefined
        const values: Record<string, unknown> = agent
          ? resolveSettings(settings.layers(), agent).values
          : {}
        const value = (key: string) =>
          agent ? values[key] : settings.value(key)
        return {
          ...res,
          server: {
            id,
            time: new Date(now()).toISOString(),
            timezone: tz(),
          },
          settings: {
            min_interval: value("min_interval"),
            inline_limit: value("inline_limit"),
            max_tool_wait: value("max_tool_wait"),
            retry_interval: value("retry_interval"),
            retry_attempts: value("retry_attempts"),
          },
          ...(agent
            ? {
                wakes: wakes.summary(agent),
                unread: messages.list(agent).length,
              }
            : {}),
        }
      },
    },
    {
      method: "DELETE",
      path: "/v1/me",
      access: ["session"],
      summary: "unregister the calling session",
      handler: ({ caller }) => agents.unregisterSession(caller!.session!),
    },
    {
      method: "GET",
      path: "/v1/settings",
      access: ["admin", "consumer"],
      summary:
        "settings: defaults, pattern rules and agents' values; " +
        "?agent= for one agent's resolved values",
      handler: ({ url }) => {
        const agent = url.searchParams.get("agent")
        return agent ? settings.resolved(agent) : settings.view()
      },
    },
    {
      method: "PATCH",
      path: "/v1/settings",
      access: ["admin"],
      summary: "change settings",
      handler: async ({ body }) => {
        const change = settings.patch(await body())
        history.record("settings.changed", { data: change })
        return settings.view()
      },
    },
    {
      method: "GET",
      path: "/v1/history",
      access: ["admin", "consumer"],
      summary: "history, newest first (agent, kind, since, until, limit)",
      handler: ({ url }) => {
        const q = url.searchParams
        return {
          history: history.list({
            agent: q.get("agent") ?? undefined,
            kind: q.get("kind") ?? undefined,
            since: q.get("since") ?? undefined,
            until: q.get("until") ?? undefined,
            limit: q.get("limit") ?? undefined,
          }),
        }
      },
    },
    // wakes
    {
      method: "GET",
      path: "/v1/me/wakes",
      access: ["session"],
      summary: "the calling agent's wakes",
      handler: ({ caller }) => ({ wakes: wakes.list(me(caller)) }),
    },
    {
      method: "PUT",
      path: "/v1/me/wakes/:name",
      access: ["session"],
      summary: "set (or replace) one of the calling agent's wakes",
      handler: async ({ caller, params, body }) => {
        const agent = me(caller)
        const res = wakes.set(agent, params.name, await body(), agent)
        return json({ wake: res.wake }, res.status)
      },
    },
    {
      method: "DELETE",
      path: "/v1/me/wakes/:name",
      access: ["session"],
      summary: "cancel one of the calling agent's wakes",
      handler: ({ caller, params }) => {
        const agent = me(caller)
        return wakes.cancel(agent, params.name, agent)
      },
    },
    {
      method: "GET",
      path: "/v1/wakes",
      access: ["admin"],
      summary: "every agent's wakes",
      handler: () => ({ wakes: wakes.list() }),
    },
    {
      method: "GET",
      path: "/v1/agents/:id/wakes",
      access: ["admin"],
      summary: "an agent's wakes",
      handler: ({ params }) => ({ wakes: wakes.list(agentParam(params.id)) }),
    },
    {
      method: "PUT",
      path: "/v1/agents/:id/wakes/:name",
      access: ["admin"],
      summary: "set (or replace) an agent's wake",
      handler: async ({ params, body }) => {
        const res = wakes.set(
          agentParam(params.id),
          params.name,
          await body(),
          "owner",
        )
        return json({ wake: res.wake }, res.status)
      },
    },
    {
      method: "DELETE",
      path: "/v1/agents/:id/wakes/:name",
      access: ["admin"],
      summary: "cancel an agent's wake",
      handler: ({ params }) =>
        wakes.cancel(agentParam(params.id), params.name, "owner"),
    },
    {
      method: "POST",
      path: "/v1/agents/:id/wakes/:name/fire",
      access: ["session", "admin"],
      summary: "fire an agent's wake now (it skips its check)",
      handler: async ({ caller, params, body }) => {
        const by = actor(caller)
        const input = await body().catch(() => ({}))
        return wakes.fire(
          checkId(params.id, "agent ID"),
          params.name,
          by,
          input?.text,
          delivery.enqueueWake,
        )
      },
    },
    // messages
    {
      method: "POST",
      path: "/v1/messages",
      access: ["session", "admin"],
      summary: "send a message to an agent, a pattern, a list or the owner",
      handler: async ({ caller, body }) =>
        json(messages.send(actor(caller), await body()), 201),
    },
    {
      method: "GET",
      path: "/v1/me/messages",
      access: ["session"],
      summary:
        "the calling agent's unread messages (?all=1 for every one; " +
        "?wait=seconds waits for one, up to max_tool_wait)",
      handler: async ({ caller, url, req }) => {
        const agent = me(caller)
        const q = url.searchParams
        const all = q.get("all") === "1" || q.get("all") === "true"
        const wait = Number(q.get("wait") ?? 0)
        if (!Number.isFinite(wait) || wait < 0)
          throw new AutocodeError("bad_request", "wait must be seconds")
        if (!wait || all) return { messages: messages.list(agent, all) }
        const values = resolveSettings(settings.layers(), agent).values
        const most = parseDuration(String(values.max_tool_wait)) / 1000
        return {
          messages: await messages.wait(
            agent,
            Math.min(wait, most),
            req.signal,
          ),
        }
      },
    },
    {
      method: "GET",
      path: "/v1/me/messages/:id",
      access: ["session"],
      summary: "read one of the calling agent's messages (marks it read)",
      handler: ({ caller, params }) => ({
        message: messages.read(me(caller), String(params.id)),
      }),
    },
    {
      method: "GET",
      path: "/v1/messages",
      access: ["admin"],
      summary: "every message, newest first (?agent=, ?limit=)",
      handler: ({ url }) => ({
        messages: messages.all({
          agent: url.searchParams.get("agent") ?? undefined,
          limit: Number(url.searchParams.get("limit")) || undefined,
        }),
      }),
    },
    {
      method: "GET",
      path: "/v1/messages/:id",
      access: ["admin"],
      summary: "any message, whole (the owner's read; its state stays)",
      handler: ({ params }) => ({
        message: messages.ownerRead(String(params.id)),
      }),
    },
    // the owner: inbox, pause, stop all
    {
      method: "GET",
      path: "/v1/inbox",
      access: ["admin"],
      summary: "the owner's open inbox items (?all=1 for closed ones too)",
      handler: ({ url }) => ({
        items: inbox.list(url.searchParams.get("all") === "1"),
      }),
    },
    {
      method: "POST",
      path: "/v1/inbox/:id/answer",
      access: ["admin"],
      summary: "answer a message to the owner (the reply goes to the agent)",
      handler: async ({ params, body }) => ({
        item: inbox.answer(String(params.id), await body()),
      }),
    },
    {
      method: "POST",
      path: "/v1/inbox/:id/close",
      access: ["admin"],
      summary: "close an inbox item",
      handler: ({ params }) => ({ item: inbox.close(String(params.id)) }),
    },
    {
      method: "POST",
      path: "/v1/agents/:id/pause",
      access: ["admin"],
      summary: "pause an agent's injections",
      handler: ({ params }) => ({ agent: agents.pause(String(params.id)) }),
    },
    {
      method: "POST",
      path: "/v1/agents/:id/resume",
      access: ["admin"],
      summary: "resume an agent's injections",
      handler: ({ params }) => ({ agent: agents.resume(String(params.id)) }),
    },
    {
      method: "POST",
      path: "/v1/agents/:id/retry",
      access: ["admin"],
      summary:
        "retry an agent in the error state now (its last turn failed), also " +
        "after a failure that is not retried or after the retries ran out",
      handler: ({ params }) => {
        const id = String(params.id)
        retries.request(id, "owner")
        return { agent: agents.get(id) }
      },
    },
    {
      method: "POST",
      path: "/v1/stop-all",
      access: ["admin"],
      summary: "pause every agent and interrupt every running turn",
      handler: () => agents.stopAll(),
    },
    {
      method: "POST",
      path: "/v1/resume-all",
      access: ["admin"],
      summary: "resume the agents stop-all paused",
      handler: () => agents.resumeAll(),
    },
  ]
  routes.push({
    method: "GET",
    path: "/openapi.json",
    access: "public",
    summary: "this API's description",
    handler: () => openapi(routes, VERSION),
  })

  const api = router(
    routes,
    (req) => {
      const caller = authenticate(db, req.headers.get("authorization"))
      if (caller?.kind === "session" && caller.session)
        agents.touch(caller.session)
      return caller
    },
    log,
  )
  const web = webHandler(options.web)
  const handle = async (req: Request) => web?.(req) ?? api(req)

  /*
   * Listening: "localhost" is 127.0.0.1; "tailscale" is the machine's Tailscale
   * address, which may appear only after the start (a server started at boot
   * before Tailscale is up): it is looked for again until it is there.
   */
  const addresses = parseListen(
    options.listen?.length
      ? options.listen.join(",")
      : String(settings.value("listen")),
  )
  const findTailscale = options.tailscale ?? tailscaleAddress
  const servers: ReturnType<typeof Bun.serve>[] = []
  const urls: string[] = []
  const bound = new Set<string>()
  const bind = (host: string, port: number) => {
    if (port !== 0 && bound.has(`${host}:${port}`)) return
    const server = Bun.serve({
      hostname: host,
      port,
      idleTimeout: 255,
      fetch: handle,
    })
    bound.add(`${host}:${port}`)
    servers.push(server)
    urls.push(`http://${server.hostname}:${server.port}`)
    return urls.at(-1)
  }
  const waiting: number[] = []
  for (const { host, port } of addresses) {
    if (host !== "tailscale")
      bind(host === "localhost" ? "127.0.0.1" : host, port)
    else {
      const address = findTailscale()
      if (address) bind(address, port)
      else waiting.push(port)
    }
  }
  if (waiting.length)
    log(
      "no Tailscale address yet: the server listens on it " +
        `(port ${waiting.join(", ")}) once it appears`,
    )
  const rebind = waiting.length
    ? setInterval(() => {
        const address = findTailscale()
        if (!address) return
        for (const port of waiting.splice(0)) {
          try {
            const url = bind(address, port)
            if (url) log(`listening on ${url}`)
          } catch (err) {
            waiting.push(port)
            log(
              `cannot listen on ${address}:${port} ` +
                `yet: ${(err as Error).message}`,
            )
          }
        }
        if (!waiting.length) clearInterval(rebind)
      }, options.rebindEveryMs ?? 5000)
    : undefined

  const maintenance = () => {
    hosts.sweep()
    hosts.prune()
    pruneTokens(db, now())
    const days = Number(settings.value("history_days")) || 30
    history.trim(days)
    messages.trim(days)
    delivery.trim(days)
    inbox.trim(days)
  }
  maintenance()
  const timer =
    options.maintenanceEvery === 0
      ? undefined
      : setInterval(maintenance, options.maintenanceEvery ?? 5000)
  const tick = () => {
    try {
      delivery.tick()
    } catch (err) {
      log(`scheduler: ${(err as Error).message}`)
    }
  }
  const ticker =
    options.tickEvery === 0
      ? undefined
      : setInterval(tick, options.tickEvery ?? 1000)

  return {
    id,
    url: urls[0]!,
    urls,
    port: servers[0]?.port ?? 0,
    firstStartTokens,
    db,
    maintenance,
    tick: () => delivery.tick(),
    enqueue: (host, type, payload) => hosts.enqueue(host, type, payload),
    instruction: (instructionId) => hosts.instruction(instructionId),
    checkpoint: async () => {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    },
    stop: async () => {
      if (timer) clearInterval(timer)
      if (ticker) clearInterval(ticker)
      if (rebind) clearInterval(rebind)
      hosts.close()
      messages.close()
      await Promise.all(servers.map((s) => s.stop(true)))
      db.close()
    },
  }
}
