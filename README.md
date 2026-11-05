# Autocode <!-- omit in toc -->

Autocode links [OpenCode](https://opencode.ai) sessions, on one machine or several, to one Autocode server. A
session that registers becomes an **agent**: Autocode can wake it later with a prompt (on a schedule, at a time,
when it has been idle, or when a script or another agent fires it), agents can message each other and you, and a
turn that fails is retried. You watch and steer them from a web UI and a CLI.

_Version 0.1.0, Phase 0 in progress. Tiers 0a, 0b and 0b2 are tagged (`v0.1.0-0b2`); tier 0b3 (the error state and
retries) is built and deployed, not yet tagged. Locks, questions and approvals, resumes, cost caps and spawned jobs
come in the next tiers: see [What Works Now](#what-works-now)._

- [How It Works](#how-it-works)
- [What Works Now](#what-works-now)
- [Installation](#installation)
- [Usage](#usage)
- [Development](#development)
- [Documents](#documents)

## How It Works

One Autocode server; each machine's OpenCode connects to it through the plugin, and the CLI and the web UI
talk to the same server.

- **The server** (`autocode serve`, or a systemd user service from `autocode install`) keeps the agents, their
  wakes, messages, the owner's inbox, settings and history in SQLite, and runs the scheduler once a second.
- **The plugin** (one file, installed into OpenCode's global plugin folder by `autocode plugin install`) connects
  each OpenCode folder to the server over a long-polled channel: it reports turns, runs wakes' checks, types
  Autocode's prompts into idle sessions, and gives agents the tools and the guide.
- **Agents** use three tools in the conversation: `autocode_me` (register, status, discover, help),
  `autocode_wake` (set, list, show, cancel, fire) and `autocode_message` (send, list, read, wait). The `autocode`
  skill, and `autocode_me action=help`, is their exact reference. Scripts and background jobs in an agent's shell
  use the same binary as a CLI (`autocode fire me job-done`).
- Autocode only types into a session while it is **idle**, never into a running turn, and at most once per
  `min_interval` (1 minute by default). What comes meanwhile goes into one prompt, starting with `[autocode]`.

## What Works Now

| Area | Built | Coming |
|---|---|---|
| Agents | register by ID (`project:role:name`), discover by pattern, status, the owner's pause, resume, Stop All | `waiting` status (0d) |
| Wakes | `every 30m [from 09:00]`, `in 45m`, `at 09:00`, `cron "*/30 8-16 * * 1-5" [zone]`, `idle 30m [repeat]`, `fire-only`; a check command that decides whether to wake (exit 0) or skip (exit 1); an end time | — |
| Messages | to an agent, a pattern, a list, or the owner; text or files; inline or by ID; `wait` | — |
| Inbox | messages to the owner, answered from the CLI or web UI; alerts | questions, permissions, approvals (0d) |
| Failures | a failed turn puts the agent in the `error` state; a retry prompt every `retry_interval` (1m), up to `retry_attempts` (0: no limit); errors that would fail again are not retried | resuming turns cut by a crash (0e) |
| Coordination | — | locks and semaphores (0c) |
| Costs | — | cost tracking, caps, compaction, expiry (0e) |
| Jobs | — | spawned runs on a schedule or on request (0f) |

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
| `autocode agents [PATTERN]` / `hosts` | agents with their status; the connected OpenCode folders |
| `autocode wakes [AGENT]` / `wake set AGENT NAME --trigger T --text TEXT [--check CMD]` | list or set wakes |
| `autocode fire AGENT WAKE [--text TEXT]` | deliver a wake now |
| `autocode send TO TEXT...` / `messages` | send as the owner; every message |
| `autocode inbox` / `answer ITEM TEXT...` | the owner's inbox |
| `autocode pause AGENT` / `resume` / `retry` / `stop-all` / `resume-all` | the owner's controls |
| `autocode settings [set KEY VALUE [--agent ID \| --match PATTERN]]` | settings: server-wide, per pattern, per agent |
| `autocode history [--agent ID] [--kind KIND]` | what happened |
| in an agent's shell: `autocode me`, `wakes`, `wake set me ...`, `fire me WAKE`, `send`, `messages [--wait S]` | scripts and background jobs act as their agent |

`autocode --help` lists them all.

### Web UI

Served by the server; sign in with the admin token. Light and dark.

- **Hosts:** every connected OpenCode folder, by machine, online or not.
- **Agents:** status (`idle`, `working`, `error`, `paused`, `offline`), host, folder, session; edit, Pause,
  Resume, Retry, New Token, Unregister; Stop All and Resume All; a pattern filter.
- **Inbox:** messages to you and alerts; answer or close.
- **Messages:** every message; send one as the owner.
- **Wakes:** every agent's wakes, when each runs next and was last set; Fire, Cancel, Set a Wake.
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
