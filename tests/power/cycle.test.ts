/*
 * A sudden power cycle of a machine that runs both the Autocode service and
 * OpenCode's background service (spec, Power Cycle): every process dies at the
 * same instant, with no shutdown code, and the machine boots again. Only the
 * Autocode service starts by itself; nobody opens OpenCode in these tests
 * unless a test says so. Real systemd, the real `autocode install` and
 * `plugin install`, a real OpenCode where its installer puts it.
 */
import { afterAll, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { FakeModel } from "../helpers/fake.ts"
import {
  api,
  asUser,
  boot,
  booted,
  cgroupOf,
  environOf,
  HOME,
  historyOf,
  OWNER_MARK,
  powerCut,
  serverAnswers,
  servicePids,
  sh,
  startService,
  USER_PATH,
  WORK,
} from "../helpers/machine.ts"
import { until } from "../helpers/wait.ts"

const fake = new FakeModel("machine")
const run = crypto.randomUUID().slice(0, 6)
const id = `power:${run}:lead`
const enc = encodeURIComponent
const modelUrl =
  process.env.MACHINE_FAKE_MODEL_URL ?? "http://fake-model:9000/machine/v1"

// What the machine's services said, kept with a failed run's output.
afterAll(async () => {
  try {
    const log = await asUser(
      "journalctl --user -u autocode --no-pager -n 400 2>&1; " +
        "echo '--- processes'; ps -eo pid,ppid,user,lstart,cmd 2>&1; " +
        `echo '--- registration'; cat ${HOME}/.local/state/opencode/` +
        'service.json 2>&1 | sed \'s/"password":"[^"]*"/"password":"…"/\'',
      30_000,
    )
    writeFileSync("/out/machine.log", `${log.stdout}${log.stderr}`)
  } catch {}
})

async function agent(): Promise<any> {
  return (await api("GET", `/v1/agents/${enc(id)}`)).agent
}

async function status(want: string, timeoutMs = 60_000): Promise<any> {
  return until(
    async () => {
      const a = await agent()
      return a?.status === want ? a : undefined
    },
    { timeoutMs, intervalMs: 250, what: `the agent to be ${want}` },
  )
}

// The machine's host for the work folder.
async function host(): Promise<any> {
  return (await api("GET", "/v1/hosts")).hosts.find(
    (h: any) => h.directory === WORK,
  )
}

// A prompt of Autocode's with this text reached the session's model.
async function prompted(
  session: string,
  text: string,
  timeoutMs: number,
): Promise<any> {
  return until(
    async () =>
      (await fake.requests()).find(
        (r: any) =>
          r.session === session && JSON.stringify(r.messages).includes(text),
      ),
    { timeoutMs, intervalMs: 1000, what: `a prompt with "${text}"` },
  )
}

/*
 * The session's turn goes on after a time: its model is asked again, and the
 * agent comes to rest with a turn that succeeded. Who resumes it is not this
 * test's matter: OpenCode 2.3.0 resumes a turn itself when its server was
 * killed under it (its own prompt), and Autocode's `[autocode] resume` comes
 * when OpenCode does not.
 */
async function resumedAfter(session: string, since: number, timeoutMs: number) {
  const again = await until(
    async () =>
      (await fake.requests()).find(
        (r: any) =>
          r.session === session &&
          r.kind === "primary" &&
          Date.parse(r.at) > since,
      ),
    { timeoutMs, intervalMs: 1000, what: "the session's model to be asked" },
  )
  const a = await until(
    async () => {
      const now = await agent()
      return now?.status === "idle" && Date.parse(now.idle_since) > since
        ? now
        : undefined
    },
    { timeoutMs: 120_000, intervalMs: 500, what: "the resumed turn to end" },
  )
  expect(a.last_outcome).toBe("succeeded")
  return again
}

async function setWake(name: string, trigger: string, text: string) {
  await api("PUT", `/v1/agents/${enc(id)}/wakes/${name}`, { trigger, text })
}

// The owner opens OpenCode in the agent's folder (as a TUI does): its
// background service starts if it is not running, and loads the folder.
async function ownerOpens() {
  await startService()
  const marker = `OPEN-${crypto.randomUUID().slice(0, 6)}`
  await fake.script([{ match: marker, reply: "opened" }], true)
  await sh(`cd ${WORK} && opencode run --auto "${marker} hello"`, 150_000)
}

/*
 * Where each test starts from, whatever the one before left: the server
 * answers, no wake of the agent and no scripted step is left over, the
 * agent's host is connected (the owner opens OpenCode when it is not) and the
 * agent idle.
 */
async function settled(): Promise<any> {
  await serverAnswers(120_000)
  await fake.script([], false)
  for (const w of (await api("GET", "/v1/wakes")).wakes as any[])
    if (w.agent === id)
      await api("DELETE", `/v1/agents/${enc(id)}/wakes/${enc(w.name)}`)
  const online = async () => ((await host())?.online ? true : undefined)
  try {
    await until(online, { timeoutMs: 5000, intervalMs: 500 })
  } catch {
    await ownerOpens()
    await until(online, {
      timeoutMs: 120_000,
      intervalMs: 500,
      what: "the agent's host to be online",
    })
  }
  // idle and staying so: what the test before left on its way has arrived
  let a = await status("idle", 180_000)
  for (let quiet = 0; quiet < 2; ) {
    await Bun.sleep(3000)
    const now = await status("idle", 180_000)
    quiet = now.idle_since === a.idle_since ? quiet + 1 : 0
    a = now
  }
  return a
}

// The background service runs as the owner's shells started it.
async function asTheOwners(pid: number) {
  const env = await environOf(pid)
  expect(env).toContain(`OWNER_MARK=${OWNER_MARK}`)
  expect(env).toContain(`PATH=${USER_PATH}`)
}

test("the machine: the Autocode service, the plugin, and an agent in OpenCode's background service", async () => {
  await booted()
  const installed = await sh(
    "autocode install --listen 0.0.0.0:4848 --id power-machine",
    120_000,
  )
  expect(installed).toContain("installed: autocode.service")
  expect((await serverAnswers()).id).toBe("power-machine")
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "fake/main",
    update: "disable",
    share: "disabled",
    providers: {
      fake: {
        name: "Fake",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: modelUrl, apiKey: "fake" },
        models: {
          main: {
            name: "Fake main",
            limit: { context: 200000, output: 8192 },
            cost: { input: 1, output: 2 },
          },
        },
      },
    },
  }
  const encoded = Buffer.from(JSON.stringify(config)).toString("base64")
  await sh(
    `mkdir -p ${HOME}/.config/opencode ${WORK} && echo ${encoded} | ` +
      `base64 -d > ${HOME}/.config/opencode/opencode.json`,
  )
  await sh(
    "autocode plugin install --url http://127.0.0.1:4848 " +
      `--consumer-token-file ${HOME}/.autocode/consumer.token`,
  )
  await api("PATCH", "/v1/settings", { server: { min_interval: "1s" } })

  // the owner's first session, as a TUI or `opencode run` starts it: in the
  // background service
  const marker = `POWER-${run}`
  await fake.script(
    [
      {
        match: marker,
        tool_calls: [
          {
            name: "autocode_me",
            arguments: { action: "register", id, description: "survivor" },
          },
        ],
      },
      { match: marker, reply: "done" },
    ],
    true,
  )
  await startService()
  await sh(`cd ${WORK} && opencode run --auto "${marker} register"`, 150_000)
  const a = await status("idle")
  expect(a).toMatchObject({ id, description: "survivor" })
  expect(a.session).toMatch(/^ses_/)
  const h = await host()
  expect({ kind: h.process_kind, online: h.online }).toEqual({
    kind: "service",
    online: true,
  })
  expect(await servicePids()).toContain(h.process_pid)
  await asTheOwners(h.process_pid)
  // the plugin wrote down what the service runs as, for its owner only
  const file = `${HOME}/.autocode/opencode-service.json`
  const record = JSON.parse(await sh(`cat ${file}`))
  expect(record.exec).toBe(`${HOME}/.opencode/bin/opencode`)
  expect(record.env).toMatchObject({ OWNER_MARK, PATH: USER_PATH })
  expect(Object.keys(record.env)).not.toContain("XDG_RUNTIME_DIR")
  expect((await sh(`stat -c %a ${file}`)).trim()).toBe("600")
}, 600_000)

