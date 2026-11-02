/*
 * Session tokens: one per top-level session. A Subagent acts for its top-level
 * session, found by walking parentID.
 */

export interface SessionTokenDeps {
  parentOf: (session: string) => Promise<string | undefined>
  requestToken: (session: string) => Promise<string>
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
      pending = this.deps
        .requestToken(root)
        .finally(() => this.inflight.delete(root))
      this.inflight.set(root, pending)
    }
    const token = await pending
    this.tokens.set(root, token)
    return token
  }

  set(root: string, token: string) {
    this.tokens.set(root, token)
  }

  drop(root: string) {
    this.tokens.delete(root)
  }
}
