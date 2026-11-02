/*
 * Talks to the spike probe plugin inside an OpenCode machine
 * (tests/plugin/probe/probe.ts).
 */
import { probeUrl } from "./env.ts"
import { fetchJson, until } from "./wait.ts"

export interface ProbeRecord {
  seq: number
  at: number
  kind: string
  data: any
}

export const probe = {
  async call(
    path: string,
    ...args: unknown[]
  ): Promise<{ ok: boolean; result?: any; error?: string; name?: string }> {
    return fetchJson(`${probeUrl}/call`, {
      method: "POST",
      body: JSON.stringify({ path, args }),
      timeoutMs: 30_000,
    })
  },

  async records(kind?: string, since = 0): Promise<ProbeRecord[]> {
    const q = new URLSearchParams({ since: String(since) })
    if (kind) q.set("kind", kind)
    return fetchJson(`${probeUrl}/records?${q}`)
  },

  async lastSeq(): Promise<number> {
    const all = await this.records()
    return all.at(-1)?.seq ?? 0
  },

  async waitFor(
    kind: string,
    match: (r: ProbeRecord) => boolean,
    since = 0,
    timeoutMs = 30_000,
  ): Promise<ProbeRecord> {
    return until(async () => (await this.records(kind, since)).find(match), {
      timeoutMs,
      what: `probe record ${kind}`,
    })
  },

  async info(): Promise<any[]> {
    return fetchJson(`${probeUrl}/info`)
  },

  hideTool(sessionID: string, hide: boolean) {
    return fetchJson(`${probeUrl}/hide-tool`, {
      method: "POST",
      body: JSON.stringify({ sessionID, hide }),
    })
  },

  shellEnv(sessionID: string, env: Record<string, string>) {
    return fetchJson(`${probeUrl}/shell-env`, {
      method: "POST",
      body: JSON.stringify({ sessionID, env }),
    })
  },
}

// Events the probe saw on OpenCode's event bus, filtered by type and session.
export async function events(
  type: string,
  sessionID?: string,
  since = 0,
): Promise<any[]> {
  const all = await probe.records("event", since)
  return all
    .map((r) => r.data)
    .filter(
      (d) =>
        d.type === type &&
        (!sessionID || JSON.stringify(d.data).includes(sessionID)),
    )
}
