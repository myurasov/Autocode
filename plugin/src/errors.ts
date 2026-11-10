/*
 * A session counts as gone only on OpenCode's own not-found error for it:
 * reporting a live session as deleted would revoke its tokens and free its
 * agent ID. The published error (@opencode/client) is SessionNotFoundError;
 * OpenCode 2.2 raises its internal Session.NotFoundError inside plugins
 * (ctx.session.get) instead, so that one is accepted too, here only, with a
 * test against real OpenCode (reported upstream).
 */
import type { SessionNotFoundError } from "@opencode/client"

const PUBLISHED: SessionNotFoundError["_tag"] = "SessionNotFoundError"
const IN_PLUGINS_2_2 = "Session.NotFoundError"

export function sessionIsGone(err: unknown): boolean {
  const tag = (err as { _tag?: unknown } | undefined)?._tag
  return tag === PUBLISHED || tag === IN_PLUGINS_2_2
}
