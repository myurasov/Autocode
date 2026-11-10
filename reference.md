# Autocode Reference <!-- omit in toc -->

Autocode lets AI coding agents in [OpenCode](https://opencode.ai) keep working on their own for days or weeks, work
with each other, and stay under their owner's control. This is the full reference: for owners who install and run
Autocode, and for anyone who wants the details of what agents can do. For a short tour, see [`README.md`](README.md).

- [Overview](#overview)
- [Install](#install)
- [What Agents Can Do](#what-agents-can-do)
- [Wakes](#wakes)
- [Messages](#messages)
- [Locks and Semaphores](#locks-and-semaphores)
- [Questions, Permissions and Approvals](#questions-permissions-and-approvals)
- [When Things Fail](#when-things-fail)
- [Costs and Context](#costs-and-context)
- [Jobs and Runs](#jobs-and-runs)
- [Injected Prompts](#injected-prompts)
- [CLI](#cli)
- [Web UI](#web-ui)
- [Settings](#settings)
- [Files, Tokens and Backups](#files-tokens-and-backups)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Overview

Autocode gives OpenCode sessions long-term, agentic autonomy. A session that registers becomes an agent: Autocode can
wake it later, and agents can message each other and the owner, share locks, ask for decisions and hand tasks to
fresh agents. The owner watches and steers it all from a web UI and a CLI.

### The Parts

- **Server:** one per installation. It keeps agents, wakes, messages, the owner's inbox, locks, jobs, settings and
  history in SQLite, runs the scheduler about once a second, and serves the API and the web UI.
- **Plugin:** one file in each machine's OpenCode. It connects each OpenCode folder to the server over a long-polled
  channel, reports turns and costs, runs wakes' checks, types Autocode's prompts into sessions, and gives sessions the
  tools and the `autocode` skill.
- **CLI:** the same `autocode` binary: the owner's commands, and three commands for an agent's scripts.
- **Web UI:** served by the server; the owner signs in with the admin token.

### Words Used Here

| Word | Meaning |
|---|---|
| server | the Autocode server; it has an ID (`--id`, else `config.json`, else its host name) |
| host | one OpenCode server folder on one machine that the plugin connects (one plugin instance) |
| agent | a registered OpenCode session, with an ID like `team:lead` |
| owner | the person who runs Autocode; as an address, `owner` means the owner's Inbox |
| wake | a prompt Autocode types into an agent's session later, when its trigger falls due |
| notice | a message from Autocode itself (`autocode`): a lock granted, an approval's answer, a run's result |
| ask | a question, a permission prompt or an approval that a turn waits for |
| job | a task the owner defines: a host, a model, a prompt and a trigger |
| run | one run of a job: a fresh session, registered as an agent of its own |

### How Delivery Works

- Autocode types a prompt into a session only while it is idle (no turn runs), the agent is not paused and its machine
  is connected, and at most once per `min_interval` (1 minute by default). What falls due meanwhile goes into one
  prompt that starts with `[autocode]`.
- Messages and Autocode's notices are the exception: while a turn runs, they go into it at its next step (after the
  tool call or model step that runs now), with OpenCode's steer delivery.
- Wakes, retries and resumes wait for the turn to end. What waits is kept across server restarts.

### Patterns

Many fields take an ID pattern (`discover`, a message's `to`, settings rules, filters). `*` matches any characters,
`:` included: `team:*`, `*:reviewer`, `team:worker-*`. A comma list: `a,b,c`. IDs are case-sensitive.

## Install

Install the server once, connect the OpenCode of each machine, then sign in to the web UI.

### Requirements

- OpenCode 2.2.0 or later on each machine that should use Autocode.
- The server installs as a systemd user service on Linux (ARM64 or x86-64). The binary also runs on macOS ARM64 (the
  CLI, and `serve` by hand). The plugin runs wherever OpenCode does. Machines reach the server over the LAN or
  Tailscale.
- The binary: `dist/autocode` or `dist/autocode-<linux-arm64|linux-x64|darwin-arm64>` from a build (see
  [Development](#development)), copied to the server machine, say as `~/autocode`.

### Install the Server

On the server machine, as the user that should own the service:

```sh
~/autocode install --listen localhost,tailscale:4848 --id <server-id>
```

- It copies itself to `~/.autocode/bin/autocode`, writes `~/.config/systemd/user/autocode.service`, enables and
  starts it, and waits until it answers. The first start saves the admin and consumer tokens in `~/.autocode/` (0600).
- `--listen`: names sharing one port (`localhost,tailscale:4848`) or addresses each with a port
  (`127.0.0.1:4848,0.0.0.0:4849`). Without it, the `listen` setting: 127.0.0.1 and the machine's Tailscale address,
  port 4848. A server that starts before Tailscale has its address listens on it as soon as it appears.
- `--id ID`: the server ID; without it, from `~/.autocode/config.json` (`{"id": "..."}`), else the host name.
- `--data DIR` puts the data elsewhere. With `AUTOCODE_HOME` set, the binary and the data go to that home.
- It starts at boot only with lingering on (`loginctl enable-linger $USER`, once, as root); otherwise at login.
  `install` says which. It runs on Linux only, from the compiled binary.

To run the server in the foreground instead: `autocode serve [--id ID] [--listen ADDRESSES] [--data DIR]`. Data goes
to `--data`, else `$AUTOCODE_HOME`, else `~/.autocode`. Stop it with Ctrl-C or SIGTERM.

### Connect Each Machine

On each machine whose OpenCode should use Autocode (the server machine too, if agents run there), copy the consumer
token (`~/.autocode/consumer.token` on the server) into a file, then:

```sh
autocode plugin install --url http://<server>:4848 --consumer-token-file <file> \
  --server-id <server-id> [--admin-token-file <file>] [--opencode-config-dir <dir>]
```

- It checks the server, its ID and the token, then puts the plugin into `plugins/autocode/` of OpenCode's config
  folder (`$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`).
- It writes the client config `~/.autocode/client.json` (0600; `AUTOCODE_CONFIG` names another file): the URL, the
  tokens and the expected server ID. `--admin-token-file` lets the owner run owner commands from that machine.
  `--consumer-token` and `--admin-token` take a token itself instead of a file.
- OpenCode loads the plugin with each folder when the folder is first used (a TUI opens it, or a prompt runs).
  Restart OpenCode servers that were already running (`opencode service restart` for the background service; it
  closes open TUIs), or let their folders reload: OpenCode unloads a folder after an hour unused.

### Sign In and Check

- Open `http://<server>:4848/` and sign in with the admin token, from `~/.autocode/admin.token` on the server.
- `autocode info`: the server's ID and version, like `v1.0.0-rc2-build<n>` (the release and a build number that keeps
  counting across releases).
- `systemctl --user status autocode`; the server's log: `journalctl --user -u autocode`.
- `autocode hosts`: one line per machine and folder, `online yes`. In a session: `autocode_me action=status` answers.

### Upgrade

1. Back up the data: `sqlite3 ~/.autocode/autocode.db ".backup ~/.autocode/autocode-backup.db"`.
2. Run the new binary's `install` on the server machine, with the same flags. It replaces the binary and restarts the
   service; data and tokens stay, and the database is migrated at the start.
3. On each machine, run `autocode plugin install` again with the new binary, then restart its running OpenCode
   servers. `autocode hosts` (or the Hosts page) shows the new plugin version.

### Uninstall

- Server: `~/.autocode/bin/autocode uninstall` stops and removes the service. The binary and the data in
  `~/.autocode/` stay; delete the folder by hand to remove everything (a new install then makes new tokens).
- Plugin: `autocode plugin uninstall [--opencode-config-dir DIR]`. The client config stays; delete it by hand.

## What Agents Can Do

Agents use five tools in the conversation, each with an `action`; no shell is needed. Scripts and background jobs in
an agent's shell use the CLI instead.

### The Tools

| Tool | Actions (parameters) |
|---|---|
| `autocode_me` | `register` (`id`, `description`), `unregister`, `status`, `discover` (`pattern`), `help` (`topic`), `compact`, `jobs`, `run` (`job`, `text`), `finish` (`result`), `job_set` (`job`, `model`, `prompt`, `trigger`, `run_usd`; optional `host`, `to`, `timeout`, `variant`, `opencode_agent`, `keep_session`, `description`), `job_delete` (`job`) |
| `autocode_wake` | `set` (`name`, `trigger`, `text`, `check`), `list`, `show` (`name`), `cancel` (`name`), `fire` (`agent`, `name`, `text`) |
| `autocode_message` | `send` (`to`, `subject`, `text`, `reply_to`), `list` / `read` / `wait` (`id`, `from`, `reply_to`; wait: `seconds`), `answer` and `escalate` (`id`, `text`) |
| `autocode_lock` | `acquire` (`name`, `ttl`, `max`, `mode`), `renew` (`name`, `ttl`), `release` (`name`), `list` (`pattern`) |
| `autocode_approval` | `ask` (`text`, `options`, `expires`), `wait` (`id`, `seconds`) |

OpenCode's own question tool and permission prompts reach the owner (or another agent) through Autocode too.

### The Agent Guide

[`autocode.consumer.agent.md`](autocode.consumer.agent.md) is the exact text agents get. The plugin gives it to every
session as the `autocode` skill, and `autocode_me action=help` returns it whole, or `topic=` one part: `overview`,
`delivery`, `wakes`, `checks`, `recipes`, `messages`, `owner`, `locks`, `asks`, `costs`, `jobs`, `prompts`, `scripts`,
`trouble`. Once a session is registered, every model call carries one line that names its agent ID.

### Register and Discover

```
autocode_me  action=register  id=team:lead  description="Lead agent of the team"
autocode_me  action=discover  pattern=team:*
```

- An agent needs `autocode_me` in its tool list. If it is missing, the plugin is not installed on that machine: the
  agent tells the owner and does not set it up itself. An answer that starts with `error` says why a call failed.
- One ID per session: letters, digits, `-`, `_`, `.` and `:`, up to 255 characters, with levels split by `:`
  (project, role, name). `owner` and `autocode` are reserved. A Subagent acts for its top-level session.
- Registering again with the same ID from the same session changes nothing: safe after a compaction.
- An ID another session holds is refused (`id_taken`) while that session exists; once it is deleted, the ID moves to
  the next session that registers it. A session with an ID is refused another (`session_has_id`).
- Unregistered by `unregister`, by the owner, when its session is deleted, or `expire_after` (14 days) after its
  session's last turn. Its history stays.
- Status: `idle`, `working` (in a turn), `waiting` (an ask of its own is open), `error` (its last turn failed),
  `paused` (by the owner, Stop All or its daily cap) or `offline` (its machine cannot reach the server).
- `discover` lists one line per agent: ID, status, last activity, description.

### Shell Values and Scripts

The plugin puts four values into every shell of a registered session (and of its Subagents):

| Variable | Value |
|---|---|
| `AUTOCODE_URL` | the server's address |
| `AUTOCODE_TOKEN` | the session's token: it acts as the agent |
| `AUTOCODE_SERVER_ID` | the server's ID |
| `AUTOCODE_SESSION` | the top-level session's ID |

A script or background job started there acts as the agent with three commands only:

- `autocode me`: the agent's registration and status;
- `autocode fire me WAKE [--text TEXT]`: deliver one of its wakes now, say as a background job's last command;
- `autocode send TO TEXT... [--subject S] [--reply-to ID]`: send a message, say a job's result.

Wakes, messages and locks are the tools'. Never copy `AUTOCODE_TOKEN` into files or messages. A training run that
wakes its agent when it ends:

```sh
nohup sh -c 'python train.py > runs/latest/log.txt 2>&1; autocode fire me training-done --text "exit $?"' &
```

### Rules for Agents

- Use the tools in the conversation; when unsure, read the guide or ask the owner, never the plugin's code.
- Register once per session, with a stable ID; keep wake texts self-contained (you may have compacted since).
- Release locks as soon as you are done; do not wake other agents in a loop; never put secrets in messages.

A snippet for a project's `AGENTS.md`, under a heading of its own (say `Autocode`):

```md
This project uses Autocode. On session start, if the `autocode_me` tool is available and `autocode_me action=status`
shows you unregistered, register as `<project>:<role>:<name>`. Use `autocode_me action=discover` to find the
project's other agents, and load the `autocode` skill once for the details. Use wakes, with checks, instead of waiting
in a loop; message other agents with `autocode_message`. Take lock `<resource>` before <the conflicting operation>.
Ask the owner through the question tool, and ask for an approval before <payments, deploys, trades, deletions>.
```

## Wakes

A wake is a prompt that Autocode types into an agent's session later. It has a name (setting the same name again
replaces it, and its schedule starts over), a text (what to do, where the notes are), a trigger, and maybe a check.

```
autocode_wake  action=set  name=check-training  trigger="every 30m"  text="Check the run in runs/ and act on it."
autocode_wake  action=set  name=standup  trigger='cron "0 9 * * 1-5" America/Los_Angeles'  text="Write today's plan."
autocode_wake  action=set  name=new-data  trigger="every 15m"  check='test -n "$(ls incoming/*.csv 2>/dev/null)"'  text="Load the new files."
autocode_wake  action=set  name=training-done  trigger=fire-only  text="Training finished: read runs/latest/log.txt."
autocode_wake  action=fire  agent=team:worker-1  name=new-fold  text="Folds v3 are ready."
```

### Triggers

Times without a zone are in the server's zone (the `timezone` setting; `autocode_me action=status` shows it).

| Trigger | Falls due |
|---|---|
| `every 30m`, `every 2h from 09:00` | every so long, counted from when it was set, or from that time that day; fixed steps (a daylight-saving change shifts them an hour: use `cron` for clock times); at least 1s |
| `in 45m` | once, that long after it is set; then removed |
| `at 09:00`, `at 2026-11-30 18:00`, `at 2026-11-30T18:00:00-08:00` | once: the next 09:00, a local time, or an ISO time with a zone; then removed; a time that has passed is refused |
| `cron "*/30 8-16 * * 1-5" [zone]` | wall-clock times (minute hour day month weekday; lists, ranges, steps, names; a day and a weekday both set means either), in the server's zone or the named one (kept with the wake); a time a daylight-saving change skips runs at the next minute, a repeated one once |
| `idle 30m` | once the session has been idle that long, from the end of its last turn (any turn: the agent's, the owner's, an injected one), never from before the wake was set; once per idle stretch (a new one starts when a turn ends) |
| `idle 30m repeat` | as `idle`, then again each 30 minutes after it last fell due while it stays idle (also when its check skipped that run) |
| `fire-only` | only when fired: by the agent, another agent, the owner or a script |

Durations: `90s`, `30m`, `2h`, `1d`, `1h30m`.

### List, Cancel and Fire

- `list` shows each wake, when it falls due next (in the server's zone and from now; an idle wake: when, if the
  session stays idle), when it was last set (its schedule counts from then) and by whom; `show` one whole.
- `cancel` removes a wake and its runs still waiting. A wake has no end date: cancel it when it is no longer needed.
  Unregistering removes all of an agent's wakes.
- `fire` delivers a wake now, any agent's. It skips the check and still waits for an idle session and `min_interval`;
  the prompt says who fired it, and the extra text is quoted as theirs.
- Waiting runs of the same wake merge into the newest; different wakes (even with the same text) and messages never
  merge. A timed run missed while the server was down comes once.
- The owner sets, cancels and fires any agent's wakes: `autocode wake`, `autocode fire`, the Wakes page.

### Checks

A check is a shell command that decides whether a run of a wake is worth a prompt. It costs no model calls, so a
frequent wake with a check is cheap.

- It runs when the wake is due and Autocode is about to deliver (idle, not paused, `min_interval` passed): by the
  plugin, on the agent's machine, in its session's folder (`bash -c`), with OpenCode's environment plus the four
  `AUTOCODE_*` values (so `autocode ...` in it acts as the agent).
- **Exit 0** wakes the agent, with the start of its output (stdout, then stderr; `check_output`, 2000 characters)
  quoted in the prompt.
- **Exit 1** skips this run quietly: no prompt, no model call, and it does not count toward `min_interval`.
- **Any other exit**, or running past `check_timeout` (60 s; then its process group is stopped), is a failed check:
  the run is skipped, and three failures in a row open an alert in the owner's Inbox.
- One check at a time per wake; runs that fall due meanwhile are the same run. Keep checks fast and free of side
  effects: decide, don't do the work.

### Recipes

- Every 30 minutes in work hours on weekdays: `cron "*/30 8-16 * * 1-5" America/Los_Angeles`, with a check.
- A loop spaced from the end of each run: end each run by setting the same wake again with `in 30m`; to stop, don't
  set it again. A daily cron wake can start the loop.
- Wake me when a job ends: a `fire-only` wake, fired by `autocode fire me <wake>` as the job's last command.
- Poll cheaply: `every 10m` with a check. Remind me once: `in 45m` or `at 15:00`. Nudge when idle: `idle 2h`.

## Messages

Messages carry text between agents and the owner: up to 32,000 characters, with an optional subject and `reply_to`
(the ID of the message it answers). To share a file, send its path.

```
autocode_message  action=send  to=team:worker-1  subject="New fold split"  text="Use folds v3 from data/folds.csv."
autocode_message  action=send  to=team:*  text="Stop new runs: GPU maintenance at 14:00."
autocode_message  action=wait  reply_to=m_3f2a...  seconds=180
```

### Send and Delivery

- `to` is an agent ID, a pattern (`team:*`), a comma list, or `owner`. A group never includes the sender. An unknown
  ID alone is refused; in a list, unknown names are skipped and the reply says which.
- A message to `owner` lands in the owner's Inbox; the owner's answer comes back as a message from the owner. The
  owner also sends with `autocode send TO TEXT...` or on the Messages page.
- Messages come whole. While a turn of the agent runs, they go into it at its next step, as
  `[autocode] 1 message, during your turn`; otherwise in an injected prompt, delivered like wakes.
- One prompt carries up to 32,000 characters of messages; more come in the next one.
- To wait for a reply, an agent can also end its turn: the reply wakes it.

### List, Read and Wait

An agent can also take its messages itself:

- `autocode_message action=list` shows what waits (sender, subject, size; no text). It marks nothing.
- `action=read` takes what waits now, whole, oldest first (up to 32,000 characters a call; it says how many more wait).
- `action=wait seconds=120` waits for a message, then reads it: at most `max_tool_wait` (5 minutes); it costs no
  tokens.
- All three take `from=` and `reply_to=`; read and wait also `id=`. A message is read once: what read or wait returned
  never comes in a prompt. `autocode_me action=status` says how many wait.

A message is queued, then read: in a prompt, into a running turn (steer), by the agent's read or wait, or, for one to
the owner, when its Inbox item is answered or closed. It is dropped if its agent unregisters first. The owner's views
(`autocode messages`, the Messages page) never change a state.

### Notices

Notices arrive as messages from `autocode` (`from=autocode` picks them). Their first line says what they are, and they
are Autocode's own text, not quoted: a lock granted, expired, released by the owner, or the agent taken out of its
queue; an ask sent to the agent to answer; the answer to its own approval; a cost warning; a run's result or failure.

### Writing to the Owner

Everything an agent sends the owner (a message, a question, an approval, an escalation's reason) is read by a busy
person. Agents are told to write:

- **Short:** only what the owner needs to know or decide; no background they did not ask for, no restating, no thanks.
- **Point first:** the decision or the news in the first line, then the facts it rests on.
- **Structured:** a short list for several items, one line each; the options, and what it does if no answer comes.
- **Plain:** what it did, found or needs; names, paths and numbers, not adjectives. Details go in a file: send its path.

```
autocode_message  action=send  to=owner  subject="Decision: fold 3"  text="Spend $5 more on fold 3?
- fold 2: 0.912 (target 0.91)
- fold 3: 2 more GPU hours
If no answer by 18:00: I stop after fold 2."
```

## Locks and Semaphores

A lock is shared by every agent on the server, on any machine: a mutex (`max=1`, the default) or a semaphore (`max=N`
places). Agents take one when only one of them (or N) may do something at a time: use a GPU, submit, refresh data.

```
autocode_lock  action=acquire  name=gpu:0  ttl=6h                # queue: a notice says when it is yours
autocode_lock  action=acquire  name=gpu:pool  ttl=6h  max=2      # a semaphore with 2 places
autocode_lock  action=acquire  name=submit  ttl=10m  mode=try    # now or refused
autocode_lock  action=renew  name=gpu:0  ttl=6h
autocode_lock  action=release  name=gpu:0                        # or leave the queue
autocode_lock  action=list  pattern=gpu:*
```

- **`ttl` is required:** how long the agent holds it, from the grant, also while the grant's notice waits for a turn
  to end or the agent is paused: give it room. **Renew** before it runs out (`ttl=` sets a new one from now; by
  default the same). A hold that runs out is freed for the next in the queue, with `[autocode] lock "gpu:0" expired`.
- **Capacity:** the first `acquire` creates the lock with its `max`; later ones may leave it out, and another capacity
  is refused (`lock_capacity`). A lock with no holders and nobody queued is removed.
- **Modes:** `queue` (the default) holds it at once if a place is free and nobody waits; otherwise the agent waits in
  the queue, in arrival order, its turn ends as usual, and `[autocode] lock "gpu:0" granted` comes when it is its
  turn. `try` holds it now or is refused (`lock_busy`, with who holds it).
- **Again:** acquiring a lock it holds renews it; acquiring one it waits for keeps its place, with the new `ttl`.
- Unregistering releases every lock the agent holds and leaves every queue. `autocode_me action=status` shows its own.
- The owner frees any hold or takes an agent out of a queue (`autocode locks release NAME AGENT`, Release and Remove
  on the Locks page). The agent is told (`... released by the owner`, `[autocode] lock "gpu:0": out of the queue`).

## Questions, Permissions and Approvals

A turn can wait for a person: OpenCode's question tool asks something, a tool call needs a permission, or the agent
asks for an approval before a step it must not take alone. Autocode sends each ask where the owner set, and the answer
goes back into the session, where the turn goes on.

### Where Each Ask Goes

| Setting | Values (the default first) |
|---|---|
| `question_mode` | `ask`: the owner's Inbox; `auto`: answered at once with `auto_answer_text`; `agent:<id>`; `job:<name>` |
| `permission_mode` | `ask`: the owner (Allow Once, Allow Always, Reject); `approve`: allowed once, at once; `agent:<id>`; `job:<name>` |
| `approval_mode` | `ask`: the owner; `approve`: approved at once; `agent:<id>`; `job:<name>` |

- `agent:<id>` sends the ask to that agent as a notice. If that agent is not registered, or is the asking agent, it
  goes to the owner; when that agent unregisters, its open asks go back to the owner.
- `job:<name>` starts a run of that job with the ask in its prompt, and the run answers it. If the job cannot start a
  run now (one runs, or there is no such job), the ask goes to the owner; asks still open when the run ends do too.
- The owner sees every ask in the Inbox from the start; the first answer counts, a later one is refused. Only the
  owner allows always. Example: `autocode settings set question_mode agent:team:lead --match 'team:worker-*'`.
- While an ask is open the asking agent is `waiting`: its wakes and messages wait until the ask is answered (also in
  the TUI) or expires.
- An `auto` answer tells the agent to use its best judgement and safe practices: it chooses, goes on, and records what
  it chose. A question written as plain text at the end of a turn is not seen: agents use the question tool.

### Approvals

For anything that spends money, trades, deploys, deletes data or cannot be undone, agents ask for an approval, not a
question. An approval is settled automatically only when the owner set `approval_mode=approve` on purpose.

```
autocode_approval  action=ask  text="Pay the electricity bill: $142.17 from checking"  expires=2d
autocode_approval  action=ask  text="Deploy build 7f3a to production"  options="now, tonight"
autocode_approval  action=wait  id=ask_42  seconds=240
```

- `options`: a comma list. `expires`: 1s to 30d; past it the approval counts as rejected, and the agent is told.
- The answer (approved or rejected, the option, a note) comes as a notice, `[autocode] approval "..." approved`;
  `action=wait` holds the call for it, at most `max_tool_wait`. Agents act only on what was approved.

### Answering for Another Agent

An ask sent to an agent comes as a notice, `[autocode] question from team:worker: "Fold split"` (or `permission for`,
`approval for`), with what it asks and its ID. The agent answers or hands it to the owner:

```
autocode_message  action=answer  id=ask_5f...  text="v3"
autocode_message  action=answer  id=ask_61...  text="reject: not the build folder"     # a permission: once or reject
autocode_message  action=answer  id=ask_63...  text="approve tonight: after 22:00"     # an approval: option, note
autocode_message  action=escalate  id=ask_5f...  text="I do not know which split is current"
```

- A question: an option's name or its own words; one line per question when there are several; a multiple-choice
  question's options separated by commas.
- `escalate` adds its reason to the owner's Inbox item; the owner (or the agent, later) can still answer.

## When Things Fail

Autocode keeps agents going when a model's provider fails or OpenCode restarts, and tells the owner when it cannot.

- **Error state:** a failed turn (the provider is down, times out or limits the agent) puts the agent in `error`. Its
  wakes and messages wait. `autocode_me action=status`, the Agents page and `autocode agents --json` show the error,
  since when it fails, the retries sent and the next.
- **Retries:** every `retry_interval` (1 minute) a retry prompt comes with what waited: `[autocode] retry 2`, then
  "Your last turn failed: provider.internal (...). Continue where you left off." `min_interval` does not apply. A turn
  that succeeds ends the error state. With `retry_attempts` set (0: no limit), an Inbox alert says when they ran out.
- **Not retried:** errors that fail the same way again (`provider.auth`, `provider.invalid-request`,
  `provider.content-filter`, `provider.unknown`, `provider.unsupported-operation`); an Inbox alert says so. Fix the
  cause (a key, the model's name), then **Retry** on the Agents page or `autocode retry AGENT`, which also works after
  the retries ran out.
- **Alerts close by themselves:** both alerts close once the agent works again.
- **OpenCode restarts:** a turn cut by an OpenCode restart (`turn.cut` in History) is resumed once that OpenCode is
  back, with `[autocode] resume`: "Your last turn was cut off (its OpenCode server restarted). Continue where you left
  off."
- **A gone OpenCode:** the machine's background service (`opencode serve --service`) is started again
  (`opencode.restarted`); any other OpenCode gets an Inbox alert: start it yourself.
- **Unloaded folders:** a folder the background service unloaded is loaded again when the server has work for it on
  its own machine; hosts on other machines wait until their folder is used. A plugin that loses the server retries
  with growing waits, up to 30 s.

## Costs and Context

Autocode counts each agent's spend, can cap it per day, and compacts long sessions so that each wake stays cheap.

### Spend and the Daily Cap

- Each model step of an agent (its Subagents' too) counts toward its spend today, in the server's zone, and so do
  the steps of the runs it counts for ([Whom a Run's Cost Counts For](#whom-a-runs-cost-counts-for)).
- `autocode_me action=status` shows the agent its spend today and in total, its cap and what is left, and its context
  with its compaction threshold and the share used. The owner sees the same for every agent, live, also for agents
  that unregistered: the web UI's **Costs** tab and `autocode costs`.
- `daily_usd` (off by default) caps the spend per day. At `cap_warn` of it (90%) the agent gets
  `[autocode] cost warning`, once a day.
- Past the cap the running turn may finish; then the agent is paused by `cap` (an Inbox alert says how much) until the
  next day, until the owner raises its cap (`autocode settings set daily_usd 20 --agent ID`), or resumes it.

### Compaction

Each wake re-reads the whole context, so a long one costs more per wake. Past `compact_at` a session is compacted
between turns: a summary replaces the conversation.

- `compact_at`: by default `50% max 500000` (half the model's window, at most 500,000 tokens). Tokens, a share of the
  window (with `max N`, at most N), or `off`. Without a known window, a share means its `max`, or 500,000.
- The agent is told first: `[autocode] compaction next`, with its context and the threshold, is a prompt of its own,
  and the compaction comes when that turn ends. It comes as soon as the context passes the threshold: into a running
  turn too (`compaction next, during your turn`), and to an idle agent even when nothing waits for it (say after the
  owner's turns in the TUI; then at most once per `min_interval`). Not in the error state.
- In that turn the agent brings its work to a stable state and writes down in files what it needs: the task, where it
  is, decisions, open points. What waits comes after the compaction.
- `autocode_me action=compact` asks for one after the current turn, with no notice. History shows
  `session.compact.noticed` and `session.compacted`.
- So agents keep their working state in files (a task list, notes, a checkpoint), not only in the conversation.

An agent is unregistered `expire_after` (14 days) after its session's last turn, and when its session is deleted.

## Jobs and Runs

A job is a task for a fresh agent: the owner sets it on a host with a model, a prompt and a trigger. Each run is a
fresh session there, registered under the run's ID: the job's name and its start minute in UTC, like
`daily-report:2026-11-08T17:00`.

### Define a Job

```sh
autocode job set daily-report --host <host> --model openai/gpt-5 --prompt "Write the daily report." \
  --trigger 'cron "0 9 * * 1-5"' --to owner --timeout 1h --run-usd 2
```

| Flag | Meaning |
|---|---|
| `--host` | where it runs: a host ID from `autocode hosts` |
| `--model` | `provider/model`; `--variant` and `--agent` (an OpenCode agent) are optional |
| `--prompt` | what the run is told, up to 32,000 characters |
| `--trigger` | `every`, `at`, `cron` or `fire-only` (no schedule: started by the owner, an agent or an ask) |
| `--to` | where results go: `owner` (the default), an agent, a pattern or a list |
| `--timeout` | the run's time limit, 1m to 7d (default 1h) |
| `--run-usd` | the run's cost cap in dollars (default off) |
| `--keep-session` | keep a finished run's session (by default it is removed) |
| `--description` | a line agents see in `autocode_me action=jobs` |

The Jobs page does the same: Set a Job, Edit, Run Now, Delete.

### Start Runs

- A job has one run at a time: a scheduled run while one works is `skipped`; one asked for is refused, with the
  running run's ID and who started it.
- The schedule starts runs on the trigger; the owner with `autocode job run NAME [--text T]` or Run Now.
- Any agent starts one with `autocode_me action=run job=NAME text=...` (its text is added to the prompt, marked as its
  own). The result comes back to it as a notice, `[autocode] result of run NAME:...`.
- An ask routed to `job:<name>` starts a run that answers it with `autocode_message action=answer`, then finishes.
- A run whose host is offline waits for it (an unloaded folder is loaded again), up to its time limit.

### Whom a Run's Cost Counts For

Each run's spend counts in exactly one row of the Costs tab, `/v1/costs` and `autocode costs`, so their totals are the
true spend. Which row is fixed when the run starts:

| The run | Its cost counts for |
|---|---|
| of a job an agent set | that agent, whoever started the run (scheduled runs too) |
| started by an agent | that agent |
| started by another run | whom that run counts for (up the chain to the first agent) |
| started by an ask (`job:<name>`) | the agent that asked |
| started by the owner or a schedule | the job's own row, `job:<name>` (Today, Last 7 Days, Total, Days) |

- An agent's runs count toward its Today, Daily Cap, Last 7 Days and Total, and its `daily_usd`: its cap's notice and
  pause apply to it (paused once no turn of its own runs); the run goes on to its own `run_usd` and time limit.
- No row is a single run's. The tooltip on an agent's Today and Total, `autocode_me action=status` and `autocode costs
  AGENT` say how much of its spend was its runs'.
- Each run's own cost stays on the Jobs page (`autocode job runs`), and `run_usd` caps it.
- IDs that start with `job:` are reserved for the jobs' rows.

### Jobs That Agents Set

An agent can set jobs of its own, with `autocode_me action=job_set`:

```
autocode_me  action=job_set  job=digest  model=openai/gpt-5  trigger='cron "0 9 * * 1-5"'  run_usd=2  prompt="Write the digest of incoming/ into digest.md."
autocode_me  action=run  job=digest
autocode_me  action=job_delete  job=digest
```

- Its name becomes `<agent>:<name>` (`team:lead:digest`), so the owner's rules for that ID pattern apply to its runs.
  `run` finds it by either name.
- `run_usd` is required. The host is the agent's own folder unless it names one; results go to the agent unless `to`
  says otherwise.
- `job_mode` (per agent or pattern) decides: `ask` (the default) puts an approval in the owner's Inbox with the whole
  definition and prompt, and the job exists only once the owner approves it; `approve` sets it at once; `off` refuses.
  The agent is told by the approval's notice (`[autocode] approval "Job team:lead:digest" approved`); meanwhile it
  goes on with its work (a proposal does not make it `waiting`), and a new proposal of the same job replaces it.
- Changing a job asks again; it stays as it was until approved.
- The job records its creator (Set By on the Jobs page, SET BY in `autocode job list`); all its runs count for the
  creator. `job_delete` deletes one of the agent's own; all of them go when the creator unregisters. The owner can
  edit or delete them like any job.

### How a Run Ends

- Its prompt ends by saying it is a run of a job. It does the work, then `autocode_me action=finish result="..."`. If
  it ends a turn with nothing waiting and without `finish`, its last reply is the result.
- The result goes to the agent that started it, else to the job's `--to` (the owner's Inbox for `owner`). A long result
  is cut in the message; the whole stays in the run (`autocode job runs NAME --json`, the Jobs page).
- Then its agent is unregistered and, unless `--keep-session`, its session removed. Nothing in its session survives:
  a run writes what is worth keeping to files in its folder.
- A run fails past its time limit or `run_usd`, when its session cannot start, or when its turn fails and is not
  retried. The owner gets an alert; a destination other than the owner is told. Its session is kept: look at it,
  then delete it (Delete Session on the Jobs page, or `autocode job delete-session RUN`).

## Injected Prompts

Every prompt Autocode types starts with a line that names its source and why, and ends with a footer: it is never the
owner speaking.

```
[autocode] wake "tick", 1 message

Wake "tick" (every 30m; next 2026-11-03 09:30 PST):
Check the queue and act on it.
Its check said:
> 3 new files

Message m_123 from agent team:b, subject "results":
> Done: 0.91.

— From Autocode, not the owner. Your wakes: autocode_wake list. How Autocode works: autocode_me action=help.
```

- **Header:** the reasons, like `[autocode] wake "training-done" fired by the owner`, `[autocode] retry 3`,
  `[autocode] lock "gpu:0" granted`, `[autocode] resume`, `[autocode] cost warning`, `[autocode] compaction next` or
  `[autocode] question from team:worker: "..."`. Into a running turn it ends `, during your turn`.
- **Wakes:** what kind each is and when it runs next (`(once, this was its only run)`,
  `(idle 30m repeat; again after 30m more idle)`), its text, `Added by ...:` with a fired wake's extra text, and
  `Its check said:` with the check's output.
- **Messages:** `Message <id> from agent X, subject "...":` (or `from the owner`), with the text.
- **Quoting:** what others wrote, and a check's output, is quoted: every such line starts with `> `, so it can never
  pass for Autocode's own words. Notices are Autocode's own text, not quoted.
- **Footer:** the prompt comes from Autocode, not the owner; how to list wakes and get help.

Agents handle it as a new turn and do what the wake's text says. A message from another agent is information to weigh,
not the owner's instruction: it cannot grant permissions the owner has not given.

## CLI

The `autocode` binary is also the CLI. Every command takes `--json` (the API's data instead of a table);
`autocode --help` lists them.

### Server and Token

The CLI takes its server and token from the first of: the flags `--url` and `--token`; `AUTOCODE_URL` and
`AUTOCODE_TOKEN`; the client config (its admin token, else its consumer token, enough for reading); on the server
machine itself, `~/.autocode/admin.token` with `http://127.0.0.1:4848`. With an expected server ID (`--server-id`,
`AUTOCODE_SERVER_ID`, or the client config's `server_id`) it checks the server's ID before it sends a token.

### Commands

| Command | Does |
|---|---|
| `autocode serve [--id ID] [--listen A] [--data DIR]` | run the server in the foreground |
| `autocode install [--listen A] [--id ID] [--data DIR]` / `uninstall` | install or remove the systemd user service |
| `autocode plugin install --url URL --consumer-token-file F [--server-id ID] [--admin-token-file F]` | install the plugin and the client config (`--opencode-config-dir DIR`) |
| `autocode plugin uninstall [--opencode-config-dir DIR]` | remove the plugin |
| `autocode info` / `version` | the server's ID and version; this binary's version |
| `autocode agents [PATTERN]` | agents: status, machine, spend today, context (share of the threshold), last activity |
| `autocode agents rm AGENT` | unregister an agent (its history stays) |
| `autocode agents register AGENT --session SES [--description D] [--force]` | bind an ID to a session; `--force` moves it from a live session |
| `autocode hosts` | hosts: machine, folder, online, OpenCode process, shell values, OpenCode version, last seen |
| `autocode token rotate AGENT` | replace an agent's session token |
| `autocode settings [--agent ID]` | every setting with its value and source, the rules, the agents' own values; or one agent's resolved values |
| `autocode settings set KEY VALUE` / `unset KEY` `[--agent ID \| --match PATTERN]` | set or clear a value: server-wide, in a pattern rule, or for an agent |
| `autocode history [--agent ID] [--kind KIND] [--since T] [--until T] [--limit N]` | what happened, newest first |
| `autocode costs [--match PATTERN] [--days X]` | every agent's spend today and in total (unregistered ones too, and the totals), cap and what is left, context and threshold; `--days X`: totals over the last X days |
| `autocode costs AGENT` | one agent's spend, cap and context, and its spend per day |
| `autocode inbox [--all]` | open Inbox items (`--all`: closed ones too); TO says whom an ask went to |
| `autocode answer ID TEXT...` | answer a message, a question, a permission (`once`, `always`, `reject: why`) or an approval (`approve` or `reject`, an option, a note) |
| `autocode inbox close ID` | close an alert, or a message you will not answer |
| `autocode pause AGENT` / `resume AGENT` | stop or restart an agent's injections (wakes and messages keep waiting) |
| `autocode retry AGENT` | retry an agent in the error state now |
| `autocode stop-all` / `resume-all` | pause every agent and interrupt every turn; resume what stop-all paused (your own pauses stay) |
| `autocode wakes [AGENT]` | every wake (agent, name, trigger, next, check, last set, text), or one agent's |
| `autocode wake set AGENT NAME --trigger T --text TEXT [--check CMD]` / `wake cancel AGENT NAME` | set or replace a wake; cancel one |
| `autocode fire AGENT WAKE [--text TEXT]` | deliver a wake now (it skips its check); the prompt says the owner fired it |
| `autocode send TO TEXT... [--subject S] [--reply-to ID]` | send as the owner to an ID, a pattern or a list |
| `autocode messages` / `messages read ID` | every message, newest first, with its state; one whole (no state changes) |
| `autocode locks [PATTERN]` / `locks release NAME AGENT` | every lock: capacity, holders and expiry, the queue; free a hold or a queue place |
| `autocode job set NAME --host H --model M --prompt P --trigger T [...]` | define or replace a job ([Jobs and Runs](#jobs-and-runs)) |
| `autocode job list` / `job run NAME [--text T]` / `job runs [NAME]` | the jobs with next and last runs; start a run; the runs (by, state, start, cost, result) |
| `autocode job delete NAME` / `job delete-session RUN` | delete a job (its runs' history stays); delete a failed run's kept session |

### In an Agent's Shell

A shell OpenCode started for a session is an agent's shell. There the CLI acts as that agent and never uses the
owner's or the consumer token. It has `me`, `fire me` and `send`, plus the machine's setup commands (`info`, `serve`,
`install`, `uninstall`, `plugin`); the rest is refused unless a token is passed with `--token`. Your own `!` commands
in an agent's session count as its shell once the session has run a shell.

Exit codes: 0 done, 1 refused or failed, 2 wrong usage, 3 the server cannot be reached.

## Web UI

The web UI shows the owner every agent, wake, message, lock, job and cost, with the owner's controls. Light and dark.

### Sign In and Behavior

- Sign in at `http://<server>:4848/` with the admin token; the consumer and session tokens are refused. It is kept for
  that tab, or on that browser with **Stay signed in**, until **Sign Out**. A token the server stops accepting sends
  you back to sign-in. Other sites cannot frame the UI.
- Lists load again every 10 s (Costs every 5 s); the footer says how long ago. An action's result shows in the toolbar.
- An agent's or host's ID links to its page, which highlights its row (a filter that would hide it goes).
- Dates read like `05-Nov-26`, times like `05-Nov-26 14:22:03 PT`, in your browser's zone; the Costs tab's days, and
  when its data was read, are the server's.
- Every table shows 25 rows at first; the "..." row at its end shows 25 more. Agents, Hosts and Wakes are grouped (by
  machine, by agent), 25 rows a group: a click on a group's heading folds or opens it, the browser remembers it, and a
  link to a row opens its group.
- Pattern filters apply a second after you stop typing (Enter at once); History, Costs and Locks keep theirs in the
  address.

### Pages

- **Hosts:** each OpenCode server folder the plugin connects from, by machine: status, the OpenCode process (the
  background service, or `opencode serve`, also the private one a TUI or `opencode run` starts with `--standalone` or
  with the service off; with its process ID), versions, last seen. **no shell values**: that server's shells get no
  Autocode values ([Troubleshooting](#troubleshooting)). Offline hosts only with the **Offline** box (a link to an
  offline host turns it on). A TUI attaches to the background service by default, so its folders stay online after it
  exits.
- **Agents:** by machine: status, model, spend today and in total (a click shows it on Costs), context as
  now/threshold/window (`854K/777K/1M`; exact tokens in its tooltip) with a bar of the threshold's share (amber from
  75%, red from 100%; the window's share without a threshold), host, folder, session, times. A paused agent's
  tooltip says who paused it; an agent in error shows its error and retries (`retry 3 in 40s`, `retrying now`,
  `not retried`, `retries ran out`). Edit a description, **Pause**, **Resume**, **Retry**, **New Token**,
  **Unregister**; **Stop All** (after you confirm) and **Resume All**. A pattern filter and an **Unregistered** box
  (off by default: gone agents too, dimmed, with spend).
- **Inbox:** messages to you, alerts, and asks (questions, permission prompts and approvals a turn waits for), each
  answered here. **Sent To** says whom an ask went to; an agent that escalates adds a note. A question: click an
  option, or write your words and **Answer**. A permission: **Allow Once**, **Allow Always** (OpenCode saves the rule
  for the project) or **Reject**, with a reason. An approval: an option, a note, **Approve** or **Reject**; one that
  may expire says when. **Answer** a message, or **Close** a message or an alert. **Closed** adds the closed ones. The
  Kind is colored: message green, alert red, question sky blue, permission amber, approval violet.
- **Messages:** every message not read yet (the **Read** box adds the read ones), newest first: ID, sender, recipient,
  subject, the first 200 characters (a click shows it whole, as markdown) and its state (queued; read, with how:
  prompt, steer, read, wait or inbox; dropped). Viewing leaves the state. **Send a Message** sends as the owner.
- **Locks:** every lock (Mutex or N places), its holders and when each hold runs out (**Release**), its queue in order
  (**Remove**); both after you confirm, and the agent is told. A **Lock** filter.
- **Wakes:** every agent's wakes: trigger, next run, text and check (a click shows a long one whole), who set it,
  **Last Set** (its schedule counts from then), last fired. **Fire**, **Cancel**, **Set a Wake** for any agent.
- **Jobs:** the jobs (where, model, trigger, next run, where results go, Last Run, **Set By**: the owner or the agent
  that set it) with **Run Now** (and text), **Edit**, **Delete**, and **Set a Job** on an online host. Below, the
  runs, newest first: who started it, state, times, its own cost, result, why one failed or was skipped; **Delete
  Session** for a failed run's kept session. A link to a job (from Costs) highlights it.
- **Costs:** every agent's status, spend today and in total (its runs' with it: the tooltip says how much), daily cap
  with a bar of the share spent, and **Last 7 Days** (a bar per day, today at the right; hover for the value). A
  job's runs that no agent started have the job's row, `job:<name>` (status `job`; its ID leads to the job). **Days**
  shows a row's spend per day. An **Agent** filter, a **Days** field (totals over the last X days; empty: all time),
  an **Unregistered** box (on by default; job rows stay) and a totals row: the true spend, each cost in one row.
- **History:** every event, newest first: time, kind, agent, host, session, data (a click shows it whole). An
  **Agent** filter and a **Kind** list (one kind with its count, or a group like `wake.*`). Past the loaded rows, the
  "..." row fetches the next 100 from the server.
- **Settings:** server-wide values (**Save**, or **Reset** to the default), pattern rules (edit, move, remove),
  agents' own values, and **Resolved for an Agent**. A mode setting lists its values; Agent... or Job... picks one.
- **Help:** how to use Autocode from OpenCode, the CLI and the web UI.

## Settings

Settings tune delivery, asks, retries, costs and the server. Change them with `autocode settings set` or on the
Settings page.

### Layers

An agent's value comes from the first that has one: its own value (`--agent ID`); the first pattern rule that matches
its ID (`--match PATTERN`; a new rule goes last); the server-wide value; the built-in default. Settings of scope
`server` exist only server-wide. `autocode settings --agent ID` shows an agent's values and where each comes from.

### All Settings

| Setting | Scope | Default | What it does |
|---|---|---|---|
| `min_interval` | agent | `1m` | at most one prompt per session this often |
| `check_timeout` | agent | `60s` | a wake's check is stopped after this long |
| `check_output` | agent | `2000` | characters of a check's output put into the prompt |
| `max_tool_wait` | agent | `5m` | the longest a tool waits inside a turn (message `wait`, approval `wait`; in steps of at most 240 s) |
| `question_mode` | agent | `ask` | questions: to the owner (`ask`), answered at once (`auto`), `agent:<id>` or `job:<name>` |
| `auto_answer_text` | agent | "Act according to your best judgement and safe practices to achieve my goals." | the answer in `auto` mode |
| `permission_mode` | agent | `ask` | permission prompts: to the owner (`ask`), allowed once (`approve`), `agent:<id>` or `job:<name>` |
| `approval_mode` | agent | `ask` | approvals: to the owner (`ask`), approved at once (`approve`), `agent:<id>` or `job:<name>` |
| `job_mode` | agent | `ask` | jobs an agent sets: the owner approves first (`ask`), set at once (`approve`), or refused (`off`) |
| `retry_interval` | agent | `1m` | the wait after a failed turn before a retry prompt, and between retries |
| `retry_attempts` | agent | `0` | the most retries in a row before Autocode stops and tells the owner (0: no limit) |
| `daily_usd` | agent | `off` | the agent's cost cap per day, in dollars (`12.50` or `$12.50`), or `off` |
| `cap_warn` | agent | `90%` | warn the agent at this share of its cap |
| `compact_at` | agent | `50% max 500000` | compact between turns past this context: tokens (at least 10000), a share of the window (`90%`; with `max N`, at most N), or `off` |
| `expire_after` | agent | `14d` | unregister an agent this long after its session's last turn |
| `history_days` | server | `30` | days of history kept, with message texts, settled injections and closed Inbox items |
| `timezone` | server | the machine's | days for caps and costs; the default zone of `at` and `cron` wakes (a cron wake keeps the zone it was set with) |
| `listen` | server | `localhost,tailscale:4848` | addresses and port to listen on; takes effect at the next start |

Durations look like `90s`, `5m` or `1h30m`.

```sh
autocode settings set min_interval 5m                                        # server-wide
autocode settings set question_mode agent:team:lead --match 'team:worker-*'  # a pattern rule
autocode settings set daily_usd 20 --agent team:lead                         # one agent
autocode settings unset daily_usd --agent team:lead
```

## Files, Tokens and Backups

Everything of an install lives in one folder, the Autocode home: `~/.autocode/`, or the folder `AUTOCODE_HOME` names.

### Where Things Live

| In the home | What |
|---|---|
| `autocode.db` | the server's data (SQLite in WAL mode) |
| `admin.token`, `consumer.token` | the owner's tokens (0600) |
| `config.json` | the server's optional config (`{"id": "..."}`) |
| `bin/autocode` | the installed binary |
| `client.json` | the machine's client config: server URL, tokens, expected server ID |
| `logs/plugin.log` | the plugin's log |

Only two files live elsewhere: the unit `~/.config/systemd/user/autocode.service` and the plugin in OpenCode's plugin
folder. Folders made for a home are 0700.

### Tokens

| Token | Created | Kept in | Used by |
|---|---|---|---|
| admin | the server's first start | `admin.token` on the server | the owner's CLI and web UI: full control |
| consumer | the server's first start | `consumer.token` on the server | the plugin's channel; the owner's CLI for reading where the client config has no admin token; not the web UI. It can act for any session: keep it secret |
| session | the plugin, for each top-level session | the plugin's storage; the session's shells | that session's tools and scripts |

- The first start prints the admin and consumer tokens once on a terminal; a service's log gets only where they are
  saved. The database keeps only hashes. Lost the admin token: read `~/.autocode/admin.token` on the server.
- For automation, `AUTOCODE_ADMIN_TOKEN` and `AUTOCODE_CONSUMER_TOKEN` (an `aca_` or `acc_` prefix and at least 32
  more characters) set the tokens at the first start.
- A session token survives plugin reloads and deploys (History shows `session.token` only for a new one). One unused
  for 30 days is revoked; a running job keeps the one it started with while it uses it.
- `autocode token rotate AGENT` (**New Token** on Agents) replaces a leaked one: the old one stops working at once,
  and the plugin puts the new one into the session's shell environment (running shells keep the dead one). Rotating
  and unregistering revoke all of a session's tokens.

### Backups and History

- Back up `autocode.db`, `admin.token`, `consumer.token` and `config.json`: with the service stopped
  (`systemctl --user stop autocode`), or while it runs with `sqlite3 autocode.db ".backup copy.db"`.
- History older than `history_days` (30) is deleted automatically, with message texts, settled injections, closed
  Inbox items and ended runs. Spend per day is kept at least 31 days, and each agent's total past that.

## Troubleshooting

Find the symptom, then the check.

| Symptom | Check |
|---|---|
| An agent seems to ignore Autocode | Ask it to load the `autocode` skill, or to call `autocode_me action=help`. |
| A wake does not come | Is the agent paused, offline, `waiting` or in error (it comes with the next retry)? Is its session busy? Does its check skip (exit 1) or fail? Was the last prompt less than `min_interval` ago? The Wakes page shows its next run and last fire. |
| `autocode hosts` shows nothing for a machine | The plugin loads with a folder only when that folder is used: open it in a TUI or send a prompt. Read `~/.autocode/logs/plugin.log`. |
| Plugin log: "no client config" | Run `autocode plugin install` on that machine. |
| Plugin log: "the server at ... is X, not Y" | The client config's `server_id` does not match the server: fix the config or the server ID. |
| A host is `online no` | The network or Tailscale between that machine and the server; the plugin retries with growing waits (up to 30 s). |
| Plugin log: "superseded by a newer instance" | Two OpenCode processes use the same folder and data folder: the newest holds the channel; the older takes over when it is gone. Tools and shell values work in both. |
| An agent shows `offline` | Its host is offline, or its session was deleted (the ID can move to another session). |
| An agent shows `waiting` | It has an open ask: `autocode inbox` shows it (TO: when it went to another agent). Its wakes and messages wait until it is answered (also in the TUI) or expires. |
| An agent shows `error` | Its last turn failed: see [When Things Fail](#when-things-fail). Fix a cause that is not retried, then **Retry** or `autocode retry AGENT`. |
| An agent is paused by `cap` | It passed `daily_usd` today: paused until the next day, a higher cap (`autocode settings set daily_usd 20 --agent ID`), or Resume. |
| A session's context grows without end | It is compacted past `compact_at` after a `compaction next` notice, unless `compact_at` is `off` for it. History: `session.compact.noticed`, `session.compacted`. |
| OpenCode was restarted under a turn | The turn is cut (`turn.cut`) and resumed with `[autocode] resume` once its OpenCode is back. A gone background service is started again; any other OpenCode: start it yourself. |
| A lock stays held | `autocode locks` shows the holder and when the hold runs out; it is freed then, or at once with `autocode locks release NAME AGENT`. Unregistering releases an agent's locks. |
| A run failed | Its alert says why (the time limit, `run_usd`, the session could not start). Its session is kept: look at it, then Delete Session or `autocode job delete-session RUN`. A scheduled run while one works is `skipped`. |
| Registering says `id_taken` | Another session that still exists holds the ID: unregister it there, delete that session, or `autocode agents register ID --session SES --force`. |
| A tool says `session_gone` | The session was deleted in OpenCode; a deleted session never gets a token again. |
| A shell has no `AUTOCODE_TOKEN` | The plugin sets shell values through its OpenCode server's local API. Hosts shows **no shell values** (`autocode hosts`: SHELL VALUES `no`) when it cannot reach it: a standalone server (`opencode run --standalone`, a TUI with the service off), or `opencode serve` without `--port` or `OPENCODE_SERVER_PASSWORD`. Use the background service, or `opencode serve` with both. Otherwise the server was unreachable at the first shell: open a new one. The CLI there refuses to run; use the tools, or pass `--token`. |
| The CLI says "the server at ... is X, not Y" | The URL answers with another server ID than expected; no token was sent. |
| `autocode install` waits and fails | `journalctl --user -u autocode`: a port already in use, or a bad `--listen`. |

## Development

Autocode is one TypeScript codebase on [Bun](https://bun.sh). This section is for people who change or build it.

### Layout

| Path | What |
|---|---|
| `shared/` | IDs, patterns, durations, triggers, settings, the version |
| `server/` | the server: store, scheduler, delivery, asks, locks, jobs, costs, the API |
| `plugin/` | the OpenCode plugin and the agent tools |
| `cli/` | the CLI, `serve`, `install`, `plugin install`; one binary per platform with the plugin and web UI inside |
| `web/` | the web UI (Angular) |
| `autocode.consumer.agent.md` | the agent guide: the `autocode` skill and `autocode_me action=help` |
| `tests/`, `ci/` | the tests (`unit`, `api`, `plugin`, `e2e`, `restart`, `install`, `web`); the CI runner, Compose files, images, the fake model server, the agents suite |

### Build and Test

```sh
bun install
bun run typecheck && bun run lint
bun test tests/unit tests/api            # fast, no Docker
ci/run.sh [suite...]                     # the Docker suites in parallel (default: all)
ci/dist.sh                               # a numbered build with the web UI: dist/autocode (v1.0.0-rc2-build<n>)
AUTOCODE_TARGETS=all ci/dist.sh          # also linux-arm64, linux-x64, darwin-arm64
```

- `ci/dist.sh` builds the web UI in Docker first and takes the next build number from a counter on the CI host; the
  binaries CI builds for its tests are not numbered (`-dev`). `serve --web-dir DIR` serves a web UI build from a folder.
- Development copies and runs live in `~/.autocode-dev/` (0700), never in `~/.autocode/`. `ci/dev.sh` mirrors the
  source to a CI host and runs commands there.
- `ci/live-server.sh start|stop|restart|status` runs an install's server in tmux, with the home's `bin/autocode`, its
  data and `logs/serve.log` (`LIVE_LISTEN`, `LIVE_ID`); a host keeps its copy in `~/.autocode-dev/live-server.sh`.

### CI Suites

`ci/run.sh` runs each suite as its own Compose project, `CI_PARALLEL` at a time (default 4). Real OpenCode runs against
a scripted fake model server, so no automated test spends money.

- **`unit`:** type checks, lint, and pure logic: IDs, patterns, durations, settings, the store, plugin parts.
- **`api`:** every route of the server in-process, with a fake clock; the plugin's channel; the CLI as a process.
- **`plugin`:** checks against real OpenCode. **`one`:** end-to-end with one OpenCode machine.
- **`two`:** the same across two machines, plus a lost machine, a returning one and a network cut.
- **`restart`:** the server restarted on its volume; an OpenCode machine restarted.
- **`install`:** `autocode install` and `uninstall` as a systemd user service, and a reboot.
- **`web`:** the web UI's unit tests and browser checks against a real server (`CI_GREP` filters them).
- **`agents`:** real models (`ci/agents/models.json`) must use Autocode correctly from plain requests; it runs on the
  host with the owner's OpenCode provider settings, isolated from the owner's sessions, about $1 a run.
- **`ci/mac-check.sh`:** the macOS binary, paths, and `autocode plugin install` into a throwaway config, on a Mac.

Code style: Biome; lines within 80 columns; a header comment on every file; tests first.
