/*
 * A tool's wait inside a turn (autocode_message wait, autocode_approval
 * wait): asked of the server in calls of at most 240 s each, until an answer
 * comes or the time is over. The time is the tool's `seconds`, and never
 * more than the agent's max_tool_wait. The server caps each call at that
 * setting, not their sum, so with 4 minutes or more a wait of 900 s lasted
 * 900 s (the documentation's fact check before 1.0.0); the plugin reads the
 * setting and stops there. When it cannot be read, a call that the server
 * answered early with nothing still ends the wait.
 */

// The longest one call holds (the server's own limit).
export const CALL_SECONDS = 240

export async function waitInCalls<T>(o: {
  seconds: number
  // the agent's max_tool_wait, in seconds
  most: () => Promise<number | undefined>
  // one call that waits at most so many seconds
  ask: (seconds: number) => Promise<T>
  // whether an answer came
  done: (res: T) => boolean
  now?: () => number
}): Promise<T> {
  const now = o.now ?? Date.now
  const start = now()
  const most = await o.most().catch(() => undefined)
  const total =
    typeof most === "number" && most > 0 ? Math.min(o.seconds, most) : o.seconds
  const end = start + total * 1000
  for (;;) {
    const left = Math.ceil((end - now()) / 1000)
    const call = Math.max(1, Math.min(left, CALL_SECONDS))
    const asked = now()
    const res = await o.ask(call)
    if (
      o.done(res) ||
      now() >= end - 1000 ||
      // the server cut the call short itself
      now() - asked < (call - 2) * 1000
    )
      return res
  }
}
