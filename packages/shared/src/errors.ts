/*
 * One error shape for the API, the plugin and the CLI: a stable code, an HTTP
 * status and a plain message.
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
