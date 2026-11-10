# Autocode <!-- omit in toc -->

Autocode is a framework for **long-term, agentic autonomy**: it lets AI coding agents keep working on their own for
days or weeks, coordinate with each other, and still stay under their owner's control. It links
[OpenCode](https://opencode.ai) sessions, on one machine or several, to one Autocode server. A session that registers
becomes an **agent**: Autocode can wake it later with a prompt (on a schedule, at a time, when it has been idle, or
when a script or another agent fires it), agents can message each other and you, and a turn that fails is retried. You
watch and steer them from a web UI and a CLI.

_Version 1.0.0-rc3, the third release candidate. Every detail is in [`reference.md`](reference.md); agents start
with [`AGENT.md`](AGENT.md)._

- [Why Autocode](#why-autocode)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Usage](#usage)
- [Development](#development)
- [Documents](#documents)
- [License](#license)

## Why Autocode

An agent in a single conversation stops when its turn ends and waits for someone to type. Autocode lets agents run
**autonomously over the long term**: work toward a goal across many turns, days and restarts, alone or as a team,
while the owner checks in only when needed.

What Autocode provides:

- **Wakes:** an agent comes back to its work later with nobody prompting it: on a schedule, at a time or when idle,
  with checks that decide whether it is worth waking.
- **Background jobs:** a `fire-only` wake that a long job fires at its end, so the agent wakes when it is done.
- **Messages:** agents talk to other agents and to the owner, on any machine, and find each other by ID pattern.
- **Locks and semaphores:** agents share scarce resources (a GPU, a submission) without getting in each other's way,
  with a queue, time limits and notices.
- **Recovery:** retries of failed turns, and resumes of turns cut when OpenCode restarted.
- **The owner's inbox:** agents ask for a decision without stopping everything: questions, permissions and
  approvals, which the owner, another agent or a job's run answer.
- **Limits:** a daily cost cap per agent, compaction of long sessions and expiry of old agents, while nobody watches.
- **Jobs:** a task handed to a fresh agent for each run, on a schedule, by the owner or by an agent; agents can set
  jobs of their own (with the owner's approval), and a run's cost counts for the agent it was for.
- **Control:** pause, resume and Stop All; a web UI and a CLI; the history of everything that happened.

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
  (set, list, show, cancel, fire), `autocode_message` (send, list, read, wait; answer and escalate another agent's
  ask), `autocode_lock` (acquire, renew, release, list) and `autocode_approval` (ask, wait); OpenCode's own question
  tool and permission prompts reach the owner (or another agent) through Autocode. The `autocode` skill, and
  `autocode_me action=help`, is their exact reference. Scripts and background jobs in an agent's shell use the same
  binary as a CLI (`autocode fire me job-done`).
- Autocode types wakes into a session only while it is **idle**, at most once per `min_interval` (1 minute by
  default); what comes meanwhile goes into one prompt, starting with `[autocode]`. Messages and Autocode's notices
  are the exception: while a turn runs they go into it at its next step (OpenCode's steer delivery).

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

Install, update, tokens, backups and troubleshooting: [`reference.md`](reference.md).

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

Every tool and trigger: [`reference.md`](reference.md); the exact guide agents get (the `autocode` skill):
[`autocode.consumer.agent.md`](autocode.consumer.agent.md).

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
- **Messages:** every message, with its state (queued, processed and how, or dropped); send one as the owner.
- **Wakes:** every agent's wakes, when each runs next and was last set; Fire, Cancel, Set a Wake.
- **Locks:** every lock with its capacity, holders (until when; Release) and line.
- **Jobs:** the jobs (who set each) and their runs; Run Now, Edit, Delete, Set a Job.
- **Costs:** every agent's spend today and in total (its runs' with it; unregistered ones too), its daily cap and the
  share spent, live; a row per job for the runs no agent started (`job:<name>`); its last 7 days as a bar per day, and
  its spend per day; an agent filter, a Days field (the total over the last X days), an Unregistered box (on) and the
  totals; a click on an agent's Spend on Agents leads to its row, a gone agent's ID to its row on Agents.
- **History:** every event, newest first, filtered by agent pattern and kind, with Older for more.
- **Settings:** server values, pattern rules, agents' own values, and what an agent resolves to.
- **Help:** how to use Autocode from OpenCode, the CLI and the web UI.

## Development

One TypeScript codebase on [Bun](https://bun.sh), one folder per part at the root: `shared/` (IDs, patterns,
durations, triggers, settings), `server/`, `plugin/`, `cli/` (also `serve`, compiled to one binary per platform with
the web UI inside), `web/` (Angular). Tests in `tests/` (`unit`, `api`, `plugin`, `e2e`, `install`, `web`), CI in
`ci/`.

```sh
bun install
bun run typecheck && bun run lint
bun test tests/unit tests/api            # fast, no Docker
ci/run.sh [suite...]                     # Docker suites in parallel (see below)
ci/dist.sh                               # numbered build with the web UI: dist/autocode (v1.0.0-rc3-build<n>)
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
| [`reference.md`](reference.md) | everyone: install, every feature, the CLI, the web UI, settings, troubleshooting, development |
| [`AGENT.md`](AGENT.md) | agents: which of the two files below to read |
| [`autocode.admin.agent.md`](autocode.admin.agent.md) | an agent that works on this repository or installs Autocode |
| [`autocode.consumer.agent.md`](autocode.consumer.agent.md) | agents using Autocode: the source of the `autocode` skill the plugin gives them |

The specification (the source of truth) and the plan live beside this repository, in the project's `aipack/` folder
(`spec.md`, `plan.md`), with the dated test record (`aipack/tests.md`).

## License

Autocode is licensed under the Apache License, Version 2.0: see [`LICENSE`](LICENSE).
