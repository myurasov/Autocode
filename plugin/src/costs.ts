/*
 * Costs and context for the server (tier 0e): each model step of a session
 * (OpenCode's session.step.ended event, published) becomes a cost event with
 * its cost, its context (input plus cache reads and writes: what the next
 * step re-reads) and the model with its window (OpenCode's model list).
 */

export function costEvent(
  session: string,
  data: any,
  model: { model?: string; limit?: number },
) {
  const usd = Number(data?.cost)
  if (typeof data?.cost !== "number" || !Number.isFinite(usd) || usd < 0)
    return undefined
  const t = data?.tokens ?? {}
  const context =
    (Number(t.input) || 0) +
    (Number(t.cache?.read) || 0) +
    (Number(t.cache?.write) || 0)
  return {
    type: "cost",
    session,
    // the step's message, so a step sent twice counts once
    ...(typeof data?.assistantMessageID === "string"
      ? { step: data.assistantMessageID }
      : {}),
    usd,
    context,
    ...(model.model ? { model: model.model } : {}),
    ...(model.limit ? { limit: model.limit } : {}),
  }
}

// A model's context window from OpenCode's list (ctx.model.list).
export function windowOf(
  models: any[],
  ref: { providerID?: string; id?: string } | undefined,
): number | undefined {
  if (!ref?.id) return undefined
  const m = models.find(
    (x) =>
      x?.id === ref.id && (!ref.providerID || x?.providerID === ref.providerID),
  )
  const n = Number(m?.limit?.context)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
