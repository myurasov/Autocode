/*
 * The plugin's parts on their own: the client config and the Autocode home, its
 * log, session tokens, matching shells to sessions, gone sessions, and the
 * autocode_me tool.
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  autocodeHome,
  configPath,
  hostId,
  processOf,
  readClientConfig,
} from "../../packages/plugin/src/config.ts"
import {
  serveApiOf,
  shellVariables,
} from "../../packages/plugin/src/localapi.ts"
import { log, logPath } from "../../packages/plugin/src/log.ts"
import { SessionTokens } from "../../packages/plugin/src/sessions.ts"
import { runMe } from "../../packages/plugin/src/tools.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("plugin: client config", () => {
  test("reads the URL and consumer token from client.json in the Autocode home; missing or broken files mean none", () => {
    const dir = mkdtempSync(join(tmpdir(), "autocode-cfg-"))
    dirs.push(dir)
    const env = { AUTOCODE_HOME: dir }
    expect(readClientConfig(env)).toBeUndefined()
    const path = join(dir, "client.json")
    writeFileSync(path, "{not json")
    expect(readClientConfig(env)).toBeUndefined()
    writeFileSync(
      path,
      JSON.stringify({ url: "http://s:4848/", consumer_token: "acc_x" }),
    )
    expect(readClientConfig(env)).toEqual({
      url: "http://s:4848",
      consumer_token: "acc_x",
      server_id: undefined,
    })
    writeFileSync(
      path,
      JSON.stringify({ url: "http://s:4848", consumer_token: "" }),
    )
    expect(readClientConfig(env)).toBeUndefined()
    expect(
      readClientConfig({
        AUTOCODE_HOME: dir,
        AUTOCODE_CONFIG: join(dir, "nope.json"),
      }),
    ).toBeUndefined()
  })

  test("an install keeps everything in ~/.autocode (client.json, logs/) unless AUTOCODE_HOME moves it", () => {
    const home = join(homedir(), ".autocode")
    expect(autocodeHome({})).toBe(home)
    expect(configPath({})).toBe(join(home, "client.json"))
    expect(logPath({})).toBe(join(home, "logs", "plugin.log"))
    expect(configPath({ AUTOCODE_HOME: "/dev/home" })).toBe(
      "/dev/home/client.json",
    )
    expect(logPath({ AUTOCODE_HOME: "/dev/home" })).toBe(
      "/dev/home/logs/plugin.log",
    )
    expect(
      configPath({ AUTOCODE_HOME: "/dev/home", AUTOCODE_CONFIG: "/x/c.json" }),
    ).toBe("/x/c.json")
    // the XDG folders play no part
    expect(configPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      join(home, "client.json"),
    )
    expect(logPath({ XDG_STATE_HOME: "/xdg" })).toBe(
      join(home, "logs", "plugin.log"),
    )
  })

  test("the plugin's log is written to logs/plugin.log in the Autocode home, in folders made 0700", () => {
    const dir = mkdtempSync(join(tmpdir(), "autocode-log-"))
    dirs.push(dir)
    const home = join(dir, "home")
    const saved = process.env.AUTOCODE_HOME
    process.env.AUTOCODE_HOME = home
    try {
      log("hello from the unit test")
    } finally {
      if (saved === undefined) delete process.env.AUTOCODE_HOME
      else process.env.AUTOCODE_HOME = saved
    }
    expect(readFileSync(join(home, "logs", "plugin.log"), "utf8")).toContain(
      "hello from the unit test",
    )
    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(statSync(join(home, "logs")).mode & 0o777).toBe(0o700)
  })

  test("the host ID is stable per machine, OpenCode data folder and workspace folder, and is a valid ID", () => {
    const a = hostId("/home/dev/work", { XDG_DATA_HOME: "/d1" })
    expect(hostId("/home/dev/work", { XDG_DATA_HOME: "/d1" })).toBe(a)
    expect(hostId("/home/dev/other", { XDG_DATA_HOME: "/d1" })).not.toBe(a)
    expect(hostId("/home/dev/work", { XDG_DATA_HOME: "/d2" })).not.toBe(a)
    expect(a).toMatch(/^[A-Za-z0-9._-]+:work:[0-9a-f]{8}$/)
    expect(hostId("/x/My Project (copy)", {})).toMatch(
      /^[^:]+:My-Project-copy:[0-9a-f]{8}$/,
    )
  })
})

describe("plugin: its OpenCode process", () => {
  /*
   * From the documented command line only (`opencode serve`, and `opencode
   * serve --service` for the background service), read the Node way: the
   * arguments start at argv[2], whatever the program and script paths are.
   */
  test("tells the background service and opencode serve apart, with the process ID", () => {
    const run = (...args: string[]) => [
      "/usr/bin/opencode",
      "/x/opencode",
      ...args,
    ]
    expect(processOf(run("serve", "--service"), 42)).toEqual({
      pid: 42,
      kind: "service",
    })
    expect(processOf(run("--print-logs", "serve", "--service"), 1).kind).toBe(
      "service",
    )
    expect(processOf(run("--log-level", "info", "serve"), 7)).toEqual({
      pid: 7,
      kind: "serve",
    })
    // a server a TUI or `opencode run` starts for itself is an opencode serve
    expect(processOf(run("serve", "--stdio", "--port", "0"), 1).kind).toBe(
      "serve",
    )
    expect(processOf(run("serve", "--hostname", "0.0.0.0"), 1).kind).toBe(
      "serve",
    )
    expect(processOf(run(), 1).kind).toBe("other")
    expect(processOf(run("run", "serve"), 1).kind).toBe("other")
  })
})

