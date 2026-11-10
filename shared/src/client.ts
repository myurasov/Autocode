/*
 * A small client for the Autocode API, with a timeout on every call.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export class Unreachable extends Error {
  constructor(
    readonly url: string,
    cause: string,
  ) {
    super(`cannot reach the Autocode server at ${url}: ${cause}`)
    this.name = "Unreachable"
  }
}

export async function apiCall(
  url: string,
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 15_000,
): Promise<any> {
  let res: Response
  try {
    res = await fetch(`${url.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new Unreachable(url, (err as Error).message)
  }
  const text = await res.text()
  let parsed: any
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  if (!res.ok)
    throw new ApiError(
      res.status,
      parsed?.error?.code ?? "http_error",
      parsed?.error?.message ?? `HTTP ${res.status}`,
    )
  return parsed
}
