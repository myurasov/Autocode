/*
 * Starts the Autocode server: opens the database in the data folder, defines
 * the API routes, serves the API and the web UI on the listen addresses, and
 * runs maintenance on a timer.
 */

import type { Database } from "bun:sqlite"
import { chmodSync, existsSync, writeFileSync } from "node:fs"
import { hostname as osHostname } from "node:os"
import { join } from "node:path"
import { AutocodeError, checkId, parseListen, VERSION } from "@autocode/shared"
import { Agents } from "./agents.ts"
import { ensureDataDir, resolveServerId, tailscaleAddress } from "./config.ts"
import { History } from "./history.ts"
import { Hosts } from "./hosts.ts"
import { json, openapi, type Route, router } from "./http.ts"
import { SettingsStore } from "./settings-store.ts"
import { openStore } from "./store.ts"
import {
  authenticate,
  ensureOwnerTokens,
  issueSessionToken,
  pruneTokens,
} from "./tokens.ts"
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
  enqueue(host: string, type: string, payload: unknown): string
  instruction(id: string): { acked: boolean; result: unknown } | undefined
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
  const agents = new Agents(db, history, hosts, now)
  history.record("server.started", { data: { id, version: VERSION } })

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
      summary: "the calling session's registration and status",
      handler: ({ caller }) => agents.me(caller!.session!),
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
    history.trim(Number(settings.value("history_days")) || 30)
  }
  maintenance()
  const timer =
    options.maintenanceEvery === 0
      ? undefined
      : setInterval(maintenance, options.maintenanceEvery ?? 5000)

  return {
    id,
    url: urls[0]!,
    urls,
    port: servers[0]?.port ?? 0,
    firstStartTokens,
    db,
    maintenance,
    enqueue: (host, type, payload) => hosts.enqueue(host, type, payload),
    instruction: (instructionId) => hosts.instruction(instructionId),
    checkpoint: async () => {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    },
    stop: async () => {
      if (timer) clearInterval(timer)
      if (rebind) clearInterval(rebind)
      hosts.close()
      await Promise.all(servers.map((s) => s.stop(true)))
      db.close()
    },
  }
}
