/*
 * Costs and context for the server (tier 0e): each model step of a session
 * (OpenCode's session.step.ended event, published) becomes a cost event with
 * its cost, its context (input plus cache reads and writes: what the next
 * step re-reads) and the model with its window and its name (OpenCode's
 * model list: "Fable 5.2" for the ID fable; "" when the list has none, left
 * out when the list could not be read) and its effort (the session's model
 * variant: high, max...; "" when it has none; left out when the model is
 * OpenCode's default one). By kind (1.1.0-rc7): the step's tokens (new
 * input, output with reasoning, the cache's reads and writes) and the
 * model's rates, dollars per million tokens of each kind, from which the
 * server divides the step's dollars.
 */

// Tokens, or dollars per million tokens, of the four kinds.
export interface Kinds {
  input: number
  output: number
  read: number
  write: number
}

const count = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0

export function costEvent(
  session: string,
  data: any,
  model: {
    model?: string
    limit?: number
    effort?: string
    name?: string
    rates?: Kinds
  },
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
    // by kind (1.1.0-rc7); reasoning is output
    ...(data?.tokens && typeof data.tokens === "object"
      ? {
          tokens: {
            input: count(t.input),
            output: count(t.output) + count(t.reasoning),
            read: count(t.cache?.read),
            write: count(t.cache?.write),
          },
        }
      : {}),
    ...(model.rates ? { rates: model.rates } : {}),
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

/*
 * A model's rates from OpenCode's list, dollars per million tokens: its
 * cost entry without a tier (a tier is the price past some context size),
 * else its first; undefined when the list has no model, no entry, an entry
 * that is not four numbers, or one with nothing to charge.
 */
export function ratesOf(
  models: any[],
  ref: { providerID?: string; id?: string } | undefined,
): Kinds | undefined {
  if (!ref?.id) return undefined
  const m = models.find(
    (x) =>
      x?.id === ref.id && (!ref.providerID || x?.providerID === ref.providerID),
  )
  const all = Array.isArray(m?.cost) ? m.cost : m?.cost ? [m.cost] : []
  const entry = all.find((c: any) => c && !c.tier) ?? all[0]
  if (!entry) return undefined
  const rates = {
    input: entry.input,
    output: entry.output,
    read: entry.cache?.read,
    write: entry.cache?.write,
  }
  const values = Object.values(rates)
  if (values.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0))
    return undefined
  return values.some((v) => v > 0) ? (rates as Kinds) : undefined
}
