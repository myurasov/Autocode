# Autocode <!-- omit in toc -->

Autocode is a framework for **long-term, agentic autonomy**: it lets AI coding agents keep working on their own for
days or weeks, coordinate with each other, and still stay under their owner's control. It links
[OpenCode](https://opencode.ai) sessions, on one machine or several, to one Autocode server. A session that registers
becomes an **agent**: Autocode can wake it later with a prompt (on a schedule, at a time, when it has been idle, or
when a script or another agent fires it), agents can message each other and you, and a turn that fails is retried. You
watch and steer them from a web UI and a CLI.

_Version 0.1.0, Phase 0 built. Tiers 0a to 0c are tagged (`v0.1.0-0c`); tiers 0d (questions, permissions and
approvals), 0e (resumes, the daily cost cap, compaction) and 0f (jobs) are built, not yet tagged: see
[What Works Now](#what-works-now)._

- [Why Autocode](#why-autocode)
- [How It Works](#how-it-works)
- [What Works Now](#what-works-now)
- [Installation](#installation)
- [Usage](#usage)
- [Development](#development)
- [Documents](#documents)
- [License](#license)

## Why Autocode

An agent in a single conversation stops when its turn ends and waits for someone to type. Autocode exists so that
agents can run **autonomously over the long term**: work toward a goal across many turns, days and restarts, alone or
as a team, while the owner checks in only when needed. That purpose decides which features Autocode has:

| An autonomous agent needs to | Autocode gives it |
|---|---|
| come back to its work later, without a person prompting it | wakes: schedules, times, idle triggers, and checks that decide whether to wake |
| react when a long background job ends | `fire-only` wakes that the job fires as its last command |
| work with other agents, on any machine | messages to an agent, a group or the owner; discovery by pattern |
| share scarce resources and avoid conflicting work | locks and semaphores with a queue, time limits and notices |
| keep going when something breaks | retries of failed turns; resumes of turns cut by a crash |
| ask for a decision without stopping everything | the owner's inbox: questions, permissions and approvals, which another agent can answer too |
| stay within limits while nobody watches | a daily cost cap per agent, compaction and expiry |
| hand off a task to a fresh agent | jobs: one-off runs started on a schedule, by the owner or by an agent |
| stay under the owner's control | pause, resume and Stop All; the web UI and CLI; history of everything that happened |

Features that do not serve long-running autonomy are left out or kept small, so that what is there stays simple to
understand for both agents and their owner.

## How It Works

One Autocode server; each machine's OpenCode connects to it through the plugin, and the CLI and the web UI
talk to the same server.

- **The server** (`autocode serve`, or a systemd user service from `autocode install`) keeps the agents, their
  wakes, messages, the owner's inbox, settings and history in SQLite, and runs the scheduler once a second.
- **The plugin** (one file, installed into OpenCode's global plugin folder by `autocode plugin install`) connects
  each OpenCode folder to the server over a long-polled channel: it reports turns, runs wakes' checks, types
  Autocode's prompts into idle sessions, and gives agents the tools and the guide.
- **Agents** use five tools in the conversation: `autocode_me` (register, status, discover, help), `autocode_wake`
  (set, list, show, cancel, fire), `autocode_message` (send; answer and escalate another agent's ask; messages come
  whole in the recipient's next prompt), `autocode_lock` (acquire, renew, release, list) and `autocode_approval`
  (ask, wait); OpenCode's own question tool and permission prompts reach the owner (or another agent) through
  Autocode. The `autocode` skill, and `autocode_me action=help`, is their exact reference. Scripts and background
  jobs in an agent's shell use the same binary as a CLI (`autocode fire me job-done`).
- Autocode only types into a session while it is **idle**, never into a running turn, and at most once per
  `min_interval` (1 minute by default). What comes meanwhile goes into one prompt, starting with `[autocode]`.

## What Works Now

| Area | Built | Coming |
|---|---|---|
| Agents | register by ID (`project:role:name`), discover by pattern, status (`waiting` while an ask is open), the owner's pause, resume, Stop All | — |
| Wakes | `every 30m [from 09:00]`, `in 45m`, `at 09:00`, `cron "*/30 8-16 * * 1-5" [zone]`, `idle 30m [repeat]`, `fire-only`; a check command that decides whether to wake (exit 0) or skip (exit 1) | — |
| Messages | text to an agent, a pattern, a list, or the owner; always whole in the recipient's next prompt (Phase 1: no reading or waiting inside a turn) | — |
| Inbox | messages to the owner, answered from the CLI or web UI; alerts; questions (the question tool) and permission prompts, routed by `question_mode` and `permission_mode` to the owner, answered at once, or sent to another agent (`agent:<id>`, which answers or escalates) or a job's run (`job:<name>`); approvals (`autocode_approval`, with options and expiry); the first answer counts | — |
| Failures | a failed turn puts the agent in the `error` state; a retry prompt every `retry_interval` (1m), up to `retry_attempts` (0: no limit); errors that would fail again are not retried; a turn cut by an OpenCode restart is resumed; the machine's background OpenCode service is started again when it is gone | — |
| Coordination | named locks (a mutex) and semaphores (N places) shared by agents on every machine: `try`, or a queue in arrival order with a notice when granted; a required `ttl`, renewal, expiry with a notice | — |
| Costs | each step's cost per agent and day; `daily_usd` with a `cap_warn` notice and a pause after the turn past it; compaction past `compact_at`, with a notice first; expiry after `expire_after`; each agent's spend (live, today, in total, per day), cap and what is left, context and its share of the threshold in the API (`/v1/costs`), `autocode costs` and the web UI | — |
| Jobs | the owner's jobs (a machine and folder, a model, a prompt, a trigger): runs in fresh sessions on a schedule, by the owner or by any agent (the result comes back to it), one at a time; `finish`, the time limit, `run_usd`, the session removed or (failed) kept; asks answered by a job's run (`job:<name>`); `autocode job` and the Jobs page | — |

The full status, tier by tier, is in the project's plan (`aipack/plan.md`, beside this repository).

## Installation

Needs OpenCode 2.2.0 or later on each machine. The server installs as a systemd user service on Linux (ARM64 or
x86-64); the binary also runs on macOS ARM64 (the CLI, `serve` by hand), and the plugin runs wherever OpenCode does.
Machines reach the server over the LAN or Tailscale.

1. **Build** the binary (see [Development](#development)), or take one from a build: `dist/autocode`, or
   `dist/autocode-<linux-arm64|linux-x64|darwin-arm64>`.
2. **Install the server** on the server machine, as its owner's user:

   ```sh
   ./autocode install --listen localhost,tailscale:4848 --id <server-id>
   ```

   It copies itself to `~/.autocode/bin/autocode`, installs and starts the `autocode` systemd user service, and
   creates the admin and consumer tokens in `~/.autocode/` (0600). For a start at boot: `loginctl enable-linger
   $USER`. Or run it in the foreground: `autocode serve [--id ID] [--listen ...] [--data DIR]`.
3. **Connect each machine's OpenCode** (the plugin, and the machine's client config):

   ```sh
   autocode plugin install --url http://<server>:4848 \
     --consumer-token-file <file with the consumer token> --server-id <server-id> \
     [--admin-token-file <file>]   # also lets this machine run the owner's commands
   ```

   Restart OpenCode servers that were already running (`opencode service restart` for the background service).
   `autocode hosts` then lists one line per machine and folder, `online yes`.
4. **Sign in** to the web UI at `http://<server>:4848/` with the admin token (`~/.autocode/admin.token` on the
   server).

Details, tokens, backups and troubleshooting: [`docs/runbook.md`](docs/runbook.md).

## Usage

From OpenCode (agents use the tools), the CLI (the owner, and agents' scripts) and the web UI (the owner).

### OpenCode

Ask an agent in plain words; it uses the tools:

> Register with Autocode as `project:lead`, then every 30 minutes on weekdays between 09:00 and 17:00 check
> `incoming/` for new files and process them — only wake up when there are new files.

> Start the long job `./run-job.sh` in the background and have Autocode wake you when it finishes.

> Ask the owner through Autocode whether you may delete `old-logs/`, and follow the answer.

The agent sees an Autocode prompt like this:

```
[autocode] wake "new-data"

Wake "new-data" (cron "*/30 9-16 * * 1-5"; next 2026-11-05 10:30):
Process the new files in incoming/.
Its check said:
> incoming/a.csv

— From Autocode, not the owner. Your wakes: autocode_wake list. How Autocode works: autocode_me action=help.
```

How agents use Autocode in their own projects, with every tool and trigger: [`docs/howto.md`](docs/howto.md).

### CLI

The same binary. On a machine with an admin token in its client config (or on the server itself) it runs the
owner's commands; in an agent's shell it acts as that agent and never as the owner. Every command takes `--json`.

| Command | Does |
|---|---|
| `autocode agents [PATTERN]` / `hosts` | agents with their status, spend today and context; the connected OpenCode folders |
| `autocode costs [AGENT] [--match PATTERN]` | every agent's spend (today, total; unregistered ones too, with the totals), daily cap and what is left, context and its compaction threshold; one agent's days |
| `autocode wakes [AGENT]` / `wake set AGENT NAME --trigger T --text TEXT [--check CMD]` | list or set wakes |
| `autocode fire AGENT WAKE [--text TEXT]` | deliver a wake now |
| `autocode send TO TEXT...` / `messages` | send as the owner; every message |
| `autocode inbox` / `answer ITEM TEXT...` | the owner's inbox |
| `autocode pause AGENT` / `resume` / `retry` / `stop-all` / `resume-all` | the owner's controls |
| `autocode locks [PATTERN]` / `locks release NAME AGENT` | every lock with its holders and queue; free a hold |
| `autocode job set` / `list` / `run` / `runs` / `delete` | jobs and their runs |
| `autocode settings [set KEY VALUE [--agent ID \| --match PATTERN]]` | settings: server-wide, per pattern, per agent |
| `autocode history [--agent ID] [--kind KIND]` | what happened |
| in an agent's shell: `autocode me`, `fire me WAKE [--text TEXT]`, `send TO TEXT...` | scripts and background jobs act as their agent; everything else is the tools' |

`autocode --help` lists them all.

### Web UI

Served by the server; sign in with the admin token. Light and dark.

- **Hosts:** every connected OpenCode folder, by machine; offline ones with the Offline box.
- **Agents:** status (`idle`, `working`, `waiting`, `error`, `paused`, `offline`), model, spend (today / total),
  context (now / its compaction threshold / the model's window, like `854K/777K/1M`, a bar of the threshold's share
  under it), host, folder, session; edit,
  Pause, Resume, Retry, New Token, Unregister; Stop All and Resume All; a pattern filter; an Unregistered box (the
  gone agents too, with their spend).
- **Inbox:** messages to you and alerts; answer or close.
- **Messages:** every message; send one as the owner.
- **Wakes:** every agent's wakes, when each runs next and was last set; Fire, Cancel, Set a Wake.
- **Locks:** every lock with its capacity, holders (until when; Release) and line.
- **Jobs:** the jobs and their runs; Run Now, Edit, Delete, Set a Job.
- **Costs:** every agent's spend today and in total (unregistered ones too), its daily cap and the share spent,
  live; its last 7 days as a bar per day, and its spend per day; an agent filter, a Days field (the total over the
  last X days), an Unregistered box (on) and the totals; a click on an agent's Spend on Agents leads to its row, a
  gone agent's ID to its row on Agents.
- **History:** every event, newest first, filtered by agent pattern and kind, with Older for more.
- **Settings:** server values, pattern rules, agents' own values, and what an agent resolves to.
- **Help:** how to use Autocode from OpenCode, the CLI and the web UI.

## Development

One TypeScript codebase on [Bun](https://bun.sh): `packages/shared` (IDs, patterns, durations, triggers, settings),
`packages/server`, `packages/plugin`, `packages/cli` (also `serve`, compiled to one binary per platform with the web
UI inside), `packages/web` (Angular). Tests in `tests/` (`unit`, `api`, `plugin`, `e2e`, `install`, `web`), CI in
`ci/`.

```sh
bun install
bun run typecheck && bun run lint
bun test tests/unit tests/api            # fast, no Docker
ci/run.sh [suite...]                     # Docker suites in parallel (see below)
ci/dist.sh                               # numbered build with the web UI: dist/autocode (v0.1.0-build<n>)
AUTOCODE_TARGETS=all ci/dist.sh          # also linux-arm64, linux-x64, darwin-arm64
```

- **`ci/run.sh`** runs `unit`, `api`, `plugin`, `one` (a server and one OpenCode machine), `two` (two machines
  across a Docker network), `restart`, `install` (systemd), `web` (Angular unit tests and browser checks), each as
  its own Compose project, `CI_PARALLEL` at a time (default 4). Real OpenCode runs against a scripted fake model, so
  no test spends money. `CI_GREP` filters the browser checks.
- **`agents`** (in the full run, or `ci/run.sh agents`): real models (`ci/agents/models.json`) must use Autocode
  correctly from plain requests; it runs on the host with the provider settings of the owner's OpenCode config,
  isolated from the owner's sessions, and costs about $1 a run.
- **`ci/mac-check.sh`**: the platform-specific checks, natively on a Mac.
- Code style: Biome; lines within 80 columns; a header comment on every file; tests first.

## Documents

| File | For |
|---|---|
| [`docs/runbook.md`](docs/runbook.md) | the owner: install, commands, settings, web UI, troubleshooting |
| [`docs/howto.md`](docs/howto.md) | agents and their projects: the tools, triggers, messages, failed turns |
| [`docs/tests.md`](docs/tests.md) | what each tier's tests cover, dated CI runs, live checks and their spend |

The specification (the source of truth) and the plan (what is built, what is next) live beside this repository, in
the project's `aipack/` folder (`spec.md`, `plan.md`).

## License

Autocode is licensed under the Apache License, Version 2.0: see [`LICENSE`](LICENSE).
