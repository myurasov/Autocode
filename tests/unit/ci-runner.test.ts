/*
 * The CI's runners (the adversarial review of 0b2, 2026-11-08): ci/run.sh
 * refuses a CI_PARALLEL that would make its wait loop spin, and the agents
 * suite's run removes its scratch folders (the copy of the provider's key)
 * when a timeout's SIGTERM stops it.
 */
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../..")

test("ci/run.sh refuses CI_PARALLEL 0 or words, at once", () => {
  for (const value of ["0", "x", "-1"]) {
    const res = Bun.spawnSync(["bash", "ci/run.sh", "unit"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", CI_PARALLEL: value },
      timeout: 10_000,
    })
    expect(res.exitCode, value).toBe(2)
    expect(res.stderr.toString(), value).toContain(
      "CI_PARALLEL must be a positive whole number",
    )
  }
})

// Needs the owner's OpenCode config (the provider block) on the host; the
// run's start then stops at the SIGTERM before any model call.
const config = join(process.env.HOME ?? "", ".config/opencode/opencode.jsonc")
test.skipIf(!existsSync(config))(
  "the agents run removes its scratch folders on SIGTERM",
  async () => {
    const out = mkdtempSync(join(tmpdir(), "agents-sig-"))
    const note = join(out, ".scratch")
    try {
      const proc = Bun.spawn(
        ["bun", "ci/agents/run.ts", "--out", out, "--models", "opus-5.5"],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            AGENTS_SCRATCH_NOTE: note,
          },
          stdout: "ignore",
          stderr: "ignore",
        },
      )
      const deadline = Date.now() + 20_000
      while (!existsSync(note) && Date.now() < deadline) await Bun.sleep(100)
      const scratch = readFileSync(note, "utf8")
      expect(existsSync(scratch)).toBe(true)
      proc.kill("SIGTERM")
      expect(await proc.exited).toBe(130)
      expect(existsSync(scratch)).toBe(false)
      expect(existsSync(note)).toBe(false)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  },
  40_000,
)
