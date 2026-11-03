/*
 * A wake's check (spec, Wakes: Checks): a shell command run in the agent's
 * folder, with a time limit; its exit code and the start of its output go back
 * to the server. The command runs as its own process group: the time limit
 * kills all of it, and a child it leaves running in the background neither
 * outlives the limit nor keeps a finished check waiting.
 */

import { spawn } from "node:child_process"

export interface CheckResult {
  exit: number | null
  output: string
  timed_out: boolean
}

// How long the output may still come after the command itself exited.
const AFTER_EXIT_MS = 500

export async function runCheck(input: {
  command: string
  directory: string
  timeoutMs: number
  outputLimit: number
  env: Record<string, string | undefined>
}): Promise<CheckResult> {
  const limit = Math.max(0, input.outputLimit)
  const proc = spawn("bash", ["-c", input.command], {
    cwd: input.directory,
    env: input.env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  const text = { out: "", err: "" }
  const keep = (key: "out" | "err") => (chunk: Buffer) => {
    if (text[key].length < limit * 2) text[key] += chunk.toString("utf8")
  }
  proc.stdout?.on("data", keep("out"))
  proc.stderr?.on("data", keep("err"))
  const killGroup = () => {
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGKILL")
    } catch {}
  }
  const exited = new Promise<number | null>((resolve) => {
    proc.on("exit", (code) => resolve(code))
    proc.on("error", () => resolve(null))
  })
  const closed = new Promise<void>((resolve) =>
    proc.on("close", () => resolve()),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), input.timeoutMs)
  })
  const first = await Promise.race([exited, deadline])
  clearTimeout(timer)
  const late = first === "late"
  if (late) killGroup()
  // the output a moment longer, then stop waiting for children
  else
    await Promise.race([
      closed,
      new Promise((r) => setTimeout(r, AFTER_EXIT_MS)),
    ])
  killGroup()
  const { out, err } = text
  const joined = err
    ? `${out}${out && !out.endsWith("\n") ? "\n" : ""}${err}`
    : out
  return {
    exit: late ? null : (first as number | null),
    output: joined.slice(0, limit),
    timed_out: late,
  }
}
