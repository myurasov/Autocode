/*
 * Costs and context for the server (tier 0e): each model step of a session
 * (OpenCode's session.step.ended event, published) becomes a cost event with
 * its cost, its context (input plus cache reads and writes: what the next
 * step re-reads) and the model with its window and its name (OpenCode's
 * model list: "Fable 5.2" for the ID fable; "" when the list has none, left
 * out when the list could not be read) and its effort (the session's model
 * variant: high, max...; "" when it has none; left out when the model is
 * OpenCode's default one).
 */

export function costEvent(
  session: string,
  data: any,
  model: { model?: string; limit?: number; effort?: string; name?: string },
  // the session the step ran in, when it is a Subagent's (1.1.0-rc2: its
  // steps count for the wake whose turn started it)
  own?: string,
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
    ...(own && own !== session ? { sub: own } : {}),
    // the step's message, so a step sent twice counts once
    ...(typeof data?.assistantMessageID === "string"
      ? { step: data.assistantMessageID }
      : {}),
    usd,
    context,
    ...(model.model ? { model: model.model } : {}),
    // its name as people know it (the owner, 2026-11-17), with the model
    ...(model.model && typeof model.name === "string"
      ? { model_name: model.name }
      : {}),
    ...(model.limit ? { limit: model.limit } : {}),
    ...(typeof model.effort === "string" ? { effort: model.effort } : {}),
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

// A model's name from OpenCode's list ("Fable 5.2" for the ID fable): "" when
// its entry has none; undefined when the model is not in the list.
export function nameOf(
  models: any[],
  ref: { providerID?: string; id?: string } | undefined,
): string | undefined {
  if (!ref?.id) return undefined
  const m = models.find(
    (x) =>
      x?.id === ref.id && (!ref.providerID || x?.providerID === ref.providerID),
  )
  if (!m) return undefined
  return typeof m.name === "string" ? m.name.trim() : ""
}
