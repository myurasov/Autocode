/*
 * The systemd user unit that `autocode install` writes: it runs serve with the
 * given flags (quoted where needed, and AUTOCODE_HOME at install time as
 * --data), restarts on failure and starts with the user manager.
 */
import { describe, expect, test } from "bun:test"
import { ownerToken } from "../../cli/src/connect.ts"
import { ownBinary, serveArgs, unitFile } from "../../cli/src/install.ts"

/*
 * The documentation pass for 1.0.0: on the server machine the owner's
 * commands were refused after a plain `plugin install` (the client config's
 * consumer token won over the server's admin.token), and nothing put the
 * binary where agents' scripts find it on the other machines.
 */
describe("which token the CLI uses, outside an agent's shell", () => {
  const file = "aca_from_the_servers_file"
  test("the client config's admin token; else the server's own file for this machine's server; else the consumer token", () => {
    expect(
      ownerToken(
        { admin_token: "aca_cfg", consumer_token: "acc_cfg" },
        {
          url: "http://127.0.0.1:4848",
          file,
        },
      ),
    ).toBe("aca_cfg")
    for (const url of [
      "http://127.0.0.1:4848",
      "http://localhost:4848",
      "http://[::1]:4848",
    ])
      expect(
        ownerToken({ consumer_token: "acc_cfg" }, { url, file }),
        url,
      ).toBe(file)
    // another machine's server: never this machine's admin token before the
    // config's own
    expect(
      ownerToken(
        { consumer_token: "acc_cfg" },
        {
          url: "http://machine-a:4848",
          file,
        },
      ),
    ).toBe("acc_cfg")
    // nothing in the config: the file, as before
    expect(ownerToken({}, { url: "http://machine-a:4848", file })).toBe(file)
    expect(ownerToken({}, { url: "http://127.0.0.1:4848" })).toBeUndefined()
    expect(
      ownerToken({ consumer_token: "acc_cfg" }, { url: "not a url", file }),
    ).toBe("acc_cfg")
  })
})

describe("plugin install keeps the binary where agents' scripts find it", () => {
  test("an autocode binary is copied to the Autocode home's bin; a development run (bun) is not", () => {
    const home = "/home/someone/.autocode"
    expect(ownBinary("/home/someone/autocode", home)).toBe(
      "/home/someone/.autocode/bin/autocode",
    )
    expect(ownBinary("/tmp/dist/autocode-linux-arm64", home)).toBe(
      "/home/someone/.autocode/bin/autocode",
    )
    // already there: nothing to copy
    expect(
      ownBinary("/home/someone/.autocode/bin/autocode", home),
    ).toBeUndefined()
    expect(ownBinary("/usr/local/bin/bun", home)).toBeUndefined()
    expect(ownBinary("/home/someone/.bun/bin/bun", home)).toBeUndefined()
  })
})

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
