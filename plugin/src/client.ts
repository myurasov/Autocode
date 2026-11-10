/*
 * HTTP calls to the Autocode server, each with a timeout.
 */

export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function request(
  url: string,
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<any> {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any(signals),
  })
  const text = await res.text()
  let parsed: any
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  if (!res.ok)
    throw new ServerError(
      res.status,
      parsed?.error?.code ?? "http_error",
      parsed?.error?.message ?? `HTTP ${res.status}`,
    )
  return parsed
}
