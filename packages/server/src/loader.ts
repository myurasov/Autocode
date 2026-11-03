/*
 * Unloaded folders (spec, OpenCode Plugin: Unloaded folders): OpenCode's
 * background service unloads a folder it has not used for an hour, and the
 * folder's plugin instance (its host) stops with it. When the server has work
 * for such a host on its own machine, it asks the service to load the folder
 * again (GET /api/location, after /api/info names the service's process), at
 * most once a minute per host, backing off up to 30 minutes while it fails (a
 * failure is recorded once per streak); the work goes out once the host says
 * hello. Hosts on other machines wait until their folder is used again.
 */

import { discover } from "@opencode/client/service"
import type { History } from "./history.ts"

export interface Service {
  url: string
  authorization?: string
}

export type FindService = () => Promise<Service | undefined>

// This machine's background service, through its published discovery.
export const findService: FindService = async () => {
  const service = await discover().catch(() => undefined)
  if (!service) return undefined
  const auth = service.auth
    ? `Basic ${Buffer.from(
        `${service.auth.username ?? "opencode"}:${service.auth.password}`,
      ).toString("base64")}`
    : undefined
  return { url: service.url.replace(/\/+$/, ""), authorization: auth }
}

export interface HostRow {
  id: string
  machine: string
  directory: string
  process_kind: string
}

const MAX_BACKOFF_MS = 30 * 60_000

export class Loader {
  private readonly tried = new Map<string, number>()
  private readonly running = new Set<string>()
  private readonly backoff = new Map<string, number>()

  constructor(
    private readonly history: History,
    private readonly machine: string,
    private readonly find: FindService,
    private readonly now: () => number,
    private readonly everyMs = 60_000,
  ) {}

  load(host: HostRow) {
    if (host.machine !== this.machine || host.process_kind !== "service") return
    if (this.running.has(host.id)) return
    const last = this.tried.get(host.id)
    const wait = this.backoff.get(host.id) ?? this.everyMs
    if (last !== undefined && this.now() - last < wait) return
    this.tried.set(host.id, this.now())
    this.running.add(host.id)
    void this.run(host).finally(() => this.running.delete(host.id))
  }

  private async run(host: HostRow) {
    try {
      const service = await this.find()
      if (!service) throw new Error("no background service on this machine")
      const headers: Record<string, string> = service.authorization
        ? { authorization: service.authorization }
        : {}
      const info = await fetch(`${service.url}/api/info`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      if (!info.ok)
        throw new Error(`the service's info answered ${info.status}`)
      const pid = ((await info.json()) as { pid?: unknown })?.pid ?? null
      // a location as OpenCode's published client sends it
      const query = new URLSearchParams({
        "location[directory]": host.directory,
      })
      const res = await fetch(`${service.url}/api/location?${query}`, {
        headers: service.authorization
          ? { authorization: service.authorization }
          : {},
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`the service answered ${res.status}`)
      this.backoff.delete(host.id)
      this.history.record("host.load", {
        host: host.id,
        data: { directory: host.directory, pid },
      })
    } catch (err) {
      const before = this.backoff.get(host.id)
      this.backoff.set(
        host.id,
        Math.min((before ?? this.everyMs) * 2, MAX_BACKOFF_MS),
      )
      if (before === undefined)
        this.history.record("host.load_failed", {
          host: host.id,
          data: { directory: host.directory, error: (err as Error).message },
        })
    }
  }
}
