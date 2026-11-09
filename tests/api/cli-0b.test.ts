/*
 * The CLI's tier 0b commands, run as a process against an in-process server:
 * the agent commands a script uses in an agent's shell (me, fire, send: the
 * owner, 2026-11-07) and the owner's (inbox, answer, pause, resume, stop-all,
 * resume-all, any agent's wakes, every message, locks).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { generate } from "../../packages/cli/build.ts"
import {
  ack,
  call,
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

  // A check script reads its own agent's locks (2026-11-07: an update
  // loop's check, whose `autocode locks` is refused in the shell).
  test("me --json: the agent's own held locks", async () => {
    await call(t.url, lead, "POST", "/v1/locks/cli-me-lock/acquire", {
      ttl: "10m",
    })
    const me = async (env: Record<string, string>) =>
      JSON.parse((await cli(["me", "--json"], env)).stdout).locks
    expect((await me(asLead())).held.map((l: any) => l.name)).toEqual([
      "cli-me-lock",
    ])
    // another agent's hold is not in its own view
    expect(await me(asWorker())).toEqual({ held: [], queued: [] })
    await call(t.url, lead, "POST", "/v1/locks/cli-me-lock/release")
    expect((await me(asLead())).held).toEqual([])
  })

  // The owner, 2026-11-07: a script in an agent's shell has me, fire and
  // send; the rest is the tools' (or the owner's).
  test("in an agent's shell, only me, fire and send", async () => {
    for (const args of [
      ["wakes"],
      ["wake", "set", "me", "x", "--trigger", "every 1h", "--text", "x"],
      ["wake", "cancel", "me", "x"],
      ["messages"],
      ["messages", "read", "m_x"],
      ["locks"],
      ["inbox"],
      ["job", "list"],
    ]) {
      const res = await cli(args, asLead())
      expect(res.code, args.join(" ")).toBe(2)
      expect(res.stderr, args.join(" ")).toContain(
        "in an agent's shell the CLI has only me, fire and send (and the " +
          "machine's own setup: info, serve, install, uninstall, plugin)",
      )
    }
  })

  test("fire: its own wake with extra text; the prompt names the agent", async () => {
    await cli(
      [
        "wake",
        "set",
        "kaggle:worker",
        "poll",
        "--trigger",
        "fire-only",
        "--text",
        "Poll.",
      ],
      asAdmin(),
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

  test("send: text to an agent, with a subject; no files", async () => {
    const sent = await cli(
      ["send", "kaggle:worker", "hello", "there", "--subject", "hi"],
      asLead(),
    )
    expect(sent.code).toBe(0)
    expect(sent.stdout).toMatch(/^sent to kaggle:worker \(m_\w+\)$/m)
    const id = /(m_\w+)/.exec(sent.stdout)![1]!
    const read = await cli(["messages", "read", id], asAdmin())
    expect(read.stdout).toContain(
      `message ${id} from kaggle:lead to kaggle:worker, subject "hi":`,
    )
    expect(read.stdout).toContain("hello there")
    const file = await cli(["send", "kaggle:worker", "--file", "x"], asLead())
    expect(file.code).toBe(2)
  })

  // The review of 0b2: a list's unknown names are named.
  test("send to a list: the names skipped are named", async () => {
    const sent = await cli(
      ["send", "kaggle:worker,kaggle:typo", "hello"],
      asLead(),
    )
    expect(sent.code).toBe(0)
    expect(sent.stdout).toMatch(
      /^sent to kaggle:worker \(m_\w+\); skipped \(not registered\): kaggle:typo$/m,
    )
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
    expect(res.code).toBe(2)
    expect(res.stderr).toContain("only me, fire and send")
    // with the agent's token passed on, the server refuses it
    const passed = await cli(["pause", "kaggle:worker", "--token", lead], {
      AUTOCODE_URL: t.url,
    })
    expect(passed.code).toBe(1)
    expect(passed.stderr).toContain("refused")
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
      /kaggle:lead\s+standup\s+.*\d{4}-\d\d-\d\d \d\d:\d\d [A-Z]{3,5}\s+Standup\./,
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
    expect(inbox.stdout).toMatch(/ID\s+KIND\s+AGENT\s+TO\s+TITLE\s+CREATED/)
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
    const reply = (await cli(["messages", "--json"], asAdmin())).stdout
    expect(
      JSON.parse(reply).some(
        (m: any) => m.from === "owner" && m.to === "kaggle:lead",
      ),
    ).toBe(true)
  })

  test("every message, newest first", async () => {
    const all = await cli(["messages"], asAdmin())
    expect(all.stdout).toMatch(/ID\s+FROM\s+TO\s+SUBJECT\s+SIZE\s+STATE/)
    // the owner's answer to kaggle:lead, earlier in this file
    expect(all.stdout).toMatch(/\bowner\s+kaggle:lead\b/)
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

  // The owner, 2026-11-05: viewing or listing a message does not make it
  // read.
  test("messages and messages read by the owner leave a message unread", async () => {
    const sent = await cli(["send", "kaggle:worker", "for", "later"], asLead())
    const id = /(m_\w+)/.exec(sent.stdout)![1]!
    const all = await cli(["messages"], asAdmin())
    expect(all.stdout).toContain(id)
    const whole = await cli(["messages", "read", id], asAdmin())
    expect(whole.stdout).toContain("for later")
    const json = JSON.parse(
      (await cli(["messages", "--json"], asAdmin())).stdout,
    )
    expect(json.find((m: any) => m.id === id)?.state).toBe("queued")
    // the agent reads it; then it is read
    await call(t.url, worker, "GET", `/v1/me/messages/${id}`)
    const after = JSON.parse(
      (await cli(["messages", "--json"], asAdmin())).stdout,
    )
    expect(after.find((m: any) => m.id === id)?.state).toBe("read")
  })

  // Tier 0c: every lock, by pattern; the owner releases a hold.
  test("locks: holders and queues, by pattern; the owner releases a hold", async () => {
    const acquire = (token: string, name: string, body: object) =>
      call(t.url, token, "POST", `/v1/locks/${name}/acquire`, body)
    await acquire(lead, "gpu:0", { ttl: "1h" })
    await acquire(worker, "gpu:0", { ttl: "10m" })
    await acquire(worker, "data:x", { ttl: "10m", max: 2 })
    const all = await cli(["locks"], asAdmin())
    expect(all.code).toBe(0)
    expect(all.stdout).toMatch(/LOCK\s+MAX\s+HOLDER\s+EXPIRES\s+QUEUE/)
    expect(all.stdout).toMatch(
      /gpu:0\s+1\s+kaggle:lead\s+\S+ \S+ [A-Z]{3,5}\s+kaggle:worker/,
    )
    expect(all.stdout).toMatch(/data:x\s+2\s+kaggle:worker/)
    const some = await cli(["locks", "gpu:*"], asAdmin())
    expect(some.stdout).toContain("gpu:0")
    expect(some.stdout).not.toContain("data:x")
    const json = JSON.parse((await cli(["locks", "--json"], asAdmin())).stdout)
    expect(json.map((l: any) => l.name)).toEqual(["data:x", "gpu:0"])
    const freed = await cli(
      ["locks", "release", "gpu:0", "kaggle:lead"],
      asAdmin(),
    )
    expect(freed.code).toBe(0)
    expect(freed.stdout).toContain("released kaggle:lead's hold on gpu:0")
    expect((await cli(["locks", "gpu:0"], asAdmin())).stdout).toMatch(
      /gpu:0\s+1\s+kaggle:worker/,
    )
    for (const name of ["gpu:0", "data:x"])
      await call(t.url, worker, "POST", `/v1/locks/${name}/release`, {})
    expect((await cli(["locks"], asAdmin())).stdout.trim()).toBe("no locks")
  })

  // Tier 0d: questions, permissions and approvals in the inbox; answer
  // takes any kind.
  test("inbox lists asks with where they went; answer answers them", async () => {
    await report(t, "m:1", [
      {
        type: "ask.opened",
        kind: "question",
        session: "ses_1",
        ref: "frm_cli",
        questions: [
          {
            header: "Fold",
            question: "Which fold?",
            options: [{ label: "v3" }, { label: "v2" }],
          },
        ],
      },
      {
        type: "ask.opened",
        kind: "permission",
        session: "ses_2",
        ref: "per_cli",
        action: "shell",
        resources: ["rm -rf build"],
      },
    ])
    const list = await cli(["inbox"], asAdmin())
    expect(list.stdout).toMatch(/ID\s+KIND\s+AGENT\s+TO\s+TITLE\s+CREATED/)
    expect(list.stdout).toMatch(/ask_\w+\s+question\s+kaggle:lead\s+owner/)
    expect(list.stdout).toMatch(/ask_\w+\s+permission\s+kaggle:worker\s+owner/)
    const items = JSON.parse((await cli(["inbox", "--json"], asAdmin())).stdout)
    const q = items.find((i: any) => i.kind === "question")
    const perm = items.find((i: any) => i.kind === "permission")
    const answered = await cli(["answer", q.id, "v3"], asAdmin())
    expect(answered.code).toBe(0)
    expect(answered.stdout).toContain(`answered ${q.id}`)
    const once = await cli(["answer", perm.id, "once"], asAdmin())
    expect(once.stdout).toContain(`answered ${perm.id}`)
    const late = await cli(["answer", q.id, "v2"], asAdmin())
    expect(late.code).toBe(1)
    expect(late.stderr).toContain("already answered by the owner")
    for (const i of await instructions(t, "m:1")) await ack(t, "m:1", i.id)
  })

  // Tier 0f: jobs from the CLI.
  // The review of 0f: --keep-session is a switch (anywhere on the line);
  // delete-session deletes a failed run's kept session.
  // The review of 0b2: the CLI's times say their zone.
  test("wakes: times in the server's zone, named", async () => {
    await cli(
      ["wake", "set", "kaggle:lead", "zoned", "--trigger", "every 1h"].concat([
        "--text",
        "x",
      ]),
      asAdmin(),
    )
    const res = await cli(["wakes", "kaggle:lead"], asAdmin())
    expect(res.code, res.stderr).toBe(0)
    expect(res.stdout).toMatch(
      /\d{4}-\d\d-\d\d \d\d:\d\d (UTC|[A-Z]{3,5}|GMT[+-]\d+)/,
    )
    await cli(["wake", "cancel", "kaggle:lead", "zoned"], asAdmin())
  })

  test("job set --keep-session; job delete-session", async () => {
    const set = await cli(
      [
        "job",
        "set",
        "keeper",
        "--keep-session",
        "--host",
        "m:1",
        "--model",
        "fake/main",
        "--prompt",
        "Keep it.",
        "--trigger",
        "fire-only",
      ],
      asAdmin(),
    )
    expect(set.code, set.stderr).toBe(0)
    const jobs = JSON.parse(
      (await cli(["job", "list", "--json"], asAdmin())).stdout,
    )
    expect(jobs.find((j: any) => j.name === "keeper").delete_session).toBe(
      false,
    )
    const none = await cli(["job", "delete-session", "keeper:x"], asAdmin())
    expect(none.code).toBe(1)
    expect(none.stderr).toContain("no run keeper:x")
    expect((await cli(["job", "delete", "keeper"], asAdmin())).code).toBe(0)
  })

  test("job set, list, run, runs and delete", async () => {
    const set = await cli(
      [
        "job",
        "set",
        "digest",
        "--host",
        "m:1",
        "--model",
        "fake/main",
        "--prompt",
        "Write the digest.",
        "--trigger",
        "fire-only",
        "--run-usd",
        "2",
      ],
      asAdmin(),
    )
    expect(set.code).toBe(0)
    expect(set.stdout).toContain("job digest set: fire-only on m:1")
    const list = await cli(["job", "list"], asAdmin())
    expect(list.stdout).toMatch(
      /NAME\s+WHERE\s+MODEL\s+TRIGGER\s+NEXT\s+LAST RUN/,
    )
    expect(list.stdout).toMatch(/digest\s+m:\/work\s+fake\/main\s+fire-only/)
    const run = await cli(
      ["job", "run", "digest", "--text", "short"],
      asAdmin(),
    )
    expect(run.stdout).toMatch(/^started run digest:\S+$/m)
    const twice = await cli(["job", "run", "digest"], asAdmin())
    expect(twice.code).toBe(1)
    expect(twice.stderr).toContain("job digest is running")
    const runs = await cli(["job", "runs", "digest"], asAdmin())
    expect(runs.stdout).toMatch(/RUN\s+BY\s+STATE\s+STARTED\s+COST\s+RESULT/)
    expect(runs.stdout).toMatch(/digest:\S+\s+owner\s+starting/)
    const del = await cli(["job", "delete", "digest"], asAdmin())
    expect(del.stdout).toContain("deleted job digest")
    for (const i of await instructions(t, "m:1")) await ack(t, "m:1", i.id)
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
      ["locks", "release"],
      ["job", "set", "x"],
      ["job", "run"],
      ["messages", "read"],
    ]) {
      const res = await cli(args, asAdmin())
      expect(res.code, args.join(" ")).toBe(2)
    }
  })
})

// Tier 0g (the owner, 2026-11-08): each agent's spend and context in the CLI.
describe("costs", () => {
  const step = (session: string, usd: number, context: number) => ({
    type: "cost",
    session,
    usd,
    context,
    limit: 200_000,
    model: "fake/main",
  })

  test("costs: every agent's spend today and in total, its cap and what is left, its context and threshold", async () => {
    await call(t.url, t.admin, "PATCH", "/v1/settings", {
      agents: {
        "kaggle:lead": { daily_usd: 2, compact_at: "50% max 500000" },
      },
    })
    await report(t, "m:1", [
      step("ses_1", 0.5, 60_000),
      step("ses_2", 0.25, 10_000),
    ])
    const res = await cli(["costs"], asAdmin())
    expect(res.code, res.stderr).toBe(0)
    const lines = res.stdout.trim().split("\n")
    expect(lines[0]?.split(/\s+/)).toEqual([
      "AGENT",
      "STATUS",
      "TODAY",
      "CAP",
      "LEFT",
      "TOTAL",
      "CONTEXT",
      "THRESHOLD",
      "SHARE",
    ])
    const lead = lines.find((l) => l.startsWith("kaggle:lead "))
    expect(lead?.split(/\s+/)).toEqual([
      "kaggle:lead",
      "idle",
      "$0.50",
      "$2.00",
      "$1.50",
      "$0.50",
      "60,000",
      "100,000",
      "60.0%",
    ])
    expect(res.stdout).toMatch(/kaggle:worker\s+idle\s+\$0\.25\s+off\s+—/)
    expect(lines.at(-1)).toMatch(/^days in \S+; today \d{4}-\d\d-\d\d$/)
    const json = JSON.parse((await cli(["costs", "--json"], asAdmin())).stdout)
    expect(json.agents.map((a: any) => a.agent)).toContain("kaggle:lead")
  })

  test("costs AGENT: its numbers and its spend per day", async () => {
    const res = await cli(["costs", "kaggle:lead"], asAdmin())
    expect(res.code, res.stderr).toBe(0)
    expect(res.stdout).toContain("kaggle:lead (registered)")
    expect(res.stdout).toMatch(
      /today \$\d+\.\d\d of \$2\.00 \(\$\d+\.\d\d left\); in total \$\d+\.\d\d/,
    )
    expect(res.stdout).toMatch(
      /context 60,000 tokens of 200,000; threshold 100,000: 60\.0%/,
    )
    expect(res.stdout).toMatch(
      /DAY\s+SPEND\s+STEPS\n\d{4}-\d\d-\d\d\s+\$0\.50\s+1/,
    )
    expect((await cli(["costs", "kaggle:none"], asAdmin())).code).toBe(1)
  })

  test("agents shows each agent's spend today and its context's share of the threshold", async () => {
    const res = await cli(["agents"], asAdmin())
    expect(res.stdout).toMatch(
      /^ID\s+STATUS\s+MACHINE\s+TODAY\s+CONTEXT\s+LAST ACTIVE\s+DESCRIPTION$/m,
    )
    expect(res.stdout).toMatch(/kaggle:lead\s+idle\s+\S+\s+\$0\.50\s+60\.0%/)
  })
})
