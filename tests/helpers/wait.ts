/*
 * Waiting on events with deadlines, never on fixed sleeps.
 */

export async function until<T>(
  check: () =>
    | Promise<T | undefined | null | false>
    | T
    | undefined
    | null
    | false,
  options: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value as T
    } catch (err) {
      lastError = err
    }
    await Bun.sleep(options.intervalMs ?? 100)
  }
  const detail = lastError
    ? `: ${String((lastError as Error)?.message ?? lastError)}`
    : ""
  throw new Error(
    `timed out after ${options.timeoutMs ?? 10_000} ms ` +
      `waiting for ${options.what ?? "a condition"}${detail}`,
  )
}

export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<any> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
  })
  const text = await res.text()
  let body: any = text
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {}
  if (!res.ok)
    throw Object.assign(
      new Error(
        `${init.method ?? "GET"} ${url} ` +
          `-> ${res.status}: ${text.slice(0, 300)}`,
      ),
      {
        status: res.status,
        body,
      },
    )
  return body
}
