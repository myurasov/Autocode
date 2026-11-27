/*
 * Autocode's version: the release plus the build. A build made by ci/dist.sh
 * has a number, which build.ts compiles in as AUTOCODE_BUILD, and is
 * "<release>-build<n>"; any other build (tests, CI) is "<release>-dev". People
 * see versions with a "v" before them; API data carries them without it.
 */

// The first release candidate (the owner, 2026-11-09). Build numbers keep
// counting across releases: the counter is never reset.
export const RELEASE = "1.1.1"

declare const AUTOCODE_BUILD: string | undefined

export function versionOf(release: string, build?: string): string {
  return build ? `${release}-build${build}` : `${release}-dev`
}

export const VERSION = versionOf(
  RELEASE,
  typeof AUTOCODE_BUILD === "string" ? AUTOCODE_BUILD : undefined,
)

// A version as people see it, "v2.3.0"; one that does not start with a digit
// (nothing, or a name such as "local") stays as it is.
export function shownVersion(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version
}

// The oldest OpenCode Autocode works with (the owner, 2026-11-17: "make
// opencode 2.3 base minumum supported versiobn").
export const MIN_OPENCODE = "2.3.0"

/*
 * Whether an OpenCode version is older than the minimum: only a plain release
 * number (2.2.0, v2.2.0) is judged; nothing, a name, or a development or
 * pre-release build is not.
 */
export function opencodeTooOld(
  version: string,
  minimum = MIN_OPENCODE,
): boolean {
  const parts = (v: string) =>
    /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number)
  const a = parts(version)
  const b = parts(minimum)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!
  return false
}

// What a machine with an older OpenCode is told.
export function opencodeTooOldText(version: string): string {
  return (
    `this OpenCode is ${shownVersion(version.trim().replace(/^v/, ""))}; ` +
    `Autocode needs ${shownVersion(MIN_OPENCODE)} or later. ` +
    "Update OpenCode on this machine, then start it again."
  )
}
