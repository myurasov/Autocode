/*
 * Starts the Autocode server: opens the database in the data folder, defines
 * the API routes, serves the API and the web UI on the listen addresses, and
 * runs the scheduler (lock expiry, wakes and injections) and maintenance on
 * timers.
 */

import type { Database } from "bun:sqlite"
import { chmodSync, existsSync, writeFileSync } from "node:fs"
import { hostname as osHostname } from "node:os"
import { join } from "node:path"
import {
  AutocodeError,
  checkId,
  localTime,
  machineName,
  matchesPattern,
  onlyFields,
  parseDuration,
  parseListen,
  resolveSettings,
  VERSION,
} from "@autocode/shared"
import { Agents } from "./agents.ts"
import { Asks } from "./asks.ts"
import { ensureDataDir, resolveServerId, tailscaleAddress } from "./config.ts"
import { Costs } from "./costs.ts"
import { Delivery } from "./delivery.ts"
import { History } from "./history.ts"
import { Hosts } from "./hosts.ts"
import { json, openapi, type Route, router } from "./http.ts"
import { Jobs } from "./jobs.ts"
import {
  type EnsureService,
  ensureService,
  type FindService,
  findService,
  Loader,
} from "./loader.ts"
import { formatTtl, type LockNotice, Locks } from "./locks.ts"
import { Inbox, Messages } from "./messages.ts"
import { Retries } from "./retries.ts"
import { SettingsStore } from "./settings-store.ts"
import { openStore } from "./store.ts"
import {
  authenticate,
  ensureOwnerTokens,
  issueSessionToken,
  pruneTokens,
  touchToken,
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
  ensureService?: EnsureService
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
  // unloaded folders, and the background service restarted (tier 0e)
  const loader = new Loader(
    history,
    options.machine ?? machineName(options.hostname ?? osHostname()),
    options.findService ?? findService,
    now,
    60_000,
    options.ensureService ?? ensureService,
    (host) =>
      inbox.open("alert", {
        title:
          `OpenCode of ${host.id} (${host.directory}) is gone; Autocode ` +
          "restarts only the background service: start it again",
        body:
          "Its agents' wakes and messages wait until it is back. Run " +
          "OpenCode as the background service (opencode serve --service, " +
          "the default) to have Autocode restart it.",
      }),
  )
  hosts.onHello = (host, body) => {
    loader.online(host)
    // the forms and requests OpenCode still has (the review of 0d)
    if (body?.pending && typeof body.pending === "object")
      asks.stillPending(body.pending)
  }
  hosts.onSessionTurnEnded = (session) => {
    asks.turnEnded(session)
    jobs.sessionTurnEnded(session)
  }
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
    loader,
  )
  messages = new Messages(
    db,
    history,
    now,
    delivery.enqueueMessage,
    () => inbox,
  )
  // Locks and semaphores (tier 0c): grants, expiries and the owner's
  // releases are notices, messages from autocode.
  const noticeText = (n: LockNotice): [string, string] => {
    const when = (ms: number) => localTime(ms, tz())
    const name = `lock "${n.lock}"`
    switch (n.kind) {
      case "granted":
        return [
          `${name} granted`,
          `You hold ${name} now` +
            (n.max > 1 ? ` (one of its ${n.max} places)` : "") +
            `, until ${when(n.expires!)}: its ttl of ` +
            `${formatTtl(n.ttl!)} counts from the grant. Renew it before ` +
            "then (autocode_lock " +
            `action=renew name=${n.lock}); release it when you are done ` +
            "(action=release).",
        ]
      case "expired":
        return [
          `${name} expired`,
          `Your hold on ${name} ran out at ${when(n.at!)} (its ttl was ` +
            `${formatTtl(n.ttl!)}) and was freed; another agent may hold ` +
            "it now. Acquire it again if you still need it.",
        ]
      case "released":
        return [
          `${name} released by the owner`,
          `The owner released your hold on ${name} at ${when(n.at!)}; ` +
            "another agent may hold it now. Acquire it again if you still " +
            "need it.",
        ]
      case "removed":
        return [
          `${name}: out of the queue`,
          `The owner took you out of the queue of ${name} at ` +
            `${when(n.at!)}; it will not be granted to you. Acquire it ` +
            "again if you still need it.",
        ]
    }
  }
  const locks = new Locks(db, history, now, (n) => {
    const [subject, text] = noticeText(n)
    messages.notice(n.agent, subject, text)
  })
  /*
   * Questions, permission prompts and approvals (tier 0d): answers go back
   * to the plugin as instructions; what an agent must know comes as a notice.
   */
  const asks = new Asks(
    db,
    history,
    settings,
    now,
    (o) => {
      if (!o.host) return null
      const { host, ...payload } = o
      return hosts.enqueue(host, "answer", payload)
    },
    (n) => messages.notice(n.agent, n.subject, n.text),
    (agent) => !!db.query("SELECT 1 FROM agents WHERE id = ?").get(agent),
  )
  // Costs, the daily cap, compaction, cut turns and expiry (tier 0e).
  const costs = new Costs(
    db,
    history,
    settings,
    inbox,
    now,
    (n) => messages.notice(n.agent, n.subject, n.text),
    (agent) =>
      !!(
        db
          .query(
            "SELECT s.busy FROM agents a JOIN sessions s " +
              "ON s.id = a.session_id WHERE a.id = ?",
          )
          .get(agent) as any
      )?.busy,
  )
  delivery.costs = costs
  hosts.onTurnEnded = (agent, outcome, error, reply) => {
    retries.turnEnded(agent, outcome, error)
    costs.uncut(agent)
    costs.turnEnded(agent)
    /*
     * A run of a job: past run_usd it fails; idle with its reply it ends,
     * unless something of its own is pending (spec: no queued injection, no
     * open question or approval, no lock wait, no wake of its own).
     */
    const pending =
      !!db.query("SELECT 1 FROM queue WHERE agent_id = ?").get(agent) ||
      !!db.query("SELECT 1 FROM wakes WHERE agent_id = ?").get(agent) ||
      !!db
        .query("SELECT 1 FROM lock_entries WHERE agent_id = ? AND held = 0")
        .get(agent) ||
      !!(
        db
          .query(
            "SELECT s.inject_pending_at FROM agents a JOIN sessions s " +
              "ON s.id = a.session_id WHERE a.id = ?",
          )
          .get(agent) as any
      )?.inject_pending_at ||
      asks.of(agent).length > 0
    jobs.turnEnded(agent, outcome === "succeeded" ? reply : null, pending)
  }
  // an answer's instruction, followed to its ack (the review of 0d)
  const answerAck = (instructionId: string) => hosts.instruction(instructionId)
  const answerAlert = (agent: string, title: string, body: string) =>
    inbox.open("alert", { agent, title, body })
  hosts.onCost = (event) => {
    const agent = agents.agentOfSession(String(event.session))
    if (agent) costs.step(agent, event)
  }
  hosts.onCut = (session) => {
    const agent = agents.agentOfSession(session)
    if (agent) costs.cut(agent)
  }
  hosts.onAsk = (host, event) => {
    if (event.type === "asks.pending") {
      if (event.pending && typeof event.pending === "object")
        asks.stillPending(event.pending)
      return
    }
    if (event.type === "ask.settled") {
      asks.settled(
        String(event.session),
        String(event.ref ?? ""),
        String(event.how ?? "answered"),
      )
      return
    }
    const agent = agents.agentOfSession(String(event.session))
    if (agent) asks.opened(host, agent, event)
  }
  const agents = new Agents(
    db,
    history,
    hosts,
    now,
    (agent) => {
      inbox.closeForAgent(agent)
      locks.unregistered(agent)
      asks.unregistered(agent)
      messages.dropNotices(agent)
    },
    (agent) => delivery.cancelPending(agent),
  )
  agents.extra = (agent) => ({ cost: costs.view(agent) })
  /*
   * Jobs and their runs (tier 0f): a run's session is registered by the
   * owner's rule; its result is a message from autocode, or an inbox item for
   * the owner.
   */
  const jobs = new Jobs({
    db,
    history,
    now,
    tz,
    enqueue: (host, type, payload) => hosts.enqueue(host, type, payload),
    instruction: (instructionId) => hosts.instruction(instructionId),
    noteSession: (host, session) => {
      const row = db
        .query("SELECT directory FROM hosts WHERE id = ?")
        .get(host) as any
      hosts.noteSessions(host, [
        { id: session, directory: row?.directory ?? "" },
      ])
    },
    // never forced: an ID another live session holds is not taken
    register: (agentId, session, description) =>
      agents.register({ kind: "admin" } as any, {
        id: agentId,
        session,
        description,
      }),
    unregister: (agentId) => agents.unregister(agentId, "owner"),
    // the owner (the inbox) and agents, a pattern or a list of both
    tell: (to, subject, text) => {
      const parts = to.split(",").map((x) => x.trim())
      if (parts.includes("owner"))
        inbox.open("alert", {
          title: subject.replace(/^./, (c) => c.toUpperCase()),
          body: text,
        })
      const agentParts = parts.filter((x) => x && x !== "owner")
      if (!agentParts.length) return
      for (const id of db
        .query("SELECT id FROM agents ORDER BY id")
        .all()
        .map((r: any) => r.id as string))
        if (agentParts.some((part) => matchesPattern([part], id)))
          messages.notice(id, subject, text)
    },
    alert: (title, body) => inbox.open("alert", { title, body }),
    spent: (agent) => costs.total(agent),
    askText: (ask) => asks.askText(ask),
    released: (agent) => asks.unregistered(agent),
    load: (hostId) => {
      const h = db
        .query(
          "SELECT id, machine, directory, process_kind FROM hosts WHERE id = ?",
        )
        .get(hostId) as any
      if (h) loader.load(h)
    },
  })
  asks.jobIdle = (job) => jobs.idle(job)
  asks.startJob = (job, ask) =>
    jobs.start(job, "ask", "ask", undefined, ask)?.id ?? null
  retries.onGivenUp = (agent, reason) => jobs.turnsFailed(agent, reason)
  hosts.runsOf = (host) => jobs.runSessionsOf(host)
  history.record("server.started", { data: { id, version: VERSION } })
  locks.sweep()

  // The calling session's agent ID; a session that is not registered has no
  // wakes or messages.
  const me = (caller: { session?: string } | undefined): string => {
    const agent = caller?.session ? agents.agentOfSession(caller.session) : ""
    if (!agent) throw notRegistered()
    return agent
  }
  // Whose lock: the calling agent's, or for the owner the registered agent
  // it names.
  const lockAgent = (caller: any, b: any): string => {
    if (caller?.kind !== "admin") return me(caller)
    if (typeof b?.agent !== "string" || !b.agent)
      throw new AutocodeError(
        "bad_request",
        "the owner names the agent: {agent: ID}",
      )
    return agents.get(b.agent).id
  }
  // Who acts: the owner (admin token) or the calling agent.
  const actor = (caller: any): string =>
    caller?.kind === "admin" ? "owner" : me(caller)
  const agentParam = (value: string | undefined): string => {
    const agent = checkId(value, "agent ID")
    agents.get(agent)
    return agent
  }

  /*
   * A deleted session: its asks close and its agent's locks go (no turn of
   * it can release them); the agent stays, offline, so its ID can move to
   * a new session with its wakes (spec, Registration), until expire_after.
   */
  const sessionDeleted = (session: string) => {
    asks.gone(session)
    const row = db
      .query("SELECT host_id FROM sessions WHERE id = ?")
      .get(session) as any
    const agent = agents.agentOfSession(session) ?? null
    history.record("session.deleted", {
      session,
      host: row?.host_id ?? null,
      agent,
    })
    if (agent) locks.unregistered(agent)
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
                locks: locks.of(agent),
                asks: asks.of(agent),
                cost: costs.view(agent),
              }
            : {}),
        }
      },
    },
    {
      method: "POST",
      path: "/v1/me/compact",
      access: ["session"],
      summary: "compact the calling session after its current turn (tier 0e)",
      handler: ({ caller }) => {
        costs.wantCompact(me(caller))
        return { compact: "after this turn" }
      },
    },
    // jobs and runs (tier 0f)
    {
      method: "GET",
      path: "/v1/jobs",
      access: ["admin", "session"],
      summary: "every job (an agent sees names and descriptions)",
      handler: ({ caller }) => ({
        jobs: caller?.kind === "admin" ? jobs.list() : jobs.listForAgents(),
      }),
    },
    {
      method: "PUT",
      path: "/v1/jobs/:name",
      access: ["admin"],
      summary:
        "set a job {host, model, prompt, trigger, to, description, variant, " +
        "agent, timeout, run_usd, delete_session}",
      handler: async ({ params, body }) => {
        const res = jobs.set(params.name, await body())
        return json({ job: res.job }, res.status)
      },
    },
    {
      method: "DELETE",
      path: "/v1/jobs/:name",
      access: ["admin"],
      summary: "delete a job (its runs' history stays)",
      handler: ({ params }) => jobs.remove(params.name),
    },
    {
      method: "POST",
      path: "/v1/jobs/:name/run",
      access: ["admin", "session"],
      summary:
        "start a run now {text: added to the prompt}; refused while one runs",
      handler: async ({ caller, params, body }) => {
        const b = (await body()) ?? {}
        onlyFields(b, ["text"])
        const by = actor(caller)
        return json(
          {
            run: jobs.start(
              params.name,
              by === "owner" ? "owner" : "agent",
              by,
              b.text,
            ),
          },
          201,
        )
      },
    },
    {
      method: "GET",
      path: "/v1/runs",
      access: ["admin"],
      summary: "runs, newest first (?job=)",
      handler: ({ url }) => ({ runs: jobs.runs(url.searchParams.get("job")) }),
    },
    {
      method: "DELETE",
      path: "/v1/runs/:id/session",
      access: ["admin"],
      summary: "delete a failed run's kept session",
      handler: ({ params }) => jobs.deleteSession(String(params.id)),
    },
    {
      method: "POST",
      path: "/v1/me/finish",
      access: ["session"],
      summary: "a run ends with its result {result}",
      handler: async ({ caller, body }) =>
        jobs.finish(me(caller), await body()),
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
      summary:
        "history, newest first (agent, match: an agent pattern, kind or a " +
        "prefix like wake.*, since, until, before: an entry ID, limit)",
      handler: ({ url }) => {
        const q = url.searchParams
        return {
          history: history.list({
            agent: q.get("agent") ?? undefined,
            match: q.get("match") ?? undefined,
            kind: q.get("kind") ?? undefined,
            since: q.get("since") ?? undefined,
            until: q.get("until") ?? undefined,
            before: q.get("before") ?? undefined,
            limit: q.get("limit") ?? undefined,
          }),
        }
      },
    },
    {
      method: "GET",
      path: "/v1/history/kinds",
      access: ["admin", "consumer"],
      summary: "the kinds of history entries there are, with counts",
      handler: () => ({ kinds: history.kinds() }),
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
      handler: ({ url }) => {
        const all = url.searchParams.get("all") === "1"
        // messages, alerts and asks in one list, oldest first
        const items: any[] = [
          ...inbox.list(all),
          ...(all ? asks.all() : asks.open()),
        ]
        return {
          items: items.sort((x, y) =>
            x.created_at < y.created_at
              ? -1
              : x.created_at > y.created_at
                ? 1
                : 0,
          ),
        }
      },
    },
    // questions, permissions and approvals (tier 0d)
    {
      method: "POST",
      path: "/v1/asks/:id/answer",
      access: ["admin", "session"],
      summary:
        "answer a question {text | answers}, a permission {decision: " +
        "once|always|reject, text} or an approval {decision: " +
        "approve|reject, option, text}; the owner, or the agent it was " +
        "sent to (once or reject only); the first answer wins",
      handler: async ({ caller, params, body }) => ({
        ask: asks.answer(String(params.id), actor(caller), await body()),
      }),
    },
    {
      method: "POST",
      path: "/v1/asks/:id/close",
      access: ["admin"],
      summary:
        "close an open ask the owner will not answer (one OpenCode lost); " +
        "its agent stops waiting",
      handler: ({ params }) => ({ ask: asks.closeByOwner(String(params.id)) }),
    },
    {
      method: "POST",
      path: "/v1/asks/:id/escalate",
      access: ["session"],
      summary:
        "the agent an ask was sent to cannot answer it {text: why}: a note " +
        "on the owner's item",
      handler: async ({ caller, params, body }) => ({
        ask: asks.escalate(String(params.id), me(caller), await body()),
      }),
    },
    {
      method: "POST",
      path: "/v1/me/approvals",
      access: ["session"],
      summary:
        "ask for an approval {text, options, expires}; routed by " +
        "approval_mode",
      handler: async ({ caller, body }) =>
        json(
          {
            approval: asks.approval(me(caller), caller!.session!, await body()),
          },
          201,
        ),
    },
    {
      method: "GET",
      path: "/v1/me/approvals/:id",
      access: ["session"],
      summary:
        "an approval of the caller (?wait=seconds waits until it closes, " +
        "up to max_tool_wait)",
      handler: async ({ caller, params, url, req }) => {
        const agent = me(caller)
        const id = String(params.id)
        const wait = Number(url.searchParams.get("wait") ?? 0)
        if (!Number.isFinite(wait) || wait < 0)
          throw new AutocodeError("bad_request", "wait must be seconds")
        if (!wait) return { approval: asks.ownApproval(agent, id) }
        const values = resolveSettings(settings.layers(), agent).values
        const most = parseDuration(String(values.max_tool_wait)) / 1000
        const seconds = Math.min(wait, most, 240)
        return {
          approval: await asks.waitApproval(
            agent,
            id,
            seconds * 1000,
            req.signal,
          ),
        }
      },
    },
    {
      method: "POST",
      path: "/v1/inbox/:id/answer",
      access: ["admin"],
      summary:
        "answer a message to the owner (the reply goes to the agent), or an " +
        "ask the inbox lists (as POST /v1/asks/{id}/answer)",
      handler: async ({ params, body }) => {
        const id = String(params.id)
        return {
          item: id.startsWith("ask_")
            ? asks.answer(id, "owner", await body())
            : inbox.answer(id, await body()),
        }
      },
    },
    {
      method: "POST",
      path: "/v1/inbox/:id/close",
      access: ["admin"],
      summary: "close an inbox item (an ask too: POST /v1/asks/{id}/close)",
      handler: ({ params }) => {
        const id = String(params.id)
        return {
          item: id.startsWith("ask_") ? asks.closeByOwner(id) : inbox.close(id),
        }
      },
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
    // locks and semaphores (tier 0c)
    {
      method: "GET",
      path: "/v1/locks",
      access: ["admin", "session"],
      summary: "every lock (?match= a pattern): capacity, holders, queue",
      handler: ({ url }) => ({
        locks: locks.list(url.searchParams.get("match")),
      }),
    },
    {
      method: "POST",
      path: "/v1/locks/:name/acquire",
      access: ["admin", "session"],
      summary:
        "acquire a lock {ttl, max, mode: try|queue}; the first acquire " +
        "creates it with max (default 1)",
      handler: async ({ caller, params, body }) => {
        const b = (await body()) ?? {}
        onlyFields(b, ["agent", "ttl", "max", "mode"])
        return locks.acquire(lockAgent(caller, b), String(params.name), {
          ttl: b.ttl,
          max: b.max ?? undefined,
          mode: b.mode ?? "queue",
        })
      },
    },
    {
      method: "POST",
      path: "/v1/locks/:name/renew",
      access: ["admin", "session"],
      summary: "renew a hold {ttl: default the one it was taken with}",
      handler: async ({ caller, params, body }) => {
        const b = (await body()) ?? {}
        return locks.renew(lockAgent(caller, b), String(params.name), b.ttl)
      },
    },
    {
      method: "POST",
      path: "/v1/locks/:name/release",
      access: ["admin", "session"],
      summary:
        "release a hold or leave the queue (the owner: {agent}; the agent is " +
        "told)",
      handler: async ({ caller, params, body }) => {
        const b = (await body()) ?? {}
        return locks.release(
          lockAgent(caller, b),
          String(params.name),
          caller?.kind === "admin" ? "owner" : "self",
        )
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
      if (caller?.kind === "session" && caller.session) {
        agents.touch(caller.session)
        touchToken(db, req.headers.get("authorization"), now())
      }
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
    asks.trim(days)
    costs.trim(days)
    jobs.trim(days)
    // agents past expire_after since their last turn (tier 0e)
    for (const agent of costs.expired())
      try {
        agents.unregister(agent, "expired")
        history.record("agent.expired", { agent })
      } catch {}
  }
  maintenance()
  const timer =
    options.maintenanceEvery === 0
      ? undefined
      : setInterval(maintenance, options.maintenanceEvery ?? 5000)
  const tick = () => {
    try {
      locks.tick()
      asks.tick()
      asks.checkAnswers(answerAck, answerAlert)
      costs.tick()
      jobs.tick()
    } catch (err) {
      log(`locks, asks and caps: ${(err as Error).message}`)
    }
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
    tick: () => {
      locks.tick()
      asks.tick()
      asks.checkAnswers(answerAck, answerAlert)
      costs.tick()
      jobs.tick()
      delivery.tick()
    },
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
      asks.close()
      await Promise.all(servers.map((s) => s.stop(true)))
      db.close()
    },
  }
}