test("a power cut while idle, off for longer than offline_after: the server is back by itself with its data, starts OpenCode again, and a wake that fell due is delivered", async () => {
  const before = await settled()
  await setWake("due", "in 20s", `after the outage ${run}`)
  const cut = await powerCut()
  // off for longer than the 65 s after which a silent host counts as offline
  await Bun.sleep(75_000)
  await boot()
  expect((await serverAnswers()).id).toBe("power-machine")
  // the data is whole: the agent, its session, its wake, the settings
  expect(await agent()).toMatchObject({
    id,
    description: "survivor",
    session: before.session,
  })
  const settings = await api("GET", "/v1/settings")
  expect(JSON.stringify(settings)).toContain('"min_interval":"1s"')
  // the server knows that nothing is connected
  expect((await host()).online).toBe(false)
  // nobody opens OpenCode: the server starts its service again for the wake
  const got = await prompted(before.session, `after the outage ${run}`, 180_000)
  expect(JSON.stringify(got.messages)).toContain("[autocode]")
  expect((await historyOf("opencode.restarted", cut)).length).toBe(1)
  const h = await host()
  expect({ kind: h.process_kind, online: h.online }).toEqual({
    kind: "service",
    online: true,
  })
  // as before the cut: the owner's binary and environment
  await asTheOwners(h.process_pid)
}, 600_000)

