/*
 * The systemd user unit that `autocode install` writes: it runs serve with the
 * given flags (quoted where needed, and AUTOCODE_HOME at install time as
 * --data), restarts on failure and starts with the user manager.
 */
import { describe, expect, test } from "bun:test"
import { serveArgs, unitFile } from "../../packages/cli/src/install.ts"

describe("systemd user unit", () => {
  test("runs the installed binary's serve with the given flags, restarts on failure, starts with the user manager", () => {
    const text = unitFile("/home/ac/.autocode/bin/autocode", [
      "--listen",
      "127.0.0.1:4848",
    ])
    expect(text).toContain(
      "ExecStart=/home/ac/.autocode/bin/autocode serve --listen 127.0.0.1:4848",
    )
    expect(text).toContain("Restart=on-failure")
    expect(text).toContain("WantedBy=default.target")
    expect(text).toMatch(/^\[Unit\]/)
  })

  test("arguments with spaces are quoted", () => {
    expect(unitFile("/opt/my dir/autocode", ["--id", "a b"])).toContain(
      'ExecStart="/opt/my dir/autocode" serve --id "a b"',
    )
  })

  test("the service uses the Autocode home its binary went to: AUTOCODE_HOME at install becomes --data", () => {
    expect(serveArgs({ listen: "localhost:4848" }, {})).toEqual([
      "--listen",
      "localhost:4848",
    ])
    expect(serveArgs({ id: "s", data: "/d" }, {})).toEqual([
      "--id",
      "s",
      "--data",
      "/d",
    ])
    expect(
      serveArgs({}, { AUTOCODE_HOME: "/home/ac/.autocode-dev/try" }),
    ).toEqual(["--data", "/home/ac/.autocode-dev/try"])
    expect(serveArgs({ data: "/srv/ac" }, { AUTOCODE_HOME: "/x" })).toEqual([
      "--data",
      "/srv/ac",
    ])
  })
})
