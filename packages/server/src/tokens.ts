/*
 * The API's tokens: admin, consumer and session tokens, kept as SHA-256 hashes.
 * Checks a request's bearer token, creates the owner's tokens at the first
 * start, and issues and revokes session tokens; a session token unused for
 * 30 days is revoked (the owner, 2026-11-05).
 */

import type { Database } from "bun:sqlite"
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AutocodeError } from "@autocode/shared"

export type TokenKind = "admin" | "consumer" | "session"

const PREFIX: Record<TokenKind, string> = {
  admin: "aca_",
  consumer: "acc_",
  session: "acs_",
}

export function newToken(kind: TokenKind): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return PREFIX[kind] + Buffer.from(bytes).toString("base64url")
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex")
}

export interface Caller {
  kind: TokenKind
  session?: string
}

export function authenticate(
  db: Database,
  header: string | null,
): Caller | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "")
  if (!m?.[1]) return undefined
  const row = db
    .query(
      "SELECT kind, session_id FROM tokens " +
        "WHERE hash = ? AND revoked_at IS NULL",
    )
    .get(hashToken(m[1])) as {
    kind: TokenKind
    session_id: string | null
  } | null
  if (!row) return undefined
  return { kind: row.kind, session: row.session_id ?? undefined }
}

function checkPreset(kind: "admin" | "consumer", value: string): string {
  if (!new RegExp(`^${PREFIX[kind]}[A-Za-z0-9_-]{32,}$`).test(value))
    throw new AutocodeError(
      "bad_token",
      `a preset ${kind} token must start with ${PREFIX[kind]} ` +
        "and have at least 32 more characters",
      500,
    )
  return value
}

// Saves a token file 0600 in one step (a temporary file, then a rename), so it
// is either whole or not there.
function saveTokenFile(path: string, value: string) {
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${value}\n`, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, path)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

/*
 * Creates the admin and consumer tokens at the first start (or takes presets),
 * saves them 0600 in the data folder, and returns them so they can be shown
 * once. Only a missing kind is made, and its file is saved before its hash is
 * stored: a start that cannot save the file stores nothing, so the next start
 * tries again. Later starts return undefined.
 */
export function ensureOwnerTokens(
  db: Database,
  dataDir: string,
  presets: { admin?: string; consumer?: string } | undefined,
  now: number,
): { admin?: string; consumer?: string } | undefined {
  const have = db
    .query(
      "SELECT kind FROM tokens " +
        "WHERE kind IN ('admin', 'consumer') AND revoked_at IS NULL",
    )
    .all() as {
    kind: string
  }[]
  const kinds = new Set(have.map((r) => r.kind))
  const made: { admin?: string; consumer?: string } = {}
  for (const kind of ["admin", "consumer"] as const) {
    if (kinds.has(kind)) continue
    made[kind] = presets?.[kind]
      ? checkPreset(kind, presets[kind])
      : newToken(kind)
  }
  if (!made.admin && !made.consumer) return undefined
  for (const kind of ["admin", "consumer"] as const) {
    const value = made[kind]
    if (value) saveTokenFile(join(dataDir, `${kind}.token`), value)
  }
  const insert = db.prepare(
    "INSERT OR REPLACE INTO tokens (hash, kind, created_at) VALUES (?, ?, ?)",
  )
  db.transaction(() => {
    for (const kind of ["admin", "consumer"] as const) {
      const value = made[kind]
      if (value) insert.run(hashToken(value), kind, now)
    }
  })()
  return made
}

// A revoked token is deleted a day after it was revoked.
export const SESSION_TOKEN_IDLE_MS = 30 * 86_400_000

// Notes that a session token was used (at most once a minute is written).
export function touchToken(db: Database, header: string | null, now: number) {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "")
  if (!m?.[1]) return
  db.query(
    "UPDATE tokens SET used_at = ? WHERE hash = ? AND kind = 'session' " +
      "AND (used_at IS NULL OR used_at < ?)",
  ).run(now, hashToken(m[1]), now - 60_000)
}

/*
 * Revokes session tokens unused for 30 days, and deletes revoked tokens a day
 * after.
 */
export function pruneTokens(db: Database, now: number) {
  db.query(
    "UPDATE tokens SET revoked_at = ? WHERE kind = 'session' " +
      "AND revoked_at IS NULL AND COALESCE(used_at, created_at) < ?",
  ).run(now, now - SESSION_TOKEN_IDLE_MS)
  db.query(
    "DELETE FROM tokens WHERE revoked_at IS NOT NULL AND revoked_at < ?",
  ).run(now - 24 * 3600_000)
}

export function issueSessionToken(
  db: Database,
  session: string,
  now: number,
): string {
  const token = newToken("session")
  db.query(
    "INSERT INTO tokens (hash, kind, session_id, created_at, used_at) " +
      "VALUES (?, 'session', ?, ?, ?)",
  ).run(hashToken(token), session, now, now)
  return token
}

export function revokeSessionTokens(
  db: Database,
  session: string,
  now: number,
) {
  db.query(
    "UPDATE tokens SET revoked_at = ? " +
      "WHERE kind = 'session' AND session_id = ? AND revoked_at IS NULL",
  ).run(now, session)
}
