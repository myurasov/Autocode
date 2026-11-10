/*
 * Autocode's version (spec, Stack: Versions): the release plus the build,
 * "<release>-build<n>" for a numbered build and "<release>-dev" for any other
 * (tests, CI); shown to people with a "v". A numbered build's plugin bundle and
 * binary carry its number; ci/build-number.sh hands out each number once.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { RELEASE, shownVersion, VERSION, versionOf } from "@autocode/shared"
import { compileCli, generate } from "../../packages/cli/build.ts"
import { buildPlugin } from "../../packages/plugin/build.ts"

const root = resolve(import.meta.dir, "../..")
const dirs: string[] = []
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "autocode-version-"))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

describe("the version", () => {
  test("is the release plus the build number, or -dev", () => {
    // the second release candidate (the owner, 2026-11-09: rc2, the build
    // counter keeps counting)
    expect(RELEASE).toBe("1.0.0-rc2")
    expect(versionOf(RELEASE, "61")).toBe("1.0.0-rc2-build61")
    expect(versionOf("0.1.0", "7")).toBe("0.1.0-build7")
    expect(versionOf("0.1.0", "")).toBe("0.1.0-dev")
    expect(versionOf("0.1.0")).toBe("0.1.0-dev")
  })

  test("of an unnumbered build (these tests) is -dev", () => {
    expect(VERSION).toBe(`${RELEASE}-dev`)
  })

  test("is shown with a v; a name or nothing stays as it is", () => {
    expect(shownVersion("0.1.0-build7")).toBe("v0.1.0-build7")
    expect(shownVersion("2.2.0")).toBe("v2.2.0")
    expect(shownVersion("v2.2.0")).toBe("v2.2.0")
    expect(shownVersion("local")).toBe("local")
    expect(shownVersion("")).toBe("")
  })
})

describe("a numbered build", () => {
  // The bundle makes its version as it loads: a numbered build has the number
  // in place of the AUTOCODE_BUILD name, which an unnumbered one keeps (and
  // finds undefined).
  test("bundles the plugin with its number", async () => {
    const bundle = async (build?: string) => {
      const out = await buildPlugin(root, { build, outdir: await scratch() })
      return (await readFile(out, "utf8")).match(/var VERSION = .*/)?.[0]
    }
    expect(await bundle("42")).toBe('var VERSION = versionOf(RELEASE, "42");')
    expect(await bundle()).toContain("AUTOCODE_BUILD")
  })

  test("compiles a binary that says its number", async () => {
    const plugin = resolve(root, "packages/cli/src/generated/plugin.ts")
    if (!existsSync(plugin)) await generate()
    const bin = join(await scratch(), "autocode")
    await compileCli(bin, { build: "43" })
    const run = Bun.spawnSync([bin, "--version"], { timeout: 20_000 })
    expect(run.stdout.toString().trim()).toBe(`v${RELEASE}-build43`)
  }, 120_000)
})

describe("ci/build-number.sh", () => {
  const next = (file: string) =>
    Bun.spawn(["bash", resolve(root, "ci/build-number.sh"), file], {
      stdout: "pipe",
      stderr: "pipe",
    })
  const text = async (proc: ReturnType<typeof next>) => {
    expect(await proc.exited).toBe(0)
    return (await new Response(proc.stdout).text()).trim()
  }

  test("counts up from 1, from the number in the file", async () => {
    const file = join(await scratch(), "build-number")
    expect(await text(next(file))).toBe("1")
    expect(await text(next(file))).toBe("2")
    await writeFile(file, "41\n")
    expect(await text(next(file))).toBe("42")
    expect((await readFile(file, "utf8")).trim()).toBe("42")
  })

  test("never hands out a number twice, even to builds at the same time", async () => {
    const file = join(await scratch(), "build-number")
    const numbers = await Promise.all(
      Array.from({ length: 8 }, () => text(next(file))),
    )
    expect(numbers.map(Number).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ])
  })

  test("refuses a counter that is not a number", async () => {
    const file = join(await scratch(), "build-number")
    await writeFile(file, "seven\n")
    const proc = next(file)
    expect(await proc.exited).not.toBe(0)
    expect((await readFile(file, "utf8")).trim()).toBe("seven")
  })
})