test("OpenCode's background service dies alone: the server starts it again for a waiting wake, and that OpenCode outlives a restart of the Autocode service", async () => {
  const a = await settled()
  const [old] = await servicePids()
  expect(old).toBeGreaterThan(0)
  await sh(`kill -KILL ${old}`)
  const killed = Date.now()
  // once the server has noticed (a quick return is the next test's matter)
  await until(async () => (await host()).online === false, {
    timeoutMs: 120_000,
    intervalMs: 500,
    what: "the host to count as offline",
  })
  await setWake("alone", "in 1s", `opencode died alone ${run}`)
  const got = await prompted(a.session, `opencode died alone ${run}`, 240_000)
  expect(JSON.stringify(got.messages)).toContain("[autocode]")
  expect((await historyOf("opencode.restarted", killed)).length).toBe(1)
  await status("idle", 120_000)
  const before = await host()
  const [pid] = await servicePids()
  expect(pid).toBeGreaterThan(0)
  expect(pid).not.toBe(old)
  await asTheOwners(pid!)
  // to systemd it is not a part of the Autocode service
  expect(await cgroupOf(pid!)).not.toContain("autocode.service")
  await sh("systemctl --user restart autocode.service", 60_000)
  const restarted = Date.now()
  await serverAnswers()
  expect(await servicePids()).toContain(pid!)
  await until(
    async () => {
      const h = await host()
      return h?.online && Date.parse(h.last_seen) > restarted ? h : undefined
    },
    { timeoutMs: 120_000, intervalMs: 500, what: "the host to poll again" },
  )
  expect((await host()).instance).toBe(before.instance)
}, 900_000)

test("a quick power cycle (back within offline_after): a wake due at the boot is still delivered, with nobody opening OpenCode", async () => {
  const before = await settled()
  await setWake("quick", "in 5s", `after the quick cycle ${run}`)
  await powerCut()
  await boot()
  await serverAnswers()
  const got = await prompted(
    before.session,
    `after the quick cycle ${run}`,
    240_000,
  )
  expect(JSON.stringify(got.messages)).toContain("[autocode]")
}, 600_000)

test("a power cut under a running turn, with nothing waiting: the turn is resumed by itself", async () => {
  const before = await settled()
  // a turn that hangs in the model; the power goes under it
  await fake.script([{ session: before.session, hang: true }], true)
  await setWake("long", "in 1s", `a long turn ${run}`)
  await prompted(before.session, `a long turn ${run}`, 60_000)
  await status("working")
  const cut = await powerCut()
  await boot()
  await serverAnswers()
  expect(await agent()).toMatchObject({ id, session: before.session })
  // nobody opens OpenCode: the server starts it for the turn that was cut
  const again = await resumedAfter(before.session, cut, 300_000)
  // the turn's own prompt is still in what the model is sent
  expect(JSON.stringify(again.messages)).toContain(`a long turn ${run}`)
  expect((await historyOf("opencode.restarted", cut)).length).toBe(1)
  // resumed once: by OpenCode or by Autocode's prompt, not by both
  await Bun.sleep(5000)
  const after = (await fake.requests()).filter(
    (r: any) =>
      r.session === before.session &&
      r.kind === "primary" &&
      Date.parse(r.at) > cut,
  )
  expect(after.length).toBe(1)
}, 900_000)

test("OpenCode up before the Autocode service (the owner opens it at once after the boot): the cut turn goes on, the plugin connects when the server answers, and the agent's next wake is delivered", async () => {
  const before = await settled()
  await fake.script([{ session: before.session, hang: true }], true)
  await setWake("long2", "in 1s", `another long turn ${run}`)
  await prompted(before.session, `another long turn ${run}`, 60_000)
  await status("working")
  // the Autocode service comes up 25 s late at the next boot
  await sh(
    `mkdir -p ${HOME}/.config/systemd/user/autocode.service.d && ` +
      "printf '[Service]\\nExecStartPre=/bin/sleep 25\\n' > " +
      `${HOME}/.config/systemd/user/autocode.service.d/late.conf && sync`,
  )
  const cut = await powerCut()
  try {
    await boot()
    // the owner's own OpenCode, in the agent's folder, before the server is up
    await ownerOpens()
    await serverAnswers(120_000)
    await resumedAfter(before.session, cut, 300_000)
    // the plugin that could not reach the server at first is connected
    const h = await until(async () => ((await host())?.online ? host() : 0), {
      timeoutMs: 120_000,
      intervalMs: 500,
      what: "the host to be online",
    })
    expect(h.process_kind).toBe("service")
    // and the agent works on: its next wake is delivered
    await setWake("after", "in 1s", `after the late server ${run}`)
    await prompted(before.session, `after the late server ${run}`, 120_000)
    await status("idle", 120_000)
  } finally {
    await asUser(
      `rm -rf ${HOME}/.config/systemd/user/autocode.service.d && ` +
        "systemctl --user daemon-reload",
    )
  }
}, 900_000)