describe("plugin: opencode serve's local API, from its documented flags", () => {
  const basic = (password: string) =>
    `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const serve = ["/usr/bin/opencode", "/x/opencode", "serve"]

  test("with --port and a password in its environment (OPENCODE_PASSWORD first)", () => {
    expect(
      serveApiOf([...serve, "--hostname", "0.0.0.0", "--port", "4096"], {
        OPENCODE_SERVER_PASSWORD: "pw",
      }),
    ).toEqual({ url: "http://127.0.0.1:4096", authorization: basic("pw") })
    expect(
      serveApiOf([...serve, "--port=5000", "--hostname=10.0.0.5"], {
        OPENCODE_PASSWORD: "first",
        OPENCODE_SERVER_PASSWORD: "second",
      }),
    ).toEqual({ url: "http://10.0.0.5:5000", authorization: basic("first") })
    expect(
      serveApiOf([...serve, "--hostname", "::", "--port", "4100"], {
        OPENCODE_PASSWORD: "pw",
      })?.url,
    ).toBe("http://127.0.0.1:4100")
  })

  test("none without a password, without --port (it may have moved past a busy port), with port 0, or not serve", () => {
    const env = { OPENCODE_PASSWORD: "pw" }
    expect(serveApiOf([...serve, "--port", "4096"], {})).toBeUndefined()
    expect(serveApiOf(serve, env)).toBeUndefined()
    expect(serveApiOf([...serve, "--port", "0"], env)).toBeUndefined()
    expect(
      serveApiOf(["/usr/bin/opencode", "/x/opencode", "--port", "1"], env),
    ).toBeUndefined()
  })

  test("a session's shell variables: OpenCode's own environment (set values only) plus the session's, which win", () => {
    expect(
      shellVariables(
        { PATH: "/bin", GONE: undefined, AUTOCODE_TOKEN: "inherited" },
        { AUTOCODE_TOKEN: "acs_new", AUTOCODE_SESSION: "ses_1" },
      ),
    ).toEqual({
      PATH: "/bin",
      AUTOCODE_TOKEN: "acs_new",
      AUTOCODE_SESSION: "ses_1",
    })
  })
})

describe("plugin: session tokens", () => {
  test("a Subagent's session resolves to its top-level session", async () => {
    const parents: Record<string, string | undefined> = {
      ses_c: "ses_b",
      ses_b: "ses_a",
      ses_a: undefined,
    }
    const tokens = new SessionTokens({
      parentOf: async (s) => parents[s],
      requestToken: async (s) => `tok-${s}`,
    })
    expect(await tokens.root("ses_c")).toBe("ses_a")
    expect(await tokens.root("ses_a")).toBe("ses_a")
  })

  test("one request per session even when asked many times at once; set and drop replace it", async () => {
    let requests = 0
    const tokens = new SessionTokens({
      parentOf: async () => undefined,
      requestToken: async (s) => {
        requests++
        await Bun.sleep(20)
        return `tok-${s}-${requests}`
      },
    })
    const all = await Promise.all([
      tokens.token("ses_a"),
      tokens.token("ses_a"),
      tokens.token("ses_a"),
    ])
    expect(new Set(all).size).toBe(1)
    expect(requests).toBe(1)
    tokens.set("ses_a", "rotated")
    expect(await tokens.token("ses_a")).toBe("rotated")
    tokens.drop("ses_a")
    expect(await tokens.token("ses_a")).toBe("tok-ses_a-2")
  })

  test("a failed request is not cached", async () => {
    let fail = true
    const tokens = new SessionTokens({
      parentOf: async () => undefined,
      requestToken: async () => {
        if (fail) throw new Error("down")
        return "tok"
      },
    })
    await expect(tokens.token("ses_a")).rejects.toThrow("down")
    fail = false
    expect(await tokens.token("ses_a")).toBe("tok")
  })
})

describe("plugin: a session that is gone", () => {
  test("only OpenCode's not-found error for a session counts as gone: the published one, and the one 2.2 raises in plugins", async () => {
    const { sessionIsGone } = await import(
      "../../packages/plugin/src/errors.ts"
    )
    // @opencode/client's published error
    expect(
      sessionIsGone({
        _tag: "SessionNotFoundError",
        sessionID: "ses_1",
        message: "Session not found: ses_1",
      }),
    ).toBe(true)
    // what OpenCode 2.2 raises in-process instead (reported upstream)
    expect(
      sessionIsGone({ _tag: "Session.NotFoundError", sessionID: "ses_1" }),
    ).toBe(true)
    // a message alone is no published contract
    expect(sessionIsGone(new Error("Session not found: ses_1"))).toBe(false)
    expect(sessionIsGone(new Error("Location not found"))).toBe(false)
    expect(sessionIsGone(new Error("model not found"))).toBe(false)
    expect(sessionIsGone(new Error("fetch failed"))).toBe(false)
    expect(sessionIsGone(undefined)).toBe(false)
  })
})

describe("plugin: autocode_me", () => {
  const agent = {
    id: "k:lead",
    description: "Lead",
    status: "idle",
    machine: "m",
    registered_at: "2026-10-28T12:00:00.000Z",
    last_active: "2026-10-28T12:00:00.000Z",
  }

  test("register sends the ID and description and reports the result", async () => {
    const calls: unknown[] = []
    const text = await runMe(
      { action: "register", id: "k:lead", description: "Lead" },
      async (...args) => {
        calls.push(args)
        return { agent }
      },
    )
    expect(calls).toEqual([
      ["POST", "/v1/agents", { id: "k:lead", description: "Lead" }],
    ])
    expect(text).toBe(
      "Registered as k:lead (status idle). How Autocode works: " +
        "autocode_me action=help.",
    )
    expect(await runMe({ action: "register" }, async () => ({}))).toMatch(
      /needs an id/,
    )
  })

  test("status, unregister and discover", async () => {
    expect(
      await runMe({ action: "status" }, async () => ({ registered: false })),
    ).toMatch(/^Not registered/)
    expect(
      await runMe({ action: "status" }, async () => ({
        registered: true,
        agent,
      })),
    ).toContain("Registered as k:lead: Lead.")
    expect(
      await runMe({ action: "unregister" }, async () => ({
        unregistered: "k:lead",
      })),
    ).toBe(
      "Unregistered k:lead; your wakes are removed and your locks released.",
    )
    const seen: string[] = []
    const out = await runMe(
      { action: "discover", pattern: "k:*" },
      async (_m, path) => {
        seen.push(path)
        return { agents: [agent] }
      },
    )
    expect(seen).toEqual(["/v1/agents?match=k%3A*"])
    expect(out).toBe("k:lead  idle  last active 2026-10-28T12:00:00.000Z  Lead")
    expect(
      await runMe({ action: "discover" }, async () => ({ agents: [] })),
    ).toBe("No agents match *.")
  })

  test("an unknown action is an error message, not a crash", async () => {
    expect(await runMe({ action: "fly" } as any, async () => ({}))).toMatch(
      /^error: action must be/,
    )
  })
})
