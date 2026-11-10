/*
 * `autocode install` and `uninstall`: the server as a systemd user service
 * (started at boot when the user has lingering on, otherwise at login), with
 * its binary in the Autocode home's bin/ and its data in that home. Uninstall
 * removes the service only: the binary and the data stay.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, userInfo } from "node:os"
import { basename, join, resolve } from "node:path"
import {
  apiCall,
  type ListenAddress,
  parseListen,
  shownVersion,
} from "@autocode/shared"
import { CliError, type Parsed } from "./args.ts"
import { autocodeHome } from "./connect.ts"

function quote(arg: string): string {
  return /[\s"\\]/.test(arg) ? `"${arg.replace(/(["\\])/g, "\\$1")}"` : arg
}

export function unitFile(binary: string, args: string[]): string {
  const exec = [quote(binary), "serve", ...args.map(quote)].join(" ")
  return [
    "[Unit]",
    "Description=Autocode server",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${exec}`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

/*
 * The flags the service's `serve` gets: those given to install, plus the
 * Autocode home as --data when AUTOCODE_HOME moved it, so the service keeps its
 * data where its binary went (never a development home's binary on
 * ~/.autocode).
 */
export function serveArgs(
  flags: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = []
  for (const name of ["listen", "id", "data"])
    if (flags[name]) out.push(`--${name}`, flags[name])
  if (!flags.data && env.AUTOCODE_HOME)
    out.push("--data", resolve(env.AUTOCODE_HOME))
  return out
}

function unitPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "systemd",
    "user",
    "autocode.service",
  )
}

async function run(
  cmd: string[],
  timeoutMs = 30_000,
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code, out: `${out}${err}`.trim() }
}

async function systemctl(...args: string[]) {
  const res = await run(["systemctl", "--user", ...args])
  if (res.code !== 0)
    throw new CliError(`systemctl --user ${args.join(" ")} failed: ${res.out}`)
  return res.out
}

export async function install(args: Parsed): Promise<number> {
  if (process.platform !== "linux")
    throw new CliError(
      "autocode install sets up a systemd user service and runs on Linux only",
    )
  if (basename(process.execPath) === "bun")
    throw new CliError(
      "run install from the compiled autocode binary, not from bun",
    )
  // Where to check that it answers: the first address that is not the Tailscale
  // one, seen from this machine.
  let addresses: ListenAddress[]
  try {
    addresses = parseListen(args.flags.listen ?? "localhost:4848")
  } catch (err) {
    throw new CliError(`--listen: ${(err as Error).message}`, 2)
  }
  const first = addresses.find((a) => a.host !== "tailscale")
  const host =
    !first || first.host === "localhost" || first.host === "0.0.0.0"
      ? "127.0.0.1"
      : first.host
  const url = `http://${host}:${first?.port ?? 4848}`

  const binDir = join(autocodeHome(), "bin")
  const binary = join(binDir, "autocode")
  mkdirSync(binDir, { recursive: true, mode: 0o700 })
  if (process.execPath !== binary) {
    copyFileSync(process.execPath, `${binary}.new`)
    chmodSync(`${binary}.new`, 0o755)
    renameSync(`${binary}.new`, binary)
  }
  const unit = unitPath()
  mkdirSync(join(unit, ".."), { recursive: true })
  writeFileSync(unit, unitFile(binary, serveArgs(args.flags)))
  await systemctl("daemon-reload")
  await systemctl("enable", "autocode.service")
  await systemctl("restart", "autocode.service")

  let info: any
  for (let i = 0; i < 60 && !info; i++) {
    info = await apiCall(
      url,
      undefined,
      "GET",
      "/v1/info",
      undefined,
      2000,
    ).catch(() => undefined)
    if (!info) await Bun.sleep(500)
  }
  if (!info)
    throw new CliError(
      `the service did not answer at ${url}; see journalctl --user -u autocode`,
    )
  const linger = await run(
    ["loginctl", "show-user", userInfo().username, "--property=Linger"],
    10_000,
  )
  console.log(`installed: autocode.service (${unit}) runs ${binary}`)
  const dataDir = args.flags.data ? resolve(args.flags.data) : autocodeHome()
  console.log(
    `server ${info.id} ${shownVersion(info.version)} answers at ${url}; ` +
      `data in ${dataDir}`,
  )
  console.log(
    `owner tokens: ${join(dataDir, "admin.token")} and consumer.token ` +
      "(mode 0600)",
  )
  if (!linger.out.includes("Linger=yes"))
    console.log(
      "note: lingering is off, so the service starts at login, not at boot " +
        "(loginctl enable-linger)",
    )
  return 0
}

export async function uninstall(): Promise<number> {
  if (process.platform !== "linux")
    throw new CliError("autocode uninstall is for the Linux systemd service")
  const unit = unitPath()
  if (existsSync(unit)) {
    await run(["systemctl", "--user", "disable", "--now", "autocode.service"])
    rmSync(unit)
    await systemctl("daemon-reload")
  }
  console.log(
    "removed autocode.service; the binary and the data stay in " +
      autocodeHome(),
  )
  return 0
}
