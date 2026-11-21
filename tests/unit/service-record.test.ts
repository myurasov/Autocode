/*
 * What OpenCode's background service runs as (spec, OpenCode Plugin:
 * Restart): the record a plugin writes on its machine and the server reads,
 * and how the server starts the service from it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startPlan } from "@autocode/server/loader"
import {
  keptEnvironment,
  readServiceRecord,
  serviceRecordPath,
  writeServiceRecord,
} from "@autocode/shared"

let dir: string
let exec: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autocode-record-"))
  exec = join(dir, "opencode")
  writeFileSync(exec, "#!/bin/sh\n", { mode: 0o755 })
  file = join(dir, "home", "opencode-service.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("the record keeps the environment but what belongs to one login session, systemd unit or start", () => {
  expect(
    keptEnvironment({
      PATH: "/home/u/.opencode/bin:/usr/bin",
      HOME: "/home/u",
      NO_PROXY: "localhost",
      PROVIDER_KEY: "secret",
      SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22",
      SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1",
      XDG_SESSION_ID: "6033",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      DISPLAY: ":0",
      TMUX: "/tmp/tmux-1000/default,1,0",
      TMUX_PANE: "%1",
      PWD: "/home/u/work",
      OLDPWD: "/home/u",
      SHLVL: "2",
      _: "/usr/bin/opencode",
      INVOCATION_ID: "abc",
      JOURNAL_STREAM: "8:1",
      MANAGERPID: "2286",
      SYSTEMD_EXEC_PID: "99",
      MEMORY_PRESSURE_WATCH: "/sys/fs/cgroup/x",
      OPENCODE_PTY_HANDOFF: "{}",
      UNSET: undefined,
    }),
  ).toEqual({
    HOME: "/home/u",
    NO_PROXY: "localhost",
    PATH: "/home/u/.opencode/bin:/usr/bin",
    PROVIDER_KEY: "secret",
  })
})

test("the record's file is in the Autocode home", () => {
  expect(serviceRecordPath({ AUTOCODE_HOME: "/data/ac" })).toBe(
    "/data/ac/opencode-service.json",
  )
  expect(serviceRecordPath({})).toEndWith("/.autocode/opencode-service.json")
})

test("written whole, for its owner only, and read back; the same again writes nothing", () => {
  const env = { PATH: "/a:/b", SSH_CLIENT: "x", KEY: "v" }
  expect(writeServiceRecord(exec, env, file, () => 0)).toBe(true)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(join(dir, "home")).mode & 0o777).toBe(0o700)
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    exec,
    env: { KEY: "v", PATH: "/a:/b" },
    written_at: "1970-01-01T00:00:00.000Z",
  })
  expect(readServiceRecord(file)).toEqual({
    exec,
    env: { KEY: "v", PATH: "/a:/b" },
    written_at: "1970-01-01T00:00:00.000Z",
  })
  expect(writeServiceRecord(exec, env, file, () => 5)).toBe(false)
  expect(writeServiceRecord(exec, { ...env, KEY: "w" }, file)).toBe(true)
  expect(readServiceRecord(file)?.env.KEY).toBe("w")
})

test("no record for a binary that is not a file at an absolute path; a record whose binary went, or a broken file, reads as none", () => {
  expect(writeServiceRecord("opencode", {}, file)).toBe(false)
  expect(writeServiceRecord(join(dir, "missing"), {}, file)).toBe(false)
  expect(readServiceRecord(file)).toBeUndefined()
  expect(writeServiceRecord(exec, { PATH: "/a" }, file)).toBe(true)
  rmSync(exec)
  expect(readServiceRecord(file)).toBeUndefined()
  writeFileSync(file, "{ not json")
  expect(readServiceRecord(file)).toBeUndefined()
})

const record = {
  exec: "/home/u/.opencode/bin/opencode",
  env: { PATH: "/home/u/.opencode/bin:/usr/bin", KEY: "v" },
  written_at: "",
}
const files =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path)

test("the server starts the recorded binary with the recorded environment", () => {
  expect(
    startPlan(record, { PATH: "/usr/bin:/bin" }, files(), "/home/u"),
  ).toEqual({
    command: ["/home/u/.opencode/bin/opencode", "serve", "--service"],
    plain: ["/home/u/.opencode/bin/opencode", "serve", "--service"],
    env: record.env,
  })
})

test("without a record: opencode on the server's PATH, else where OpenCode's installer puts it, else by name", () => {
  expect(
    startPlan(
      undefined,
      { PATH: "/usr/local/bin:/usr/bin" },
      files("/usr/bin/opencode"),
      "/home/u",
    ).command,
  ).toEqual(["/usr/bin/opencode", "serve", "--service"])
  expect(
    startPlan(
      undefined,
      { PATH: "/usr/bin" },
      files("/home/u/.opencode/bin/opencode"),
      "/home/u",
    ).command,
  ).toEqual(["/home/u/.opencode/bin/opencode", "serve", "--service"])
  const none = startPlan(undefined, { PATH: "/usr/bin" }, files(), "/home/u")
  expect(none).toEqual({
    command: ["opencode", "serve", "--service"],
    plain: ["opencode", "serve", "--service"],
    env: undefined,
  })
})

test("a server that is a systemd service starts OpenCode in a scope of its own; without systemd-run, directly", () => {
  const env = { PATH: "/usr/bin:/bin", INVOCATION_ID: "abc" }
  expect(
    startPlan(record, env, files("/usr/bin/systemd-run"), "/home/u"),
  ).toEqual({
    command: [
      "/usr/bin/systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "/home/u/.opencode/bin/opencode",
      "serve",
      "--service",
    ],
    plain: ["/home/u/.opencode/bin/opencode", "serve", "--service"],
    env: record.env,
  })
  expect(startPlan(record, env, files(), "/home/u").command).toEqual([
    "/home/u/.opencode/bin/opencode",
    "serve",
    "--service",
  ])
  // not a systemd service (a server run from a terminal): no scope
  expect(
    startPlan(
      record,
      { PATH: "/usr/bin" },
      files("/usr/bin/systemd-run"),
      "/home/u",
    ).command,
  ).toEqual(["/home/u/.opencode/bin/opencode", "serve", "--service"])
})
