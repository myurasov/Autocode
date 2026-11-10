/*
 * A machine's name as Autocode uses it: the host name's first part, made safe
 * for IDs. The plugin names its hosts' machines with it, and the server tells
 * its own machine's hosts by it.
 */

import { hostname } from "node:os"

export function slug(text: string, max: number): string {
  return (
    text
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "x"
  )
}

export function machineName(host: string = hostname()): string {
  return slug(host.split(".")[0] ?? "machine", 63)
}
