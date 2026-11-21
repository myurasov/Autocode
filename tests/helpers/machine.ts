/*
 * The power suite's machine: one container that boots systemd and runs both
 * the Autocode service (user `dev`, lingering on) and OpenCode's background
 * service. A power cut kills every process in it at the same instant (the
 * container's init gets SIGKILL, and the kernel takes the others with it): no
 * shutdown code runs. Booting starts the container again: systemd, the user's
 * manager and the Autocode service come up by themselves, OpenCode does not.
 */
import { docker } from "./docker.ts"
import { fetchJson, until } from "./wait.ts"

export const machine = process.env.MACHINE_CONTAINER ?? ""
export const machineUrl = process.env.MACHINE_URL ?? "http://machine:4848"
export const HOME = "/home/dev"
export const WORK = `${HOME}/work`
// The PATH of the user's own shells (OpenCode's installer adds its folder).
export const USER_PATH = `${HOME}/.opencode/bin:/usr/local/bin:/usr/bin:/bin`
// A variable only the user's own shells have (their profile sets it).
export const OWNER_MARK = "from-the-owners-shell"

let uid = ""

async function userId(): Promise<string> {
  if (!uid) {
    const res = await docker(["exec", "-u", "dev", machine, "id", "-u"])
    if (res.code !== 0) throw new Error(`id -u: ${res.stderr}`)
    uid = res.stdout.trim()
  }
  return uid
}

// A command in the machine as its user, in a shell like the user's own.
export async function asUser(
  script: string,
  timeoutMs = 60_000,
  detached = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const id = await userId()
  return docker(
    [
      "exec",
      ...(detached ? ["-d"] : []),
      "-u",
      "dev",
      "-e",
      `HOME=${HOME}`,
      "-e",
      `PATH=${USER_PATH}`,
      "-e",
      `OWNER_MARK=${OWNER_MARK}`,
      "-e",
      `XDG_RUNTIME_DIR=/run/user/${id}`,
      "-e",
      `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${id}/bus`,
      "-w",
      HOME,
      machine,
      "sh",
      "-c",
      script,
    ],
    timeoutMs,
  )
}

// The same, and a bad exit is an error.
export async function sh(script: string, timeoutMs = 60_000): Promise<string> {
  const res = await asUser(script, timeoutMs)
  if (res.code !== 0)
    throw new Error(`${script} exited ${res.code}: ${res.stdout}${res.stderr}`)
  return res.stdout
}

export async function booted(): Promise<void> {
  await until(
    async () => {
      const res = await docker(
        ["exec", machine, "systemctl", "is-system-running"],
        10_000,
      )
      const state = res.stdout.trim()
      return state === "running" || state === "degraded"
    },
    { timeoutMs: 120_000, intervalMs: 500, what: "systemd to finish booting" },
  )
  await until(
    async () =>
      (
        await asUser("systemctl --user is-system-running", 10_000)
      ).stdout.trim() !== "",
    { timeoutMs: 60_000, intervalMs: 500, what: "the user's systemd manager" },
  )
}

// The Autocode server answers (from outside the machine).
export function serverAnswers(timeoutMs = 60_000): Promise<any> {
  return until(() => fetchJson(`${machineUrl}/v1/info`, { timeoutMs: 2000 }), {
    timeoutMs,
    intervalMs: 250,
    what: "the Autocode service to answer",
  })
}

async function running(): Promise<boolean> {
  const res = await docker(
    ["inspect", "--format={{.State.Running}}", machine],
    10_000,
  )
  return res.stdout.trim() === "true"
}

// The power goes: every process dies at once. Returns when the machine is off.
export async function powerCut(): Promise<number> {
  const res = await docker(["kill", "--signal=KILL", machine], 30_000)
  if (res.code !== 0) throw new Error(`docker kill: ${res.stderr}`)
  await until(async () => !(await running()), {
    timeoutMs: 30_000,
    what: "the machine to be off",
  })
  return Date.now()
}

// The power is back: the machine boots. Returns once systemd is up.
export async function boot(): Promise<number> {
  const res = await docker(["start", machine], 60_000)
  if (res.code !== 0) throw new Error(`docker start: ${res.stderr}`)
  const at = Date.now()
  await booted()
  return at
}

let token = ""

// The owner's admin token, from the machine's Autocode home.
export async function adminToken(): Promise<string> {
  if (!token) token = (await sh(`cat ${HOME}/.autocode/admin.token`)).trim()
  return token
}

// The Autocode server's API as the owner.
export async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  return fetchJson(`${machineUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await adminToken()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// The processes of OpenCode's background service in the machine (its PIDs).
export async function servicePids(): Promise<number[]> {
  // the brackets keep this command's own shell out of the matches
  const res = await asUser("pgrep -f 'opencode serve --servic[e]' || true")
  return res.stdout
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => n > 0)
}

/*
 * OpenCode's background service, started the way a TUI starts it when it is
 * not running (`opencode serve --service`, left running on its own); returns
 * once it has registered itself.
 */
export async function startService(): Promise<void> {
  if ((await servicePids()).length) return
  const res = await asUser(
    `cd ${HOME} && exec opencode serve --service ` +
      ">/tmp/opencode-service.log 2>&1",
    30_000,
    true,
  )
  if (res.code !== 0) throw new Error(`opencode serve: ${res.stderr}`)
  await until(
    async () => {
      const file = await asUser(
        `cat ${HOME}/.local/state/opencode/service.json`,
      )
      if (file.code !== 0) return undefined
      const pid = JSON.parse(file.stdout).pid
      return (await servicePids()).includes(pid)
    },
    { timeoutMs: 60_000, what: "the background service to register" },
  )
}

// The environment a process of the machine runs with, a variable a line.
export async function environOf(pid: number): Promise<string[]> {
  return (await sh(`tr '\\0' '\\n' < /proc/${pid}/environ`)).split("\n")
}

// The control group a process of the machine is in.
export async function cgroupOf(pid: number): Promise<string> {
  return (await sh(`cat /proc/${pid}/cgroup`)).trim()
}

// The history records of a kind since a time (newest first, as the API gives).
export async function historyOf(kind: string, since = 0): Promise<any[]> {
  const res = await api("GET", `/v1/history?kind=${kind}&limit=200`)
  return (res.history as any[]).filter((h) => Date.parse(h.at) >= since)
}
