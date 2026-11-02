/*
 * The ID rules: checks that an ID is valid, and lists the reserved IDs that no
 * agent may register.
 */

import { AutocodeError } from "./errors.ts"

/*
 * IDs of agents, locks, wakes and jobs: 1 to 255 characters from letters,
 * digits, -, _, . and :, not only dots (URLs drop "." and ".." from paths, so
 * such an ID could never be addressed); case-sensitive.
 */
const ID = /^[A-Za-z0-9._:-]{1,255}$/
const DOTS = /^\.+$/

export const RESERVED_IDS = ["owner", "autocode"] as const

export function isValidId(id: string): boolean {
  return typeof id === "string" && ID.test(id) && !DOTS.test(id)
}

export function checkId(id: unknown, what = "ID"): string {
  if (typeof id !== "string" || !isValidId(id))
    throw new AutocodeError(
      "bad_id",
      `${what} must be 1 to 255 characters ` +
        "from letters, digits, -, _, . and :, and not only dots " +
        `(got ${JSON.stringify(id)})`,
    )
  return id
}

export function isReservedId(id: string): boolean {
  return (RESERVED_IDS as readonly string[]).includes(id)
}
