/*
 * One error shape for the API, the plugin and the CLI: a stable code, an HTTP
 * status and a plain message. Also the check that a request body has only the
 * fields a route knows.
 */
export class AutocodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AutocodeError"
  }
}

// Refuses a body field the route does not know (a removed one included).
export function onlyFields(body: object, fields: readonly string[]) {
  for (const key of Object.keys(body))
    if (!fields.includes(key))
      throw new AutocodeError("bad_request", `unknown field ${key}`)
}
