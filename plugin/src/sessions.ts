/*
 * Session tokens: one per top-level session. A Subagent acts for its top-level
 * session, found by walking parentID. Each token is kept in OpenCode's plugin
 * storage too, so a reload of the plugin (an update, a deploy) uses it again
 * instead of asking the server for another (the owner, 2026-11-05). A kept
 * token carries a mark of the consumer token it was got with: a replaced
 * consumer token ends every session token (autocode token rotate
 * --consumer), so one kept from before is not used again, and the ones held
 * are forgotten.
 */
import { createHash } from "node:crypto"

// A consumer token's mark: which one a kept session token belongs to, and
// nothing of the token itself.
export function consumerMark(consumer: string): string {
  return createHash("sha256").update(consumer).digest("hex").slice(0, 12)
}

// What is kept for a session: the mark, then its token.
export function tokenToKeep(token: string, consumer: string): string {
  return `${consumerMark(consumer)} ${token}`
}

// The token of a kept value, if it was got with this consumer token.
export function keptToken(
  value: unknown,
  consumer: string,
): string | undefined {
  if (typeof value !== "string") return undefined
  const [mark, token] = value.split(" ")
  return token && mark === consumerMark(consumer) ? token : undefined
}

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

  // The consumer token was replaced: every token held is dead. Forgotten
  // here and in storage; the sessions that had one.
  async forgetAll(): Promise<string[]> {
    const roots = [...this.tokens.keys()]
    this.tokens.clear()
    for (const root of roots)
      await this.deps.store?.remove(root).catch(() => {})
    return roots
  }
}
