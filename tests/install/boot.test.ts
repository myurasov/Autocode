/*
 * `autocode install` on a machine that boots systemd: user `ac` (uid 1000) has
 * lingering on.
 */
import { describe, expect, test } from "bun:test"
import { docker } from "../helpers/docker.ts"
import { until } from "../helpers/wait.ts"

const host = process.env.INSTALL_CONTAINER ?? ""
const asUser = [
  "exec",
  "-u",
  "ac",
  "-e",
  "XDG_RUNTIME_DIR=/run/user/1000",
  "-e",
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
  "-w",
  "/home/ac",
  host,
]

async function booted() {
  return until(
    async () => {
      const res = await docker(
        ["exec", host, "systemctl", "is-system-running"],
        10_000,
      )
      const state = res.stdout.trim()
      return state === "running" || state === "degraded" ? state : undefined
    },
    { timeoutMs: 90_000, intervalMs: 500, what: "systemd to finish booting" },
  )
}

async function userManager() {
  await until(
    async () =>
      (
        await docker(
          [...asUser, "systemctl", "--user", "is-system-running"],
          10_000,
        )
      ).stdout.trim() !== "",
    {
      timeoutMs: 60_000,
      intervalMs: 500,
      what: "the user's systemd manager",
    },
  )
}

async function answers(): Promise<any> {
  return until(
    async () => {
      const res = await docker(
        [
          "exec",
          host,
          "curl",
          "-fsS",
          "--max-time",
          "2",
          "http://127.0.0.1:4848/v1/info",
        ],
        10_000,
      )
      return res.code === 0 ? JSON.parse(res.stdout) : undefined
    },
    { timeoutMs: 60_000, intervalMs: 500, what: "the service to answer" },
  )
}

describe("autocode install", () => {
  test("the machine boots systemd and has the autocode binary", async () => {
    expect(["running", "degraded"]).toContain(await booted())
    expect(
      (await docker(["exec", host, "autocode", "--version"], 10_000)).code,
    ).toBe(0)
  })

  test("install starts a user service that answers, keeps its tokens 0600, and comes back at boot", async () => {
    await userManager()
    const res = await docker(
      [...asUser, "autocode", "install", "--listen", "127.0.0.1:4848"],
      120_000,
    )
    expect(res.stderr).toBe("")
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("installed: autocode.service")
    expect(res.stdout).toMatch(/server install-host v\d+\.\d+\.\d+-dev answers/)
    expect((await answers()).id).toBe("install-host")
    const active = await docker(
      [...asUser, "systemctl", "--user", "is-active", "autocode.service"],
      10_000,
    )
    expect(active.stdout.trim()).toBe("active")
    const mode = await docker(
      ["exec", host, "stat", "-c", "%a", "/home/ac/.autocode/admin.token"],
      10_000,
    )
    expect(mode.stdout.trim()).toBe("600")

    expect((await docker(["restart", "--time=5", host], 120_000)).code).toBe(0)
    await booted()
    expect((await answers()).id).toBe("install-host")
  })

  test("uninstall stops and removes the service, keeps the binary and data", async () => {
    await userManager()
    const res = await docker([...asUser, "autocode", "uninstall"], 60_000)
    expect(res.code).toBe(0)
    const unit = await docker(
      [
        "exec",
        host,
        "test",
        "-e",
        "/home/ac/.config/systemd/user/autocode.service",
      ],
      10_000,
    )
    expect(unit.code, "the unit file is gone").not.toBe(0)
    const binary = await docker(
      [...asUser, "/home/ac/.autocode/bin/autocode", "--version"],
      10_000,
    )
    expect(binary.code, "the installed binary stays").toBe(0)
    const active = await docker(
      [...asUser, "systemctl", "--user", "is-active", "autocode.service"],
      10_000,
    )
    expect(active.stdout.trim()).not.toBe("active")
    const data = await docker(
      ["exec", host, "test", "-f", "/home/ac/.autocode/admin.token"],
      10_000,
    )
    expect(data.code).toBe(0)
    const down = await docker(
      [
        "exec",
        host,
        "curl",
        "-fsS",
        "--max-time",
        "2",
        "http://127.0.0.1:4848/v1/info",
      ],
      10_000,
    )
    expect(down.code).not.toBe(0)
  })
})
