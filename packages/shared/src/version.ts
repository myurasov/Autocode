/*
 * Autocode's version: the release plus the build. A build made by ci/dist.sh
 * has a number, which build.ts compiles in as AUTOCODE_BUILD, and is
 * "<release>-build<n>"; any other build (tests, CI) is "<release>-dev". People
 * see versions with a "v" before them; API data carries them without it.
 */

export const RELEASE = "0.1.0"

declare const AUTOCODE_BUILD: string | undefined

export function versionOf(release: string, build?: string): string {
  return build ? `${release}-build${build}` : `${release}-dev`
}

export const VERSION = versionOf(
  RELEASE,
  typeof AUTOCODE_BUILD === "string" ? AUTOCODE_BUILD : undefined,
)

// A version as people see it, "v2.2.0"; one that does not start with a digit
// (nothing, or a name such as "local") stays as it is.
export function shownVersion(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version
}
