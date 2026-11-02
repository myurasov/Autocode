/*
 * The API's HTTP layer: a router that checks each route's token kinds, JSON
 * request bodies and replies, errors as JSON, and an OpenAPI description built
 * from the route table.
 */

import { AutocodeError } from "@autocode/shared"
import type { Caller, TokenKind } from "./tokens.ts"

export type Access = "public" | TokenKind[]

export interface RouteContext {
  req: Request
  url: URL
  params: Record<string, string>
  caller?: Caller
  body: () => Promise<any>
}

export interface Route {
  method: string
  path: string
  access: Access
  summary: string
  handler: (ctx: RouteContext) => Promise<unknown> | unknown
}

const MAX_BODY = 2 * 1024 * 1024

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

export function errorResponse(
  err: unknown,
  log: (line: string) => void,
): Response {
  if (err instanceof AutocodeError)
    return json(
      { error: { code: err.code, message: err.message, ...err.details } },
      err.status,
    )
  log(`error: ${(err as Error)?.stack ?? err}`)
  return json({ error: { code: "internal", message: "internal error" } }, 500)
}

function match(
  pattern: string,
  path: string,
): Record<string, string> | undefined {
  const want = pattern.split("/").filter(Boolean)
  const got = path.split("/").filter(Boolean)
  if (want.length !== got.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    const w = want[i] ?? ""
    const g = got[i] ?? ""
    if (w.startsWith(":")) {
      try {
        params[w.slice(1)] = decodeURIComponent(g)
      } catch {
        return undefined
      }
    } else if (w !== g) return undefined
  }
  return params
}

export async function readBody(req: Request): Promise<any> {
  const length = Number(req.headers.get("content-length") ?? 0)
  if (length > MAX_BODY)
    throw new AutocodeError("too_large", "the request body is too large", 413)
  const text = await req.text()
  if (text.length > MAX_BODY)
    throw new AutocodeError("too_large", "the request body is too large", 413)
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new AutocodeError("bad_json", "the request body is not valid JSON")
  }
}

export function router(
  routes: Route[],
  authenticate: (req: Request) => Caller | undefined,
  log: (line: string) => void,
) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    try {
      let methodMismatch = false
      for (const route of routes) {
        const params = match(route.path, url.pathname)
        if (!params) continue
        if (route.method !== req.method) {
          methodMismatch = true
          continue
        }
        let caller: Caller | undefined
        if (route.access !== "public") {
          caller = authenticate(req)
          if (!caller)
            throw new AutocodeError(
              "unauthorized",
              "a valid token is required",
              401,
            )
          if (!route.access.includes(caller.kind))
            throw new AutocodeError(
              "forbidden",
              `this route is not open to a ${caller.kind} token`,
              403,
            )
        }
        const result = await route.handler({
          req,
          url,
          params,
          caller,
          body: () => readBody(req),
        })
        return result instanceof Response ? result : json(result)
      }
      if (methodMismatch)
        throw new AutocodeError(
          "method_not_allowed",
          `${req.method} is not allowed here`,
          405,
        )
      throw new AutocodeError(
        "not_found",
        `no route ${req.method} ${url.pathname}`,
        404,
      )
    } catch (err) {
      return errorResponse(err, log)
    }
  }
}

// A small OpenAPI description generated from the route table.
export function openapi(routes: Route[], version: string) {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const r of routes) {
    const path = r.path.replace(/:([a-z]+)/g, "{$1}")
    paths[path] ??= {}
    paths[path][r.method.toLowerCase()] = {
      summary: r.summary,
      security: r.access === "public" ? [] : [{ bearer: [] }],
      "x-tokens": r.access,
    }
  }
  return {
    openapi: "3.1.0",
    info: { title: "Autocode", version },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
    paths,
  }
}
