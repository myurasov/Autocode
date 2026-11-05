/*
 * The CLI's tier 0b commands, run as a process against an in-process server:
 * the agent commands a script uses in an agent's shell (me, wakes, fire, send,
 * messages) and the owner's (inbox, answer, pause, resume, stop-all,
 * resume-all, any agent's wakes, every message).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { generate } from "../../packages/cli/build.ts"
import {
  ack,
  hello,
  instructions,
  registered,
  report,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

const root = resolve(import.meta.dir, "../..")
const main = join(root, "packages/cli/src/main.ts")
let t: TestServer
let home: string
let lead: string
let worker: string

beforeAll(async () => {
  await generate()
  t = await testServer()
  home = mkdtempSync(join(tmpdir(), "autocode-cli-0b-"))
  await hello(t, "m:1")
  lead = await registered(t, "m:1", "ses_1", "kaggle:lead")
  worker = await registered(t, "m:1", "ses_2", "kaggle:worker")
  for (const i of await instructions(t, "m:1")) await ack(t, "m:1", i.id)
})

afterAll(async () => {
  await t.stop()
  rmSync(home, { recursive: true, force: true })
})

async function cli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", main, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
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
// An agent's shell, as the plugin sets it up.
const asAgent = (token: string, session: string) => ({
  AUTOCODE_URL: t.url,
  AUTOCODE_TOKEN: token,
  AUTOCODE_SESSION: session,
})
const asLead = () => asAgent(lead, "ses_1")
const asWorker = () => asAgent(worker, "ses_2")

describe("agent commands, from a script in an agent's shell", () => {
  test("me: the agent's registration and status", async () => {
    const res = await cli(["me"], asLead())
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("kaggle:lead: idle on m (session ses_1)")
    const json = JSON.parse((await cli(["me", "--json"], asLead())).stdout)
    expect(json).toMatchObject({
      registered: true,
      agent: { id: "kaggle:lead" },
    })
  })

  test("wakes: set, list and cancel its own (me)", async () => {
    const set = await cli(
      [
        "wake",
        "set",
        "me",
        "nightly",
        "--trigger",
        "every 1h",
        "--text",
        "Look.",
      ],
      asLead(),
    )
    expect(set.code).toBe(0)
    expect(set.stdout).toContain(
      "wake nightly of kaggle:lead set: every 1h; next",
    )
    const list = await cli(["wakes"], asLead())
    expect(list.stdout).toMatch(/kaggle:lead\s+nightly\s+every 1h/)
    const cancel = await cli(["wake", "cancel", "me", "nightly"], asLead())
    expect(cancel.stdout).toContain("cancelled wake nightly of kaggle:lead")
    expect((await cli(["wakes"], asLead())).stdout).toContain("no wakes")
  })

  test("fire: its own wake with extra text; the prompt names the agent", async () => {
    await cli(
      [
        "wake",
        "set",
        "me",
        "poll",
        "--trigger",
        "fire-only",
        "--text",
        "Poll.",
      ],
      asWorker(),
    )
    const fired = await cli(
      ["fire", "me", "poll", "--text", "data ready"],
      asWorker(),
    )
    expect(fired.stdout).toContain("fired poll of kaggle:worker")
    t.server.tick()
    const inject = (await instructions(t, "m:1")).find(
      (i) => i.type === "inject" && i.payload.session === "ses_2",
    )
    expect(inject.payload.text).toStartWith(
      '[autocode] wake "poll" fired by kaggle:worker',
    )
    expect(inject.payload.text).toContain("data ready")
    await ack(t, "m:1", inject.id)
    // the injected turn runs and ends, as the plugin reports it
    await report(t, "m:1", [
      { type: "turn.ended", session: "ses_2", outcome: "succeeded" },
    ])
  })

  test("send and messages: text, a file, reading, and waiting", async () => {
    const sent = await cli(
      ["send", "kaggle:worker", "hello", "there", "--subject", "hi"],
      asLead(),
    )
    expect(sent.code).toBe(0)
    expect(sent.stdout).toMatch(/^sent to kaggle:worker \(m_\w+\)$/m)
    const list = await cli(["messages"], asWorker())
    expect(list.stdout).toMatch(/m_\w+\s+kaggle:lead\s+hi\s+text\s+11\s+queued/)
    const id = /(m_\w+)/.exec(list.stdout)![1]!
    const read = await cli(["messages", "read", id], asWorker())
    expect(read.stdout).toContain(
      `message ${id} from kaggle:lead, subject "hi":`,
    )
    expect(read.stdout).toContain("hello there")

    const file = join(home, "plot.png")
    writeFileSync(file, Buffer.from([137, 80, 78, 71, 0, 9]))
    const binary = await cli(
      ["send", "kaggle:worker", "--file", file],
      asLead(),
    )
    const fileId = /(m_\w+)/.exec(binary.stdout)![1]!
    const unsaved = await cli(["messages", "read", fileId], asWorker())
    expect(unsaved.stdout).toContain("is a file (image/png")
    const out = join(home, "copy.png")
    const saved = await cli(
      ["messages", "read", fileId, "--out", out],
      asWorker(),
    )
    expect(saved.stdout).toContain(`saved image/png to ${out}`)
    expect([...readFileSync(out)]).toEqual([137, 80, 78, 71, 0, 9])

    const started = Date.now()
    const waited = await cli(["messages", "--wait", "1"], asLead())
    expect(waited.stdout).toContain("no unread messages")
    expect(Date.now() - started).toBeGreaterThan(900)
  })

  test("an agent's shell without its token says to use the tools", async () => {
    const res = await cli(["me"], {
      AUTOCODE_URL: t.url,
      OPENCODE_SESSION_ID: "ses_9",
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("has no AUTOCODE_TOKEN")
    expect(res.stderr).toContain(
      "in the conversation, use the autocode_* tools instead",
    )
  })

  test("an agent's shell never acts as the owner", async () => {
    const res = await cli(["pause", "kaggle:worker"], asLead())
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("refused")
  })
})

describe("owner commands", () => {
  test("every wake, and any agent's", async () => {
    const set = await cli(
      [
        "wake",
        "set",
        "kaggle:lead",
        "standup",
        "--trigger",
        'cron "0 9 * * 1-5" UTC',
        "--text",
        "Standup.",
        "--check",
        "test -f todo",
      ],
      asAdmin(),
    )
    expect(set.stdout).toContain(
      'wake standup of kaggle:lead set: cron "0 9 * * 1-5" UTC; next',
    )
    const all = await cli(["wakes"], asAdmin())
    expect(all.stdout).toMatch(
      /AGENT\s+NAME\s+TRIGGER\s+NEXT\s+CHECK\s+LAST SET\s+TEXT/,
    )
    // when each was last set, in the machine's local time
    expect(all.stdout).toMatch(
      /kaggle:lead\s+standup\s+.*\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\s+Standup\./,
    )
    expect(all.stdout).toMatch(/kaggle:lead\s+standup\s+cron/)
    expect(all.stdout).toMatch(/kaggle:worker\s+poll\s+fire-only/)
    expect(
      (await cli(["wakes", "kaggle:worker"], asAdmin())).stdout,
    ).not.toContain("standup")
    expect(
      (await cli(["wake", "cancel", "kaggle:lead", "standup"], asAdmin()))
        .stdout,
    ).toContain("cancelled wake standup of kaggle:lead")
  })

  test("inbox, answer and close", async () => {
    await cli(["send", "owner", "May", "I?", "--subject", "budget"], asLead())
    await cli(["send", "owner", "FYI"], asWorker())
    const inbox = await cli(["inbox"], asAdmin())
    expect(inbox.stdout).toMatch(/ID\s+KIND\s+AGENT\s+TITLE\s+CREATED/)
    expect(inbox.stdout).toContain('Message from kaggle:lead: "budget"')
    const items = JSON.parse((await cli(["inbox", "--json"], asAdmin())).stdout)
    const [first, second] = items
    const answered = await cli(["answer", first.id, "Yes,", "go."], asAdmin())
    expect(answered.stdout).toContain(`answered ${first.id}`)
    expect(
      (await cli(["inbox", "close", second.id], asAdmin())).stdout,
    ).toContain(`closed ${second.id}`)
    expect((await cli(["inbox"], asAdmin())).stdout).toContain(
      "the inbox is empty",
    )
    const reply = (await cli(["messages", "--all", "--json"], asLead())).stdout
    expect(JSON.parse(reply).some((m: any) => m.from === "owner")).toBe(true)
  })

  test("every message, newest first", async () => {
    const all = await cli(["messages"], asAdmin())
    expect(all.stdout).toMatch(/ID\s+FROM\s+TO\s+SUBJECT\s+KIND\s+SIZE\s+STATE/)
    expect(all.stdout).toMatch(/owner\s+kaggle:lead/)
  })

  test("pause, resume, stop-all and resume-all", async () => {
    expect((await cli(["pause", "kaggle:lead"], asAdmin())).stdout).toContain(
      "kaggle:lead paused",
    )
    expect((await cli(["agents"], asAdmin())).stdout).toMatch(
      /kaggle:lead\s+paused/,
    )
    expect((await cli(["resume", "kaggle:lead"], asAdmin())).stdout).toContain(
      "kaggle:lead resumed",
    )
    expect((await cli(["stop-all"], asAdmin())).stdout).toContain(
      "paused 2 agents (kaggle:lead, kaggle:worker); interrupted 2 sessions",
    )
    expect((await cli(["resume-all"], asAdmin())).stdout).toContain(
      "resumed 2 agents (kaggle:lead, kaggle:worker)",
    )
  })

  // Tier 0b3: a retry now for an agent in the error state.
  test("retry: an agent in the error state now; one that is not is refused", async () => {
    const refused = await cli(["retry", "kaggle:worker"], asAdmin())
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("not in the error state")
    await report(t, "m:1", [
      {
        type: "turn.ended",
        session: "ses_2",
        outcome: "failed",
        error: "provider.internal",
      },
    ])
    expect((await cli(["agents"], asAdmin())).stdout).toMatch(
      /kaggle:worker\s+error/,
    )
    const res = await cli(["retry", "kaggle:worker"], asAdmin())
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("kaggle:worker: a retry comes now")
    await report(t, "m:1", [
      { type: "turn.ended", session: "ses_2", outcome: "succeeded" },
    ])
  })

  test("usage errors exit 2", async () => {
    for (const args of [
      ["wake", "set", "me", "x", "--text", "no trigger"],
      ["wake", "cancel", "me"],
      ["fire", "me"],
      ["send", "kaggle:worker"],
      ["answer", "ib_x"],
      ["pause"],
      ["retry"],
      ["messages", "read"],
    ]) {
      const res = await cli(args, asAdmin())
      expect(res.code, args.join(" ")).toBe(2)
    }
  })
})
