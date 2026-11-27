/*
 * The autocode CLI, run as a process against an in-process server, with a
 * throwaway HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { VERSION } from "@autocode/shared"
import { generate } from "../../cli/build.ts"
import {
  call,
  hello,
  sessionToken,
  type TestServer,
  testServer,
} from "../helpers/server.ts"
import { fetchJson, until } from "../helpers/wait.ts"

const root = resolve(import.meta.dir, "../..")
const main = join(root, "cli/src/main.ts")
let t: TestServer
let home: string

beforeAll(async () => {
  await generate()
  t = await testServer()
  home = mkdtempSync(join(tmpdir(), "autocode-cli-"))
  await hello(t, "m:1", {
    process: { pid: 4242, kind: "service" },
    shell_values: true,
  })
  const token = await sessionToken(t, "m:1", "ses_1")
  await call(t.url, token, "POST", "/v1/agents", {
    id: "kaggle:lead",
    description: "Lead agent",
  })
  const other = await sessionToken(t, "m:1", "ses_2")
  await call(t.url, other, "POST", "/v1/agents", { id: "cosa:updater" })
})

afterAll(async () => {
  await t.stop()
  rmSync(home, { recursive: true, force: true })
})

async function cli(
  args: string[],
  env: Record<string, string> = {},
  cwdHome = home,
) {
  const proc = Bun.spawn(["bun", main, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwdHome,
      XDG_CONFIG_HOME: join(cwdHome, ".config"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), 20_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { stdout, stderr, code }
}

const asAdmin = () => ({ AUTOCODE_URL: t.url, AUTOCODE_TOKEN: t.admin })

describe("autocode CLI", () => {
  test("--version and usage errors", async () => {
    expect((await cli(["--version"])).stdout.trim()).toBe(`v${VERSION}`)
    const bad = await cli(["fly"])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain("unknown command")
  })

  test("info shows the server ID and version; an unreachable server exits 3", async () => {
    const res = await cli(["info", "--url", t.url])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("api-test")
    expect(res.stdout).toContain(`autocode v${VERSION},`)
    // the oldest OpenCode it works with (the owner, 2026-11-17)
    expect(res.stdout).toContain("for OpenCode v2.3.0 or later,")
    expect(
      JSON.parse((await cli(["info", "--url", t.url, "--json"])).stdout),
    ).toEqual({
      id: "api-test",
      version: VERSION,
      opencode_min: "2.3.0",
    })
    const down = await cli(["info", "--url", "http://127.0.0.1:9"])
    expect(down.code).toBe(3)
    expect(down.stderr).toContain("cannot reach")
  })

  test("agents lists agents for the owner, filtered by a pattern, as a table or JSON", async () => {
    const table = await cli(["agents"], asAdmin())
    expect(table.code).toBe(0)
    expect(table.stdout).toContain("kaggle:lead")
    expect(table.stdout).toContain("cosa:updater")
    expect(table.stdout).toMatch(/ID\s+STATUS/)
    const filtered = await cli(["agents", "kaggle:*"], asAdmin())
    expect(filtered.stdout).toContain("kaggle:lead")
    expect(filtered.stdout).not.toContain("cosa:updater")
    const json = JSON.parse((await cli(["agents", "--json"], asAdmin())).stdout)
    expect(json.map((a: any) => a.id).sort()).toEqual([
      "cosa:updater",
      "kaggle:lead",
    ])
  })

  test("in an agent's shell the session token discovers agents, and owner commands are refused", async () => {
    const token = await sessionToken(t, "m:1", "ses_1")
    const env = { AUTOCODE_URL: t.url, AUTOCODE_TOKEN: token }
    const res = await cli(["agents", "cosa:*"], env)
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("cosa:updater")
    const refused = await cli(["settings"], env)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("session token")
  })

  test("settings shows, sets and clears values server-wide, for a pattern and for an agent", async () => {
    expect(
      (await cli(["settings", "set", "min_interval", "90s"], asAdmin())).code,
    ).toBe(0)
    expect(
      (
        await cli(
          [
            "settings",
            "set",
            "question_mode",
            "auto_answer",
            "--match",
            "kaggle:*",
          ],
          asAdmin(),
        )
      ).code,
    ).toBe(0)
    expect(
      (
        await cli(
          ["settings", "set", "check_output", "99", "--agent", "kaggle:lead"],
          asAdmin(),
        )
      ).code,
    ).toBe(0)
    const shown = await cli(["settings"], asAdmin())
    expect(shown.stdout).toMatch(/min_interval\s+1m30s\s+server/)
    expect(shown.stdout).toContain("kaggle:*")
    const resolved = await cli(
      ["settings", "--agent", "kaggle:lead"],
      asAdmin(),
    )
    expect(resolved.stdout).toMatch(
      /question_mode\s+auto_answer\s+rule 1 \(kaggle:\*\)/,
    )
    expect(resolved.stdout).toMatch(/check_output\s+99\s+agent/)
    const bad = await cli(
      ["settings", "set", "min_interval", "soon"],
      asAdmin(),
    )
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain("min_interval")
    // 1.1.0-rc6: an old name of a mode value is refused, with the new one
    const renamed = await cli(
      ["settings", "set", "wake_mode", "approve", "--agent", "kaggle:lead"],
      asAdmin(),
    )
    expect(renamed.code).toBe(1)
    expect(renamed.stderr).toContain(
      'wake_mode: "approve" is now "allow" (renamed in 1.1.0-rc6)',
    )
    for (const args of [
      ["settings", "set", "wake_mode", "deny", "--agent", "kaggle:lead"],
      ["settings", "unset", "wake_mode", "--agent", "kaggle:lead"],
    ])
      expect((await cli(args, asAdmin())).code, args[1]).toBe(0)
    expect(
      (await cli(["settings", "unset", "min_interval"], asAdmin())).code,
    ).toBe(0)
    expect(
      (
        await cli(
          ["settings", "unset", "question_mode", "--match", "kaggle:*"],
          asAdmin(),
        )
      ).code,
    ).toBe(0)
    expect(
      (
        await cli(
          ["settings", "unset", "check_output", "--agent", "kaggle:lead"],
          asAdmin(),
        )
      ).code,
    ).toBe(0)
    const view = (await call(t.url, t.admin, "GET", "/v1/settings")).body
    expect(view.server).toEqual({})
    expect(view.rules).toEqual([])
    expect(view.agents).toEqual({})
  })

  test("hosts lists the plugin instances with their machine, folder and whether they are online", async () => {
    const res = await cli(["hosts"], asAdmin())
    expect(res.code).toBe(0)
    expect(res.stdout).toMatch(
      /ID\s+MACHINE\s+FOLDER\s+ONLINE\s+PROCESS\s+SHELL VALUES\s+OPENCODE\s+PLUGIN\s+LAST SEEN/,
    )
    // each host's plugin version, beside OpenCode's (the documentation pass
    // for 1.0.0: the upgrade check reads it)
    expect(res.stdout).toMatch(/m:1\s.*\sv2\.3\.0\s+v0\.1\.0\s/)
    expect(res.stdout).toMatch(
      /m:1\s+m\s+\/work\s+yes\s+service 4242\s+yes\s+v2\.3\.0\s/,
    )
    // a machine whose OpenCode is older than the minimum is marked (the
    // owner, 2026-11-17)
    await hello(t, "mac:old", { opencode: { version: "2.2.0" } })
    // what the server says it needs, not what this CLI was built with
    const marked = await cli(["hosts"], asAdmin())
    expect(marked.stdout).toMatch(
      /mac:old\s+mac\s+\/work\s+no\s+v2\.2\.0 \(too old: needs v2\.3\.0 or later\)\s/,
    )
    expect(
      JSON.parse((await cli(["hosts", "--json"], asAdmin())).stdout)[0].id,
    ).toBe("m:1")
  })

  // 1.1.0 (the owner, 2026-11-20): an agent is renamed in place
  test("agents rename gives an agent a new ID in place; a taken one is refused", async () => {
    const token = await sessionToken(t, "m:1", "ses_rename")
    await call(t.url, token, "POST", "/v1/agents", { id: "cli:old" })
    const res = await cli(["agents", "rename", "cli:old", "cli:new"], asAdmin())
    expect([res.code, res.stdout.trim()]).toEqual([
      0,
      "renamed cli:old to cli:new",
    ])
    expect((await call(t.url, token, "GET", "/v1/me")).body.agent.id).toBe(
      "cli:new",
    )
    const usage = await cli(["agents", "rename", "cli:new"], asAdmin())
    expect(usage.code).toBe(2)
    expect(usage.stderr).toContain(
      "usage: autocode agents rename <agent> <new-id>",
    )
    await call(t.url, t.admin, "DELETE", "/v1/agents/cli:new")
  })

  // 1.0.1 (the owner, 2026-11-19: "fix for stale host records"): the owner
  // removes one offline host's record at once.
  test("hosts rm removes an offline host's record; an online one is refused", async () => {
    await hello(t, "gone:1")
    const online = await cli(["hosts", "rm", "gone:1"], asAdmin())
    expect(online.code).toBe(1)
    expect(online.stderr).toContain("online")
    t.clock.advance(5_000)
    t.server.maintenance()
    const res = await cli(["hosts", "rm", "gone:1"], asAdmin())
    expect([res.code, res.stdout.trim()]).toEqual([0, "removed gone:1"])
    expect(
      JSON.parse((await cli(["hosts", "--json"], asAdmin())).stdout).map(
        (h: any) => h.id,
      ),
    ).not.toContain("gone:1")
    const usage = await cli(["hosts", "rm"], asAdmin())
    expect(usage.code).toBe(2)
    expect(usage.stderr).toContain("usage: autocode hosts rm <host>")
  })

  test("history shows entries, newest first, with filters", async () => {
    const res = await cli(["history", "--agent", "kaggle:lead"], asAdmin())
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("agent.registered")
    const json = JSON.parse(
      (
        await cli(
          ["history", "--kind", "agent.registered", "--limit", "1", "--json"],
          asAdmin(),
        )
      ).stdout,
    )
    expect(json.length).toBe(1)
    expect(json[0].kind).toBe("agent.registered")
  })

  test("the owner registers an ID to a session, forcing a move away from a live session", async () => {
    await sessionToken(t, "m:1", "ses_3")
    const refused = await cli(
      ["agents", "register", "kaggle:lead", "--session", "ses_3"],
      asAdmin(),
    )
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("id_taken")
    const forced = await cli(
      ["agents", "register", "kaggle:lead", "--session", "ses_3", "--force"],
      asAdmin(),
    )
    expect(forced.code).toBe(0)
    expect(forced.stdout).toContain("kaggle:lead is now ses_3")
    await cli(
      ["agents", "register", "kaggle:lead", "--session", "ses_1", "--force"],
      asAdmin(),
    )
  })

  test("the owner moves the ID of a session that is gone, without --force", async () => {
    const token = await sessionToken(t, "m:1", "ses_old")
    await call(t.url, token, "POST", "/v1/agents", { id: "kaggle:mover" })
    await call(t.url, t.consumer, "POST", "/v1/hosts/m:1/events", {
      events: [{ type: "session.deleted", session: "ses_old" }],
    })
    const next = await sessionToken(t, "m:1", "ses_new")
    const refused = await call(t.url, next, "POST", "/v1/agents", {
      id: "kaggle:mover",
    })
    expect(refused.status).toBe(409)
    // the command that the refusal prints, word for word
    const printed = String(refused.body.error.message).split(": ").at(-1)!
    expect(printed).toBe(
      "autocode agents register kaggle:mover --session ses_new",
    )
    const moved = await cli(printed.split(" ").slice(1), asAdmin())
    expect(moved.code).toBe(0)
    expect(moved.stdout).toContain("kaggle:mover is now ses_new")
    await cli(["agents", "rm", "kaggle:mover"], asAdmin())
  })

  test("the owner rotates a token and unregisters an agent", async () => {
    expect(
      (await cli(["token", "rotate", "cosa:updater"], asAdmin())).code,
    ).toBe(0)
    const rm = await cli(["agents", "rm", "cosa:updater"], asAdmin())
    expect(rm.code).toBe(0)
    const again = await cli(["agents", "rm", "cosa:updater"], asAdmin())
    expect(again.code).toBe(1)
  })

  test("the client config file gives the URL and the admin token", async () => {
    const own = mkdtempSync(join(tmpdir(), "autocode-cli-home-"))
    try {
      mkdirSync(join(own, ".autocode"), { recursive: true })
      writeFileSync(
        join(own, ".autocode", "client.json"),
        JSON.stringify({ url: t.url, admin_token: t.admin }),
      )
      const res = await cli(["agents", "--json"], {}, own)
      expect(res.code).toBe(0)
      expect(JSON.parse(res.stdout).map((a: any) => a.id)).toContain(
        "kaggle:lead",
      )
    } finally {
      rmSync(own, { recursive: true, force: true })
    }
  })

  test("on the server's own machine the admin token file is used", async () => {
    const own = mkdtempSync(join(tmpdir(), "autocode-cli-home-"))
    try {
      mkdirSync(join(own, ".autocode"), { recursive: true })
      writeFileSync(join(own, ".autocode", "admin.token"), `${t.admin}\n`)
      const res = await cli(["agents", "--json"], { AUTOCODE_URL: t.url }, own)
      expect(res.code).toBe(0)
    } finally {
      rmSync(own, { recursive: true, force: true })
    }
  })

  test("in an agent's shell without AUTOCODE_TOKEN the CLI uses neither the owner's nor the consumer token", async () => {
    const victim = await sessionToken(t, "m:1", "ses_victim")
    expect(
      (await call(t.url, victim, "POST", "/v1/agents", { id: "cli:victim" }))
        .status,
    ).toBe(201)
    const own = mkdtempSync(join(tmpdir(), "autocode-cli-home-"))
    try {
      mkdirSync(join(own, ".autocode"), { recursive: true })
      writeFileSync(
        join(own, ".autocode", "client.json"),
        JSON.stringify({
          url: t.url,
          consumer_token: t.consumer,
          admin_token: t.admin,
        }),
      )
      writeFileSync(join(own, ".autocode", "admin.token"), `${t.admin}\n`)
      // OpenCode names the session in every shell; the plugin could not add
      // AUTOCODE_* (the server was down then)
      const shells: Record<string, string>[] = [
        { OPENCODE_SESSION_ID: "ses_x" },
        { AUTOCODE_SESSION: "ses_x" },
      ]
      for (const shell of shells) {
        // the owner's commands are not there (the owner, 2026-11-07)
        const rm = await cli(["agents", "rm", "cli:victim"], shell, own)
        expect(rm.code).toBe(2)
        expect(rm.stderr).toContain("only me, fire and send")
        // the agent's own ones need its token, never the owner's
        const me = await cli(["me"], shell, own)
        expect(me.code).toBe(1)
        expect(me.stderr).toContain("AUTOCODE_TOKEN")
        expect((await cli(["send", "cli:victim", "hi"], shell, own)).code).toBe(
          1,
        )
      }
      expect(
        (await call(t.url, t.admin, "GET", "/v1/agents/cli:victim")).status,
      ).toBe(200)
      // the owner can still say which token to use
      const explicit = await cli(
        ["hosts", "--json", "--token", t.admin],
        { OPENCODE_SESSION_ID: "ses_x" },
        own,
      )
      expect(explicit.code).toBe(0)
    } finally {
      rmSync(own, { recursive: true, force: true })
    }
  })

  // 1.1.0-rc7: a token given as --token "$(cat FILE)" shows in the
  // machine's process list; --token-file keeps it out of the command line.
  test("--token-file reads the token from a file, where --token is taken", async () => {
    const own = mkdtempSync(join(tmpdir(), "autocode-cli-home-"))
    try {
      const file = join(own, "admin.token")
      writeFileSync(file, `  ${t.admin}\n\n`, { mode: 0o600 })
      // with no config and no environment, as the owner
      const plain = await cli(
        ["hosts", "--json", "--token-file", file],
        {
          AUTOCODE_URL: t.url,
        },
        own,
      )
      expect(plain.code).toBe(0)
      expect(plain.stdout).toContain("m:1")
      // in an agent's shell it decides like --token, and goes before
      // AUTOCODE_TOKEN (a session's token cannot list hosts' owners' view)
      const session = await sessionToken(t, "m:1", "ses_1")
      const shell = {
        AUTOCODE_URL: t.url,
        AUTOCODE_TOKEN: session,
        OPENCODE_SESSION_ID: "ses_1",
      }
      const inbox = await cli(
        ["inbox", "--json", `--token-file=${file}`],
        shell,
        own,
      )
      expect(inbox.code).toBe(0)
      expect((await cli(["inbox", "--json"], shell, own)).code).toBe(2)
      // both flags: wrong usage, before any request
      const both = await cli(
        ["hosts", "--token", t.admin, "--token-file", file],
        { AUTOCODE_URL: "http://127.0.0.1:9" },
        own,
      )
      expect(both.code).toBe(2)
      expect(both.stderr).toContain("not both")
      // a file that is not there, a folder, an empty file, two words
      const missing = await cli(
        ["hosts", "--token-file", join(own, "nope.token")],
        { AUTOCODE_URL: t.url },
        own,
      )
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain(join(own, "nope.token"))
      const folder = await cli(
        ["hosts", "--token-file", own],
        {
          AUTOCODE_URL: t.url,
        },
        own,
      )
      expect(folder.code).toBe(1)
      const empty = join(own, "empty.token")
      writeFileSync(empty, "  \n")
      const none = await cli(
        ["hosts", "--token-file", empty],
        {
          AUTOCODE_URL: t.url,
        },
        own,
      )
      expect(none.code).toBe(1)
      expect(none.stderr).toContain("empty")
      const two = join(own, "two.token")
      writeFileSync(two, `${t.admin}\n${t.consumer}\n`)
      const many = await cli(
        ["hosts", "--token-file", two],
        {
          AUTOCODE_URL: t.url,
        },
        own,
      )
      expect(many.code).toBe(1)
      // no message ever shows what a file holds
      for (const r of [plain, inbox, both, missing, folder, none, many]) {
        expect(r.stderr).not.toContain(t.admin)
        expect(r.stderr).not.toContain(t.consumer)
      }
      // the usage names the flag
      expect((await cli(["help"])).stdout).toContain("--token-file FILE")
    } finally {
      rmSync(own, { recursive: true, force: true })
    }
  })

  test("the CLI checks the server ID it expects before it sends a token", async () => {
    const own = mkdtempSync(join(tmpdir(), "autocode-cli-home-"))
    const seen: string[] = []
    const impostor = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        seen.push(req.headers.get("authorization") ?? "")
        const path = new URL(req.url).pathname
        return path === "/v1/info"
          ? Response.json({ id: "impostor", version: "0.0.0" })
          : Response.json({ agents: [] })
      },
    })
    try {
      mkdirSync(join(own, ".autocode"), { recursive: true })
      const config = (url: string, extra: Record<string, string> = {}) =>
        writeFileSync(
          join(own, ".autocode", "client.json"),
          JSON.stringify({
            url,
            admin_token: t.admin,
            server_id: "api-test",
            ...extra,
          }),
        )
      config(`http://127.0.0.1:${impostor.port}`)
      const refused = await cli(["agents", "--json"], {}, own)
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain("impostor")
      expect(seen.filter(Boolean)).toEqual([])
      config(t.url)
      expect((await cli(["agents", "--json"], {}, own)).code).toBe(0)
      config(t.url, { server_id: "someone-else" })
      expect((await cli(["agents", "--json"], {}, own)).code).toBe(1)
      // in an agent's shell the plugin's AUTOCODE_SERVER_ID is the expected
      // one; --server-id works everywhere
      const token = await sessionToken(t, "m:1", "ses_cli")
      const shell = {
        AUTOCODE_URL: t.url,
        AUTOCODE_TOKEN: token,
        OPENCODE_SESSION_ID: "ses_cli",
      }
      expect(
        (
          await cli(
            ["me", "--json"],
            { ...shell, AUTOCODE_SERVER_ID: "someone-else" },
            own,
          )
        ).code,
      ).toBe(1)
      expect(
        (
          await cli(
            ["me", "--json"],
            { ...shell, AUTOCODE_SERVER_ID: "api-test" },
            own,
          )
        ).code,
      ).toBe(0)
      expect(
        (
          await cli(
            [
              "agents",
              "--json",
              "--url",
              t.url,
              "--token",
              t.admin,
              "--server-id",
              "x",
            ],
            {},
            own,
          )
        ).code,
      ).toBe(1)
    } finally {
      impostor.stop(true)
      rmSync(own, { recursive: true, force: true })
    }
  })

  test("serve --listen takes the listen setting's format: several names sharing one port", async () => {
    const own = mkdtempSync(join(tmpdir(), "autocode-cli-serve-"))
    const port = 20000 + Math.floor(Math.random() * 20000)
    const proc = Bun.spawn(
      [
        "bun",
        main,
        "serve",
        "--listen",
        `localhost,127.0.0.1:${port}`,
        "--data",
        join(own, "data"),
        "--id",
        "s",
      ],
      {
        env: { PATH: process.env.PATH ?? "", HOME: own },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    try {
      await until(
        () =>
          fetchJson(`http://127.0.0.1:${port}/v1/info`, { timeoutMs: 1000 }),
        {
          timeoutMs: 10_000,
          what: "the server",
        },
      )
      proc.kill()
      await proc.exited
      expect(await new Response(proc.stdout).text()).toContain(
        `autocode v${VERSION}, server s, listening on`,
      )
    } finally {
      proc.kill()
      await proc.exited
      rmSync(own, { recursive: true, force: true })
    }
  })

  test("serve shows the first start's tokens only on a terminal; a log (a service) gets only where they are", async () => {
    const own = mkdtempSync(join(tmpdir(), "autocode-cli-serve-"))
    try {
      const port = 20000 + Math.floor(Math.random() * 20000)
      const proc = Bun.spawn(
        [
          "bun",
          main,
          "serve",
          "--listen",
          `127.0.0.1:${port}`,
          "--data",
          join(own, "data"),
          "--id",
          "s",
        ],
        {
          env: { PATH: process.env.PATH ?? "", HOME: own },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const reader = proc.stdout.getReader()
      let out = ""
      // 30 s: the first start under a loaded CI host can take more than 10 s
      const deadline = Date.now() + 30_000
      while (!out.includes("saved") && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          Bun.sleep(500).then(() => undefined),
        ])
        if (chunk?.value) out += new TextDecoder().decode(chunk.value)
      }
      proc.kill()
      await proc.exited
      expect(out).toContain(join(own, "data", "admin.token"))
      expect(out).not.toMatch(/ac[ac]_[A-Za-z0-9_-]{43}/)
    } finally {
      rmSync(own, { recursive: true, force: true })
    }
  }, 60_000)

  test("plugin install puts the plugin into OpenCode's plugin folder and writes the client config", async () => {
    const own = mkdtempSync(join(tmpdir(), "autocode-cli-home-"))
    const oc = join(own, "oc-config")
    try {
      const res = await cli(
        [
          "plugin",
          "install",
          "--url",
          t.url,
          "--consumer-token",
          t.consumer,
          "--opencode-config-dir",
          oc,
        ],
        {},
        own,
      )
      expect(res.code).toBe(0)
      expect(res.stdout).toContain(`points at api-test v${VERSION} (`)
      const plugin = join(oc, "plugins", "autocode", "index.js")
      expect(readFileSync(plugin, "utf8")).toContain('id: "autocode"')
      // everything of an install lives in ~/.autocode: the client config is
      // client.json there
      const cfgPath = join(own, ".autocode", "client.json")
      expect(JSON.parse(readFileSync(cfgPath, "utf8"))).toMatchObject({
        url: t.url,
        consumer_token: t.consumer,
      })
      expect(statSync(cfgPath).mode & 0o777).toBe(0o600)
      expect(statSync(join(own, ".autocode")).mode & 0o777).toBe(0o700)
      expect(existsSync(join(own, ".config", "autocode"))).toBe(false)
      expect(res.stdout).toContain(cfgPath)
      expect(res.stdout).toContain("api-test")
      const out = await cli(
        ["plugin", "uninstall", "--opencode-config-dir", oc],
        {},
        own,
      )
      expect(out.code).toBe(0)
      expect(existsSync(plugin)).toBe(false)
    } finally {
      rmSync(own, { recursive: true, force: true })
    }
  })

  // The documentation pass for 1.0.0: on the server machine, after a plain
  // plugin install, the owner's commands were refused (the consumer token).
  test("on the server machine the owner's commands use the server's admin.token, also after a plain plugin install", async () => {
    const own = mkdtempSync(join(tmpdir(), "autocode-cli-server-"))
    try {
      mkdirSync(join(own, ".autocode"), { mode: 0o700 })
      writeFileSync(join(own, ".autocode", "admin.token"), `${t.admin}\n`, {
        mode: 0o600,
      })
      writeFileSync(
        join(own, ".autocode", "client.json"),
        JSON.stringify({ url: t.url, consumer_token: t.consumer }),
        { mode: 0o600 },
      )
      // the owner's inbox is not open to a consumer token
      const res = await cli(["inbox"], {}, own)
      expect(res.code, res.stderr).toBe(0)
    } finally {
      rmSync(own, { recursive: true, force: true })
    }
  })

  test("plugin install refuses a server whose ID is not the expected one, and needs a URL and token", async () => {
    const own = mkdtempSync(join(tmpdir(), "autocode-cli-home-"))
    try {
      const wrong = await cli(
        [
          "plugin",
          "install",
          "--url",
          t.url,
          "--consumer-token",
          t.consumer,
          "--server-id",
          "other",
          "--opencode-config-dir",
          join(own, "oc"),
        ],
        {},
        own,
      )
      expect(wrong.code).toBe(1)
      expect(wrong.stderr).toContain("other")
      expect(existsSync(join(own, "oc", "plugins", "autocode"))).toBe(false)
      expect((await cli(["plugin", "install"], {}, own)).code).toBe(2)
    } finally {
      rmSync(own, { recursive: true, force: true })
    }
  })
})
