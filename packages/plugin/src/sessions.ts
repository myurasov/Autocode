/*
 * Session tokens: one per top-level session. A Subagent acts for its top-level
 * session, found by walking parentID. Each token is kept in OpenCode's plugin
 * storage too, so a reload of the plugin (an update, a deploy) uses it again
 * instead of asking the server for another (the owner, 2026-11-05).
 */

// Where tokens are kept across reloads (OpenCode's ctx.storage).
export interface TokenStore {
  get(session: string): Promise<string | undefined>
  set(session: string, token: string): Promise<void>
  remove(session: string): Promise<void>
}

export interface SessionTokenDeps {
  parentOf: (session: string) => Promise<string | undefined>
  requestToken: (session: string) => Promise<string>
  store?: TokenStore
}

export class SessionTokens {
  private readonly tokens = new Map<string, string>()
  private readonly inflight = new Map<string, Promise<string>>()
  private readonly roots = new Map<string, string>()

  constructor(private readonly deps: SessionTokenDeps) {}

  async root(session: string): Promise<string> {
    const cached = this.roots.get(session)
    if (cached) return cached
    let current = session
    for (let depth = 0; depth < 20; depth++) {
      const parent = await this.deps.parentOf(current)
      if (!parent) break
      current = parent
    }
    this.roots.set(session, current)
    return current
  }

  async token(root: string): Promise<string> {
    const have = this.tokens.get(root)
    if (have) return have
    let pending = this.inflight.get(root)
    if (!pending) {
      pending = this.fetch(root).finally(() => this.inflight.delete(root))
      this.inflight.set(root, pending)
    }
    const token = await pending
    this.tokens.set(root, token)
    return token
  }

  // The stored token, or a new one from the server (then stored).
  private async fetch(root: string): Promise<string> {
    const store = this.deps.store
    const kept = await store?.get(root).catch(() => undefined)
    if (kept) return kept
    const token = await this.deps.requestToken(root)
    await store?.set(root, token).catch(() => {})
    return token
  }

  set(root: string, token: string) {
    this.tokens.set(root, token)
    void this.deps.store?.set(root, token).catch(() => {})
  }

  // A token the server refused (or rotated): forgotten here and in storage.
  async drop(root: string) {
    this.tokens.delete(root)
    await this.deps.store?.remove(root).catch(() => {})
  }
}
