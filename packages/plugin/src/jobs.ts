/*
 * Runs of jobs in this folder (tier 0f): the server's spawn instruction
 * becomes a fresh session (ctx.session.create: this folder, the job's model
 * and variant, its OpenCode agent), remove deletes one (ctx.session.remove),
 * and a run's result, when it ends without finish, is its last reply: the
 * newest assistant message with text (a turn may end on a tool call).
 */

// What ctx.session.create is given for a spawn.
export function spawnInput(directory: string, p: any) {
  const model = String(p?.model ?? "")
  const at = model.indexOf("/")
  return {
    title: String(p?.title ?? p?.run ?? "run"),
    location: { directory },
    ...(at > 0
      ? {
          model: {
            providerID: model.slice(0, at),
            id: model.slice(at + 1),
            ...(p?.variant ? { variant: String(p.variant) } : {}),
          },
        }
      : {}),
    ...(p?.agent ? { agent: String(p.agent) } : {}),
  }
}

const textOf = (m: any) =>
  (Array.isArray(m?.content) ? m.content : [])
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n")
    .trim()

// The text of a session's newest assistant message that has text.
export function lastReply(messages: any[]): string | null {
  const replies = (Array.isArray(messages) ? messages : [])
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m?.type === "assistant")
    // newest first: by time, else by place in the list
    .sort(
      (a, b) =>
        Number(b.m?.time?.created ?? 0) - Number(a.m?.time?.created ?? 0) ||
        b.i - a.i,
    )
  for (const { m } of replies) {
    const text = textOf(m)
    if (text) return text
  }
  return null
}
