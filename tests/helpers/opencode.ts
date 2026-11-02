/*
 * Drives OpenCode sessions through OpenCode's own API, as a person in the TUI
 * would.
 */
import { opencodePassword, opencodeUrl } from "./env.ts"
import { fetchJson, until } from "./wait.ts"

export class OpenCode {
  readonly url: string
  private readonly auth: string

  // `url` for a second OpenCode server on the same machine.
  constructor(
    readonly node: string,
    url?: string,
  ) {
    this.url = url ?? opencodeUrl(node)
    this.auth = `Basic ${btoa(`opencode:${opencodePassword}`)}`
  }

  async api(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<any> {
    const res = await fetchJson(`${this.url}${path}`, {
      method,
      headers: {
        authorization: this.auth,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    })
    return res && typeof res === "object" && "data" in res ? res.data : res
  }

  info() {
    return this.api("GET", "/api/info")
  }

  // OpenCode loads a workspace folder's plugins lazily: creating a session does
  // not, a location request does.
  loadLocation(directory?: string) {
    return this.api(
      "GET",
      directory
        ? `/api/location?directory=${encodeURIComponent(directory)}`
        : "/api/location",
    )
  }

  createSession(
    input: Record<string, unknown> = {},
  ): Promise<{ id: string; parentID?: string; [k: string]: any }> {
    return this.api("POST", "/api/session", input)
  }

  getSession(id: string) {
    return this.api("GET", `/api/session/${id}`)
  }

  deleteSession(id: string) {
    return this.api("DELETE", `/api/session/${id}`)
  }

  prompt(id: string, text: string, extra: Record<string, unknown> = {}) {
    return this.api("POST", `/api/session/${id}/prompt`, { text, ...extra })
  }

  messages(id: string) {
    return this.api("GET", `/api/session/${id}/message`)
  }

  // Prompts and waits until the turn has ended (the session is idle again with
  // an outcome).
  async run(id: string, text: string, timeoutMs = 60_000): Promise<any> {
    const before = await this.getSession(id)
    const idleBefore = before?.time?.idle ?? 0
    await this.prompt(id, text)
    return until(
      async () => {
        const s = await this.getSession(id)
        return s?.time?.idle && s.time.idle > idleBefore && s.outcome
          ? s
          : undefined
      },
      { timeoutMs, intervalMs: 200, what: `session ${id} to finish its turn` },
    )
  }
}
