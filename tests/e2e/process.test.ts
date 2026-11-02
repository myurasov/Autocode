/*
 * The OpenCode process a host reports, and whether its shells get Autocode
 * values, in the two other ways OpenCode runs a plugin: the background service
 * (which a TUI and `opencode run` use by default) and a standalone server
 * (`opencode run --standalone`, an `opencode serve` without a known password).
 * The machines' own `opencode serve` is checked in channel.test.ts. Each runs
 * with its own OpenCode data and state folders.
 */
import { afterAll, expect, test } from "bun:test"
import { admin } from "../helpers/autocode.ts"
import { containerName, docker, dockerExec } from "../helpers/docker.ts"
import { nodes } from "../helpers/env.ts"
import { FakeModel } from "../helpers/fake.ts"
import { until } from "../helpers/wait.ts"

const node = nodes[0]!
const fake = new FakeModel(node)
const run = crypto.randomUUID().slice(0, 6)
let servicePid = 0

afterAll(async () => {
  if (servicePid) await dockerExec(node, ["kill", String(servicePid)])
})

// Runs a shell script in the machine, as its user; a bad exit fails the test.
async function sh(script: string, timeoutMs = 60_000): Promise<string> {
  const res = await dockerExec(node, ["sh", "-c", script], timeoutMs)
  if (res.code !== 0)
    throw new Error(`${script} exited ${res.code}: ${res.stdout}${res.stderr}`)
  return res.stdout
}

// The host for a folder on this machine, once it has said hello.
async function hostAt(directory: string): Promise<any> {
  return until(
    async () =>
      (await admin("GET", "/v1/hosts")).hosts.find(
        (h: any) => h.machine === node && h.directory === directory,
      ),
    { timeoutMs: 60_000, intervalMs: 250, what: `a host for ${directory}` },
  )
}

/*
 * `opencode run` in a folder, with a message whose turn runs one shell
 * command; returns that shell's output as the fake model was sent it.
 */
async function runShell(
  setup: string,
  flags: string,
  command: string,
): Promise<string> {
  const marker = `PROC-${run}-${crypto.randomUUID().slice(0, 6)}`
  await fake.script(
    [
      {
        match: marker,
        tool_calls: [
          {
            name: "shell",
            arguments: { command: `echo ${marker}; ${command}` },
          },
        ],
      },
      { match: marker, reply: "done" },
    ],
    true,
  )
  await sh(
    `${setup} && opencode run ${flags} --auto "${marker} shell"`,
    150_000,
  )
  const results = (await fake.requests()).flatMap((r) =>
    (r.messages as any[])
      .filter((m) => m?.role === "tool")
      .map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      ),
  )
  return results.find((text) => text.startsWith(`${marker}\n`)) ?? ""
}

test("a host in the background service says so, and its shells get their values", async () => {
  const env = "XDG_DATA_HOME=/tmp/svc/data XDG_STATE_HOME=/tmp/svc/state"
  await sh("mkdir -p /home/dev/svc /tmp/svc")
  const started = await docker([
    "exec",
    "-d",
    containerName(node),
    "sh",
    "-c",
    `cd && ${env} exec opencode serve --service >/tmp/svc/serve.log 2>&1`,
  ])
  expect(started.code).toBe(0)
  const registered = await until(
    async () => {
      const res = await dockerExec(node, [
        "cat",
        "/tmp/svc/state/opencode/service.json",
      ])
      return res.code === 0 ? JSON.parse(res.stdout) : undefined
    },
    { timeoutMs: 60_000, what: "the background service to register" },
  )
  servicePid = registered.pid
  const out = await runShell(
    `cd /home/dev/svc && export ${env}`,
    "",
    'echo "session=[$AUTOCODE_SESSION]"; ' +
      'curl -s --max-time 5 -H "Authorization: Bearer $AUTOCODE_TOKEN" ' +
      '"$AUTOCODE_URL/v1/me"',
  )
  const host = await hostAt("/home/dev/svc")
  expect({
    kind: host.process_kind,
    pid: host.process_pid,
    shell: host.shell_values,
  }).toEqual({ kind: "service", pid: registered.pid, shell: true })
  const session = /session=\[(ses_\S+)\]/.exec(out)?.[1]
  expect(session).toBeTruthy()
  expect(out).toContain(`"session":"${session}"`)
})

test("a host in a standalone server is an opencode serve whose shells get no values", async () => {
  await sh("mkdir -p /home/dev/solo /tmp/solo")
  const out = await runShell(
    "cd /home/dev/solo && " +
      "export XDG_DATA_HOME=/tmp/solo/data XDG_STATE_HOME=/tmp/solo/state",
    "--standalone",
    'echo "token=[$AUTOCODE_TOKEN] session=[$AUTOCODE_SESSION]"',
  )
  expect(out).toContain("token=[] session=[]")
  const host = await hostAt("/home/dev/solo")
  expect({ kind: host.process_kind, shell: host.shell_values }).toEqual({
    kind: "serve",
    shell: false,
  })
})
