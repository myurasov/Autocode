# Autocode Reference <!-- omit in toc -->

Autocode is a long-term autonomy support framework for AI coding agents in [OpenCode](https://opencode.ai). It
gives them what they need to work on their own for days or weeks, alone or as a team, and keeps them under your
control.

This is the reference: every feature, command, file, setting and default. It is written for the owner, the person who
installs and runs Autocode. For a short tour, see [`README.md`](README.md).

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
- [Operate](#operate): [Upgrade](#upgrade), [Roll Back](#roll-back), [Move the Server](#move-the-server),
  [Replace a Leaked Token](#replace-a-leaked-token), [Stop an Agent That Overspends](#stop-an-agent-that-overspends),
  [Shrink the Database](#shrink-the-database)
- [Troubleshooting](#troubleshooting): [sign-in](#i-cannot-sign-in), [the server](#the-server-does-not-start),
  [after a reboot](#agents-did-not-come-back-after-a-reboot),
  [an offline host](#a-host-is-offline-though-opencode-runs), [missing tools](#the-tools-are-missing),
  ["too old"](#a-host-is-marked-too-old), ["no shell values"](#a-host-is-marked-no-shell-values),
  [the plugin's log](#lines-in-the-plugins-log), [a wake](#a-wake-does-not-come),
  [a message](#a-message-does-not-arrive), [an agent's status](#an-agent-is-not-idle-or-working),
  [other symptoms](#other-symptoms)
- [Development](#development)

## Overview

An OpenCode session that registers with Autocode becomes an agent. Each feature is there so that agents can work
for a long time with nobody watching: wakes bring an agent back to its work, messages and locks let agents work
together, retries and compaction get them past failures, jobs hand tasks to fresh agents, and your Inbox, cost caps
and Stop All keep them under your control. You watch and control all of it from a web UI and a command-line tool.

### The Parts

One `autocode` binary holds all four parts.

- **Server:** one per installation. It keeps agents, wakes, messages, your Inbox, locks, jobs, settings and history
  in one SQLite database. It looks for due work about once a second, and serves the API and the web UI.
- **Plugin:** runs inside OpenCode on each machine. `autocode plugin install` puts it into OpenCode's config folder
  as one file, `plugins/autocode/index.js`. It connects every project folder that OpenCode opens to the server. It
  reports turns and costs, runs the checks of wakes, types Autocode's prompts into sessions, and gives sessions the
  `autocode_*` tools and the `autocode` skill.
- **CLI:** the `autocode` command: your commands, and three commands for the scripts that agents start.
- **Web UI:** served by the server. You sign in with the admin token.

The plugin calls the server; the server never connects to another machine. So only the server's address and port
must be reachable from each machine.

### Words Used Here

| Word | Meaning |
|---|---|
| owner | you, the person who runs Autocode. You sign in with the admin token. As an address, `owner` is your Inbox |
| server | the Autocode server. Its ID is a name you choose; machines refuse a server with another ID |
| session | one OpenCode conversation |
| turn | one round of work in a session: from a prompt until the model stops and waits |
| step | one model call inside a turn |
| agent | a session that has registered with Autocode under an ID such as `kaggle:lead` |
| Subagent | a helper session that an agent starts with OpenCode's own subagent tool. It acts for its agent |
| host | one project folder that an OpenCode server has open, on one machine. A machine usually has several hosts. A host is not a machine |
| wake | a prompt that Autocode types into an agent's session later, on a schedule or when it has been idle |
| check | a shell command attached to a wake. Its exit code decides whether the wake is worth a prompt |
| fire | deliver a wake now |
| message | text that one agent, or the owner, sends to another agent or to the owner |
| notice | a line that Autocode itself sends to an agent: a lock was granted, an approval was answered. Its sender is `autocode` |
| Inbox | where everything for the owner lands: messages, alerts and asks. A tab of the web UI, and `autocode inbox` |
| alert | an Inbox item that Autocode raises for the owner when something needs attention |
| ask | a question, a permission prompt or an approval that an agent waits on. Meanwhile the agent is `waiting` |
| Stop All | pauses every agent and interrupts every running turn. A button on the Agents tab, and `autocode stop-all` |
| lock | a named mutex or semaphore that agents on every machine share |
| job | a saved task: a prompt, a model, a host and a trigger |
| run | one execution of a job, in a fresh session that is an agent for as long as the run lasts. The word is used for nothing else here: a wake falls due, is fired, is delivered |
| context | everything the model reads again at each step, measured in tokens. The model's window is the most context that the model can hold |
| compaction | OpenCode replaces the older part of a session with a summary, so that the session can go on. Autocode starts it past `compact_at` |
| token | two things. A secret: the admin token, the consumer token, a session token (see [Tokens](#tokens)). A size: context tokens, as in "500K tokens" |
| TUI | OpenCode's terminal interface, where you talk to a session |
| background service | the OpenCode server that runs without a terminal (`opencode serve --service`). A TUI attaches to it by default |
| Autocode home | the folder that holds everything of an install: `~/.autocode/`. The server keeps its data there unless `--data` names another folder |
| client config | `~/.autocode/client.json` on a machine: the server's URL and the tokens that the plugin and the CLI use there |

### Agent Statuses

An agent has one status: the first of these that applies, in this order.

| Status | Means |
|---|---|
| `offline` | its host is offline, or its session was deleted in OpenCode |
| `paused` | Autocode types nothing into it. Paused by you (`owner`), by Stop All (`stop-all`) or by its daily cap (`cap`) |
| `waiting` | an ask of its own is open |
| `working` | a turn runs |
| `error` | its last turn failed. Autocode retries it, unless the error is one that is not retried |
| `idle` | no turn runs. Autocode can type a prompt |

What to do about each: [An Agent Is Not Idle or Working](#an-agent-is-not-idle-or-working).

A host is `online` while its plugin is connected. The server marks it `offline` when it has heard nothing from the
plugin for 65 seconds. A host whose OpenCode is older than 2.3.0 is refused: it is always offline, and marked "too
old".

### How Delivery Works

Autocode types a prompt into an agent's session only when all of these hold:

1. No turn runs in the session: it is idle.
2. The agent is not paused, and none of its asks is open.
3. Its host is online.
4. The last prompt was at least `min_interval` ago (1 minute by default).

Whatever falls due meanwhile waits. Then it arrives together, in one prompt that starts with `[autocode]`.

- **Messages and notices do not wait for an idle session.** While a turn of the agent runs, they join it at its next
  step: after the tool call or model step that runs now. So a long tool call holds them until it ends. OpenCode
  calls this steer delivery. Rules 2 and 3 still apply: a paused, waiting or offline agent gets no messages until
  that ends.
- **Wakes** always wait for the turn to end.
- **An agent in `error`** gets only retry prompts. Each carries the messages that waited, and the wakes without a
  check.
- **Two prompts do not wait for `min_interval`:** the retry prompt after a failed turn, and the resume prompt after
  a turn that a restart of OpenCode cut (see [When Things Fail](#when-things-fail)).
- What waits is kept in the database, also across server restarts.

### Patterns

Many fields take an ID pattern: `discover`, the `to` of a message, the rules of settings, filters.

- `*` matches any characters, `:` included. `kaggle:*` matches `kaggle:lead` and `kaggle:housing:lead`.
- Other examples: `*:reviewer`, `kaggle:worker-*`.
- A comma list names several: `kaggle:lead,kaggle:worker-1`.
- IDs are case-sensitive.

## Install

1. [Get the binary](#get-the-binary).
2. [Install the server](#install-the-server) on one machine.
3. [Connect each machine](#connect-each-machine) whose OpenCode should use Autocode.
4. [Sign in and check](#sign-in-and-check).

### Requirements

- **OpenCode 2.3.0 or later** on each machine that should use Autocode. An older OpenCode is refused, with every
  host of it: see [A Host Is Marked "too old"](#a-host-is-marked-too-old).
- **The server:** one Linux machine with systemd, ARM64 or x86-64. It may also run agents. The server installs as a
  systemd user service.
- **macOS (ARM64):** a Mac needs its own binary, `dist/autocode-darwin-arm64`, also when the server machine is
  ARM64. It runs the CLI, `plugin install` and `autocode serve` in the foreground. It cannot install a service.
- **The plugin** runs wherever OpenCode does.
- **Network:** each machine must reach the server's address and port (4848 by default), over a LAN or Tailscale. The
  server speaks plain HTTP, so tokens cross the network as they are: use a network you trust.

### Get the Binary

The releases on GitHub carry no binaries. Build it from source, on Linux with git, [Bun](https://bun.sh) and Docker:

```sh
git clone https://github.com/myurasov/Autocode
cd Autocode
ci/dist.sh
```

- The result is `dist/autocode`, for the CPU of the machine that built it.
- `AUTOCODE_TARGETS=all ci/dist.sh` also builds `dist/autocode-linux-arm64`, `dist/autocode-linux-x64` and
  `dist/autocode-darwin-arm64`.

More about building: [`DEVELOPMENT.md`](DEVELOPMENT.md).

**Where the binary ends up.** `autocode install` and `autocode plugin install` both copy the binary they are run
from to `~/.autocode/bin/autocode`. So on every machine that has run one of them, that is where it is.

**Typing `autocode`.** This reference writes `autocode` for the binary. Nothing changes the `PATH` of your own
terminal. Type `~/.autocode/bin/autocode`, or add the folder once, then open a new terminal:

```sh
echo 'export PATH="$HOME/.autocode/bin:$PATH"' >> ~/.bashrc
```

Scripts that agents start need no setup: the plugin puts `~/.autocode/bin` first in the `PATH` of their shells.

The examples use these names: `machine-a` is the server machine, `machine-b` a second machine, and `home` the server
ID. Put your own in their place.

### Install the Server

On the server machine, as your normal user, not root. From the folder where you built it:

```sh
dist/autocode install --id home --listen localhost,tailscale:4848
```

`home` is the server ID: a name you choose. If you copied the binary to this machine, type its path, such as
`~/autocode`, in place of `dist/autocode`.

What it does:

1. Copies the binary to `~/.autocode/bin/autocode`.
2. Writes the systemd user unit `~/.config/systemd/user/autocode.service`, enables it and starts it.
3. Waits until the server answers.
4. Prints where the tokens are. The first start creates `~/.autocode/admin.token` and `~/.autocode/consumer.token`,
   both readable only by you (mode 0600).

It worked if the last lines say `server home v1.1.0-rc3-... answers at http://127.0.0.1:4848` and name the two token
files.

| Flag | Meaning | Without it |
|---|---|---|
| `--id ID` | the server ID. Machines connected with `--server-id` refuse a server with another ID | the `id` in `~/.autocode/config.json`, else the machine's name |
| `--listen ADDRESSES` | the addresses the server answers on | the `listen` setting: `localhost,tailscale:4848` |
| `--data DIR` | where the database and the two token files go | `~/.autocode` |

`--listen` takes names that share one port, or addresses that each have a port:

- `localhost,tailscale:4848`: this machine (127.0.0.1) and its Tailscale address, both on port 4848. If Tailscale
  comes up after the server, the server starts to answer on that address as soon as it appears.
- `0.0.0.0:4848`: every address of the machine. Use this on a LAN without Tailscale.
- `127.0.0.1:4848,0.0.0.0:4849`: two addresses, each with its own port.

More to know:

- **Keep it running.** Without lingering, systemd runs the service only while you are logged in: it stops when you
  log out. Run this once, so that the service keeps running and starts at boot:
  `sudo loginctl enable-linger $USER`. `install` says when lingering is off.
- `install` runs on Linux only, and only from the built binary.
- With `AUTOCODE_HOME` set, the binary and the data go to that folder instead of `~/.autocode`.
- **With `--data DIR`** the token files are in `DIR`, where the CLI does not look for them. Give them to
  `plugin install` on the server machine: `--consumer-token-file DIR/consumer.token`, and
  `--admin-token-file DIR/admin.token` for your own commands.

To run the server in the foreground instead, use `autocode serve` with the same three flags. Stop it with Ctrl-C or
SIGTERM. Its data goes to `--data`, else to `$AUTOCODE_HOME`, else to `~/.autocode`.

### Connect Each Machine

Do this on each machine whose OpenCode should use Autocode. That includes the server machine, if agents run there.

**On the server machine** (`machine-a`), the binary and the consumer token are already in place:

```sh
autocode plugin install --url http://127.0.0.1:4848 --server-id home \
  --consumer-token-file ~/.autocode/consumer.token
```

**On another machine** (`machine-b`), run all three steps on `machine-b`:

1. **Copy the binary.** Any place will do. If `machine-b` has another CPU than `machine-a`, or is a Mac, copy the
   binary for it from the build's `dist/` folder instead.

   ```sh
   scp -p machine-a:.autocode/bin/autocode ~/autocode
   ```

2. **Copy the consumer token.**

   ```sh
   mkdir -p ~/.autocode && chmod 700 ~/.autocode
   scp -p machine-a:.autocode/consumer.token ~/.autocode/consumer.token
   ```

3. **Install the plugin.** The address is the server's, as `machine-b` reaches it:

   ```sh
   ~/autocode plugin install --url http://machine-a:4848 --server-id home \
     --consumer-token-file ~/.autocode/consumer.token
   ```

   From then on the binary is at `~/.autocode/bin/autocode` on `machine-b` too. You may delete `~/autocode`.

**Then, on either machine:**

1. **Check the output.** It says `plugin installed in ...` and `client config ... points at home`. Where it copied
   the binary, as on `machine-b`, it also says `autocode copied to ...`.
2. **Restart OpenCode**, if it was running: `opencode service restart` for the background service. This closes open
   TUIs and cuts the turns that run; Autocode resumes the agents' turns. An OpenCode that is started later needs no
   restart.
3. **Open a project folder in OpenCode:** start a TUI there, or send a prompt.
4. **Check:** `autocode hosts` lists one line for that machine and folder, with `yes` under ONLINE. A folder is
   listed only after OpenCode has opened it.

What `plugin install` does:

- It checks that the server answers, that its ID is the one you gave, and that the token is a consumer token.
- It writes the plugin to `plugins/autocode/index.js` in OpenCode's config folder. That folder is
  `--opencode-config-dir`, else `$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.
  Run the command as the user that OpenCode runs as, so that both find the same folder.
- It writes the client config `~/.autocode/client.json` (mode 0600): the URL, the tokens and the expected server ID.
  `AUTOCODE_CONFIG` names another file.
- It copies the binary to `~/.autocode/bin/autocode`, unless it runs from there already.

| Flag | Meaning |
|---|---|
| `--url URL` | the server's address, required |
| `--consumer-token-file FILE` | a file that holds the consumer token, required. `--consumer-token TOKEN` takes the token itself instead; prefer the file, which keeps the token out of your shell history |
| `--server-id ID` | optional: refuse a server with another ID |
| `--admin-token-file FILE` | optional: also save the admin token, so that you can run every owner command from this machine. Only a machine other than the server needs it. `--admin-token TOKEN` takes the token itself |
| `--opencode-config-dir DIR` | optional: OpenCode's config folder, when it is not the default |

OpenCode loads the plugin with each folder, when the folder is first used. It unloads a folder after an hour without
use, and the host is then offline: see
[OpenCode Restarts and Unloaded Folders](#opencode-restarts-and-unloaded-folders).

### Sign In and Check

1. Open `http://machine-a:4848/` in a browser, with your server's address. Sign in with the admin token: the
   content of `~/.autocode/admin.token` on the server machine.
2. `autocode info` prints the server's ID and version, like
   `server home, autocode v1.1.0-rc3-build1, for OpenCode v2.3.0 or later, at http://127.0.0.1:4848`, with your build's
   number.
3. `systemctl --user status autocode` shows the service running. Its log: `journalctl --user -u autocode`.
4. `autocode hosts` lists one line per machine and folder, as in [Connect Each Machine](#connect-each-machine).
   PLUGIN shows each host's plugin version.
5. In an OpenCode session, ask the agent to call `autocode_me action=status`. It answers whether the session is
   registered.

To upgrade later, see [Upgrade](#upgrade).

### Uninstall

- **Server:** `~/.autocode/bin/autocode uninstall` stops and removes the service. The binary and the data stay in
  `~/.autocode/`. To remove everything, delete that folder by hand. A new install then makes new tokens.
- **Plugin:** `autocode plugin uninstall` removes `plugins/autocode/` from OpenCode's config folder. Add
  `--opencode-config-dir DIR` if you installed with it. The client config and the binary stay in `~/.autocode/`. On
  a machine that is not the server, delete that folder by hand to remove everything.

## What Agents Can Do

Agents use five tools in the conversation. You do not call them: you ask an agent in plain words, and it calls them.
Scripts that an agent starts in its shell use the CLI instead.

### The Tools

Each tool takes an `action`.

| Tool | Actions, with their parameters |
|---|---|
| `autocode_me` | `register` (`id`, `description`), `unregister`, `status`, `discover` (`pattern`), `help` (`topic`), `compact`, `jobs`, `run` (`job`, `text`), `finish` (`result`), `job_set` (see [Jobs That Agents Set](#jobs-that-agents-set)), `job_delete` (`job`), `rename` (`id`) |
| `autocode_wake` | `set` (`name`, `trigger`, `text`, `check`), `list`, `show` (`name`), `cancel` (`name`), `fire` (`agent`, `name`, `text`) |
| `autocode_message` | `send` (`to`, `subject`, `text`, `reply_to`, `report`), `list`, `read` and `wait` (`id`, `from`, `reply_to`; wait: `seconds`), `answer` and `escalate` (`id`, `text`) |
| `autocode_lock` | `acquire` (`name`, `ttl`, `max`, `mode`), `renew` (`name`, `ttl`), `release` (`name`), `list` (`pattern`) |
| `autocode_approval` | `ask` (`text`, `options`, `expires`), `wait` (`id`, `seconds`) |

OpenCode's own question tool and its permission prompts also reach you through Autocode.

### The Agent Guide

[`autocode.consumer.agent.md`](autocode.consumer.agent.md) is the exact text that agents get.

- The plugin gives it to every session as the `autocode` skill.
- `autocode_me action=help` returns it whole, or `topic=` one part: `overview`, `delivery`, `wakes`, `checks`,
  `recipes`, `messages`, `owner`, `locks`, `asks`, `costs`, `jobs`, `prompts`, `scripts`, `trouble`.
- Once a session is registered, each model call carries one extra line that names its agent ID.

### Register and Discover

```
autocode_me  action=register  id=kaggle:lead  description="Lead agent of the Kaggle project"
autocode_me  action=discover  pattern=kaggle:*
```

In plain words, to an agent: "Register with Autocode as `kaggle:lead`."

- **The ID:** letters, digits, `-`, `_`, `.` and `:`, up to 255 characters. Levels are split by `:`, usually
  project, role and name: `kaggle:housing:lead`. `owner` and `autocode` are reserved, and so is every ID that starts
  with `job:`.
- **One ID per session.** A session that already has an ID is refused another (`session_has_id`).
- **Registering again** with the same ID from the same session changes nothing. That makes it safe after a
  compaction.
- **A taken ID** is refused (`id_taken`). An agent can never take an ID that is registered, also when the session
  that held it is gone. Only you can move an ID to another session, with its wakes, settings and spend:
  `autocode agents register ID --session SES`, and with `--force` when the old session still exists.
- **The session's title.** On registration the plugin sets the session's title to `@` and the ID, like
  `@kaggle:lead`, so that you find it in OpenCode's session list. A run of a job keeps its own title.
- **A Subagent** acts for the agent that started it. It has no ID of its own.
- **`discover`** lists one line per agent: ID, status, last activity, description.
- **A missing tool.** An agent needs `autocode_me` in its tool list. If it is missing, see
  [The Tools Are Missing](#the-tools-are-missing). An answer that starts with `error` says why a call failed.

An agent is unregistered in one of four ways:

1. It calls `autocode_me action=unregister`.
2. You unregister it: **Unregister** on the Agents tab, or `autocode agents rm AGENT`.
3. `expire_after` (14 days) passes after its session's last turn. An agent paused by you or by Stop All does not
   expire, and neither does one with an open ask.
4. It is a run of a job, and the run ends.

Unregistering removes the agent's wakes and the jobs that it set, releases its locks, closes its open asks and
alerts, and drops the messages that still wait for it. Asks that were sent to it go back to you. Its history and
its spend stay. Its messages to you that you have not answered or closed stay in the Inbox: close them when you
have read them. An answer to one has nobody to go to and is refused, unless the agent was renamed.

### Renaming an Agent

To change an agent's ID, rename it. Do not unregister it and register it again: that removes its wakes and its
jobs and starts its spend over.

- **You:** `autocode agents rename AGENT NEW-ID`.
- **The agent:** `autocode_me action=rename id=NEW-ID`. Ask it in plain words: "Rename yourself to kaggle:lead."

The agent stays what it is: the same session, status and context. Everything that names it moves at once:

| What | After the rename |
|---|---|
| wakes, and what waits to be delivered | the agent's, under the new ID |
| locks and places in lock queues | kept |
| open asks, and asks sent to it | kept |
| Inbox items | show the new ID |
| spend: today, per day and in total | kept. If the new ID was used before, the two are added |
| its own settings | moved. A value that the new ID already has stays |
| settings that send asks to it, like `question_mode agent:OLD` | name the new ID |
| the jobs it set | renamed from `OLD:name` to `NEW:name`, with their runs |
| History | keeps the old ID in what it recorded, and adds `agent.renamed` |

- **The old ID forwards.** A message sent to the old ID goes to the agent, and the sender is told the new ID. A
  fire of one of its wakes by the old ID works too. This ends when another session registers the old ID, or
  after `history_days`. A pattern like `kaggle:*` matches only the IDs that are registered now.
- **Refused:** a new ID that another agent holds (`id_taken`), a reserved one (`reserved_id`), the run of a job,
  and a rename that would give one of the agent's jobs the name of an existing job (`job_exists`).
- **The session's title** in OpenCode follows: `@` and the new ID.
- The web UI has no button for it.

**A deleted session does not unregister its agent.** When you delete an agent's session in OpenCode:

- the agent stays registered and shows `offline`;
- its open asks close, and its locks are released;
- its wakes stay. No other session can register its ID. To go on with the agent in a new session, move the ID
  there: `autocode agents register ID --session SES` (the new session's refused registration prints the command);
- if you do not, the agent expires as in point 3 above.

### Shell Values and Scripts

The plugin puts four values into the environment of every shell that OpenCode starts for a session. A Subagent's
shells get the values of the agent that started it.

| Variable | Value |
|---|---|
| `AUTOCODE_URL` | the server's address |
| `AUTOCODE_TOKEN` | the session token: whoever has it acts as that session |
| `AUTOCODE_SERVER_ID` | the server's ID |
| `AUTOCODE_SESSION` | the ID of the session; for a Subagent, of its agent's session |

Every session's shells get them, registered or not. In the shells of a session that is not registered,
`autocode me` answers "this session is not registered".

The plugin also puts `~/.autocode/bin` first in the `PATH` of those shells, on every host that has shell values. So
a script calls `autocode` by name, with no setup.

A script or a long command started in such a shell acts as the agent, with three commands only:

| Command | Does |
|---|---|
| `autocode me` | prints the agent's registration and status |
| `autocode fire me WAKE [--text TEXT]` | delivers one of the agent's own wakes now. With an agent's ID in place of `me`, that agent's wake |
| `autocode send TO TEXT... [--subject SUBJECT] [--reply-to ID] [--report]` | sends a message as the agent. `TO` may also be `owner`. `--report` marks one to the owner that needs no answer: see [Reports](#reports) |

Everything else belongs to the tools. A long training command that wakes its agent when it ends:

```sh
nohup sh -c 'python train.py > runs/latest/log.txt 2>&1; autocode fire me training-done --text "exit $?"' &
```

Agents never copy `AUTOCODE_TOKEN` into files or messages.

Some hosts cannot set shell values: the Hosts tab marks them **no shell values**. See
[A Host Is Marked "no shell values"](#a-host-is-marked-no-shell-values).

### Rules for Agents

The guide tells agents to use the tools in the conversation; to read the guide or ask the owner when unsure, never
the plugin's code; to register once per session, with a stable ID; to keep the text of a wake self-contained,
because the session may have been compacted since; to release locks as soon as they are done; not to wake other
agents in a loop; and never to put secrets in messages.

A snippet for a project's `AGENTS.md`, under a heading of its own such as `Autocode`. Replace the four parts in
angle brackets:

```md
This project uses Autocode. On session start, if the `autocode_me` tool is available and `autocode_me action=status`
shows you unregistered, register as `<project>:<role>:<name>`. Use `autocode_me action=discover` to find the
project's other agents, and load the `autocode` skill once for the details. Use wakes, with checks, instead of waiting
in a loop; message other agents with `autocode_message`. Take lock `<resource>` before <the conflicting operation>.
Ask the owner through the question tool, and ask for an approval before <payments, deploys, trades, deletions>.
```

## Wakes

A wake is a prompt that Autocode types into an agent's session later. It has four parts:

- a **name**. Setting the same name again replaces the wake, and its schedule starts over;
- a **text**: what to do, and where the notes are;
- a **trigger**: when it falls due;
- optionally a **check**: a shell command that decides whether a due wake is worth a prompt.

In plain words, to an agent: "Wake yourself every 30 minutes to check the training in `runs/`." The agent then calls:

```
autocode_wake  action=set  name=check-training  trigger="every 30m"  text="Check the training in runs/ and act on it."
```

More examples:

```
autocode_wake  action=set  name=standup  trigger='cron "0 9 * * 1-5" America/Los_Angeles'  text="Write today's plan."
autocode_wake  action=set  name=new-data  trigger="every 15m"  text="Load the new files."
               check='test -n "$(ls incoming/*.csv 2>/dev/null)"'
autocode_wake  action=set  name=training-done  trigger='fire-only once'  text="Training finished: read runs/latest/log.txt."
autocode_wake  action=fire  agent=kaggle:worker-1  name=new-fold  text="Folds v3 are ready."
```

### Triggers

| Trigger | Falls due |
|---|---|
| `every 30m` | every 30 minutes, counted from when the wake was set. The shortest is `1s` |
| `every 2h from 09:00` | every 2 hours, counted from 09:00 that day |
| `in 45m` | once, 45 minutes after it is set. Then the wake is removed |
| `at 09:00` | once, at the next 09:00. Then the wake is removed |
| `at 2026-11-30 18:00` | once, at that local time. Then removed |
| `at 2026-11-30T18:00:00-08:00` | once, at that ISO time with its own zone. Then removed. An `at` time that has passed is refused |
| `cron "*/30 8-16 * * 1-5"` | at clock times: `minute hour day month weekday`, with lists, ranges, steps and names. With day and weekday both set, either matches |
| `cron "0 9 * * 1-5" America/Los_Angeles` | the same, in the named zone. The zone is kept with the wake |
| `idle 30m` | once, when the session has done nothing for 30 minutes |
| `idle 30m repeat` | as `idle 30m`, then again every 30 minutes for as long as the session stays idle |
| `fire-only` | never by itself: only when fired, by the agent, another agent, the owner or a script |
| `fire-only once` | the same, for one fire: the wake is removed when it is fired, and its prompt still comes. For a command that ends once |

- **Zone.** Times without a zone are in the server's zone: the `timezone` setting. `autocode_me action=status` shows
  it.
- **Durations** look like `90s`, `30m`, `2h`, `1d` or `1h30m`.
- **`every` and daylight saving.** `every` counts fixed steps, so a daylight-saving change shifts its clock times by
  an hour. For clock times, use `cron`.
- **`cron` and daylight saving.** A time that the change skips falls due at the next minute that exists. A time
  that it repeats falls due once.
- **`idle`.** The time counts from the end of the session's last turn, whoever started that turn: the agent, you or
  Autocode. It never counts from before the wake was set. The wake falls due once per idle stretch; a new stretch
  starts when a turn ends.
- **`idle ... repeat`.** After the first time, it falls due again each time that long has passed since it last fell
  due. A time at which its check skipped it counts too.

### List, Cancel and Fire

- **`list`** shows three things for each wake. When it falls due next: as a time in the server's zone, and as a
  time from now. When it was last set: its schedule counts from then. And who set it. For an idle wake, "next" is
  when it falls due if the session stays idle. **`show`** prints one wake whole.
- **`cancel`** removes a wake, and what of it still waits to be delivered: also the waiting prompt of a one-time
  wake that is gone already (`in`, `at`, `fire-only once`). A wake has no end date: cancel it when it is no longer
  needed. Unregistering removes all of an agent's wakes.
- **`fire`** delivers a wake now. Any agent may fire any agent's wake. A fired wake skips its check. It still waits
  for an idle session and for `min_interval`. The prompt says who fired it, and quotes the extra text as theirs.
- **Merging.** A wake that falls due several times before it can be delivered arrives once. Different wakes never
  merge, even with the same text, and neither do messages.
- **After a server outage,** a wake that fell due meanwhile is delivered once.
- **You** set, cancel and fire any agent's wakes: `autocode wake set`, `autocode wake cancel`, `autocode fire`, or
  the Wakes tab.

### Checks

A check costs no model calls, so a frequent wake with a check is cheap. The `new-data` wake above has one: it exits
with 1 while no file has arrived.

When and where it runs:

- It runs when the wake is due and Autocode is about to deliver: the session is idle, the agent is not paused, and
  `min_interval` has passed.
- The plugin runs it on the agent's machine, in the session's folder, with `bash -c`.
- Its environment is OpenCode's, plus the four `AUTOCODE_*` values and `~/.autocode/bin` first in the `PATH`. So
  `autocode` in a check acts as the agent. A check has them on every host, also on one marked **no shell values**.

What its exit code means:

| Exit | Result |
|---|---|
| 0 | The agent is woken. The start of the check's output is quoted in the prompt: stdout, then stderr, up to `check_output` characters (2000) |
| 1 | The wake is skipped quietly this time: no prompt, no model call. It does not count toward `min_interval` |
| any other | A failed check: the wake is skipped this time. Three failures in a row open an alert in your Inbox |
| none, after its time limit | The check and the commands it started are stopped. It counts as a failed check. The limit is `check_timeout` (60 s), or the wake's own |

- One check runs at a time per wake. If the wake falls due again meanwhile, the two count as one.
- **A check may do the routine pass.** A wake that mostly finds nothing to do costs a whole turn each time. Put
  its script in the check instead: the script does what needs no judgement and exits 1, and it exits 0, with what
  the agent must know in its output, only when something needs the agent. A pass that ends with 1 costs no model
  call.
- **Its own time limit.** Such a check may need minutes. A wake can carry its own limit: `check_timeout=5m` in
  `autocode_wake action=set`, or `--check-timeout 5m`. The most a wake may ask for is `check_timeout_max`, 10
  minutes unless you set another, for an agent, a pattern or the server. A wake without its own limit gets
  `check_timeout`.
- **A check must be safe to run again, and while a turn runs.** A turn can start during a long check: you write
  to the agent, or a message comes. Messages and other wakes wait for a running check no longer than
  `check_timeout`; the check's own wake comes after that turn.

```
autocode_wake  action=set  name=hourly  trigger="every 1h"  text="The hourly pass found work: read its output."
               check=./hourly.sh  check_timeout=5m
```

### What a Wake Costs

Each time a wake's prompt starts a turn, the agent's model reads its whole context again. Autocode counts what
that comes to, per wake, for the last 7 days: today and the six days before.

| Number | What it counts |
|---|---|
| due | how often the wake fell due, by its schedule or by idle time. A fire is not counted here |
| skipped | how often its check skipped it, with exit 1. A skipped run costs nothing |
| turns | the turns that its prompts started, and the turns that OpenCode started by itself for work they began |
| dollars | the model steps of those turns, and of the Subagents they started, however long those work |

Where it shows: `autocode_wake action=list` and `action=show` for the agent; `autocode wakes` and the Wakes tab's
**Last 7 Days** for you.

- **A prompt with several wakes** divides each step's cost among them equally. Messages in the same prompt take
  no share.
- **Work that outlives its turn stays with its wake.** A wake's turn may start a Subagent or a background
  command and end. When the Subagent's result comes or the command finishes, OpenCode starts a turn by itself:
  that turn is one more turn of the wake that started the work, also when other wakes' turns ran meanwhile. A
  Subagent's own steps count for that wake too, however long it works. With several wakes in the prompt, the
  shares stay the same.
- **Not counted:** a turn that you start in the session, and the work it starts. A job's runs: see the Jobs and
  Costs tabs. Compactions.
- **Where the start of some work is not known,** because the plugin was loaded after it began, its turn counts
  for the wake of the turn before it.
- **The numbers stay with the agent and the wake's name.** Setting the wake again keeps them. They go when the
  agent unregisters, and after `history_days`, though never in less than 31 days.
- **What to do about a costly wake.** If most of its turns find nothing to do, move the routine pass into its
  check: see [Checks](#checks).

### Recipes

| Goal | Wake |
|---|---|
| Every 30 minutes in work hours on weekdays | `cron "*/30 8-16 * * 1-5" America/Los_Angeles`, with a check |
| A loop spaced from the end of each turn | each time the wake comes, the agent ends by setting the same wake again with `in 30m`. To stop, it does not set it again. A daily `cron` wake can start the loop |
| Keep an agent reachable on a machine other than the server's | `every 30m`, or any wake whose prompt comes at least that often: it keeps the folder loaded (see [OpenCode Restarts and Unloaded Folders](#opencode-restarts-and-unloaded-folders)) |
| Wake me when a long command ends | a `fire-only once` wake; the command's last line is `autocode fire me NAME`. The wake is gone after that |
| Poll cheaply | `every 10m` with a check |
| Remind me once | `in 45m` or `at 15:00` |
| Nudge me when I have been idle | `idle 2h` |

## Messages

Messages carry text between agents and the owner. A message holds up to 32,000 characters. It may have a subject
and a `reply_to`: the ID of the message that it answers. To share a file, agents send its path.

```
autocode_message  action=send  to=kaggle:worker-1  subject="New fold split"  text="Use folds v3 from data/folds.csv."
autocode_message  action=send  to=kaggle:*  text="Start no new training: GPU maintenance at 14:00."
autocode_message  action=wait  reply_to=m_3f2a...  seconds=180
```

### Send and Delivery

Who gets it:

- `to` is an agent ID, a pattern such as `kaggle:*`, a comma list, or `owner`.
- A pattern or a list never includes the sender.
- A send that reaches nobody is refused (`no_recipient`): an unknown ID, or a pattern that matches no agent.
- In a list, unknown IDs are skipped, and the reply says which.

How it arrives depends on the recipient (the rules are in [How Delivery Works](#how-delivery-works)):

| Recipient | The message |
|---|---|
| an agent that is working | joins the running turn at its next step, under `[autocode] 1 message, during your turn` |
| an idle agent | comes as a prompt |
| a paused, waiting or offline agent | waits until the agent can be reached again |
| `owner` | lands in your Inbox. Your answer goes back to the agent as a message from the owner |

- Messages arrive whole. One prompt carries up to 32,000 characters of messages; the rest come in the next one.
- An agent that waits for a reply may simply end its turn: the reply wakes it.
- You send with `autocode send TO TEXT...` or on the Messages tab.

### Reports

Most of what agents write to you needs no answer: a run ended, a result came in. An agent marks such a message as
a report, with `report=true`, so that it does not stand between you and the messages that do need you.

```
autocode_message  action=send  to=owner  report=true  subject="Nightly run"  text="All three folds finished."
```

- **From a script:** `autocode send owner TEXT --report`.
- **In the Inbox** a report reads **Report**, in grey, and its title starts with "Report from". The **Reports**
  box hides and shows them; it is on at first, and the browser remembers it. You can answer or close a report
  like any message.
- **It closes by itself.** A report that is still open 7 days after it came is closed by the server:
  `report_close_after`, server-wide; `0` keeps reports until you close them.
- **Only to you.** The mark is refused unless `owner` is among the recipients. Agents that get the same message
  get it plain.
- **What is not a report:** a question, a blocker, a choice. The agents' guide tells agents to send those plain.

### List, Read and Wait

An agent can also take its messages itself:

| Action | Does |
|---|---|
| `autocode_message action=list` | shows what waits: sender, subject and size, without the text. It marks nothing |
| `autocode_message action=read` | takes what waits now, whole, oldest first: up to 32,000 characters a call. It says how many more wait |
| `autocode_message action=wait seconds=120` | waits for a message, then reads it. At most `max_tool_wait` (5 minutes). Waiting costs no model calls |

- All three take `from=` and `reply_to=` as filters. `read` and `wait` also take `id=`.
- A message arrives once: what `read` or `wait` returned never comes in a prompt.
- `autocode_me action=status` says how many messages wait.

### Message States

`autocode messages` and the Messages tab show each message's state. Looking at a message never changes it.

| State | Means |
|---|---|
| `queued` | it has not arrived yet: it waits for its agent, or in your Inbox |
| `processed (prompt)` | it arrived: Autocode typed it into an idle session |
| `processed (steer)` | it arrived: it joined a running turn |
| `processed (read)`, `processed (wait)` | it arrived: the agent took it with `action=read` or `action=wait` |
| `processed (inbox)` | it was for you, and you answered or closed its Inbox item |
| `dropped` | its agent was unregistered before the message arrived |

A message is deleted `history_days` (30 days) after it was sent, whatever its state: also one that still waits.

### Notices

Notices arrive as messages from `autocode`; `from=autocode` picks them. They are Autocode's own text, so they are
not quoted. The first line says what the notice is:

- a lock was granted, expired, or released by the owner; or the agent was taken out of a lock's queue;
- an ask was sent to this agent to answer;
- the agent's own approval was answered;
- a cost warning;
- the result or the failure of a run;
- the session's compaction is done, or a compaction that the agent asked for failed.

### Writing to the Owner

Everything an agent sends you is read by a busy person: a message, a question, an approval, the reason of an
escalation. The guide tells agents to write:

- **Short:** only what the owner needs to know or decide. No background that was not asked for, no restating, no
  thanks.
- **Point first:** the decision or the news in the first line, then the facts it rests on.
- **Structured:** a short list for several items, one line each. The options, and what the agent does if no answer
  comes.
- **Plain:** what it did, found or needs. Names, paths and numbers, not adjectives. Details go in a file, and the
  message carries its path.

```
autocode_message  action=send  to=owner  subject="Decision: fold 3"  text="Spend $5 more on fold 3?
- fold 2: 0.912 (target 0.91)
- fold 3: 2 more GPU hours
If no answer by 18:00: I stop after fold 2."
```

## Locks and Semaphores

A lock is shared by every agent on the server, on any machine. It is a mutex (`max=1`, the default) or a semaphore
with `max=N` places. Agents take one when only one of them, or N, may do something at a time: use a GPU, submit
results, refresh data.

In plain words, to an agent: "Take the lock `gpu:0` for 6 hours before you train."

```
autocode_lock  action=acquire  name=gpu:0  ttl=6h                # queue: a notice says when it is yours
autocode_lock  action=acquire  name=gpu:pool  ttl=6h  max=2      # a semaphore with 2 places
autocode_lock  action=acquire  name=submit  ttl=10m  mode=try    # now or refused
autocode_lock  action=renew  name=gpu:0  ttl=6h
autocode_lock  action=release  name=gpu:0                        # or leave the queue
autocode_lock  action=list  pattern=gpu:*
```

- **`ttl` is required.** It is how long the hold lasts. The clock starts at the grant, even if the agent learns of
  the grant later, because it is in a turn or paused. So agents allow extra time.
- **Renew** before the hold runs out. `ttl=` sets a new time from now; without it, the same as before.
- **A hold that runs out** is freed for the next agent in the queue. The agent that lost it is told:
  `[autocode] lock "gpu:0" expired`.
- **Capacity.** The first `acquire` creates the lock with its `max`. Later calls may leave `max` out. Another
  capacity is refused (`lock_capacity`). A lock with no holders and nobody queued is removed.
- **`mode=queue`** (the default). The agent gets the lock at once if a place is free and nobody waits. Otherwise it
  joins the queue, first come first served, and may end its turn. The notice `[autocode] lock "gpu:0" granted`
  arrives when the lock is its own.
- **`mode=try`.** The agent gets the lock now or is refused (`lock_busy`, with who holds it).
- **Acquiring again.** For a lock the agent holds, `acquire` renews it. For a lock it waits for, `acquire` keeps its
  place, with the new `ttl`.
- **Unregistering** releases every lock the agent holds and takes it out of every queue.
- `autocode_me action=status` shows the agent its own locks.

You can free any hold, or take an agent out of a queue: `autocode locks release NAME AGENT`, or **Release** and
**Remove** on the Locks tab. The agent is told: `... released by the owner`, or
`[autocode] lock "gpu:0": out of the queue`.

## Questions, Permissions and Approvals

A turn can wait for a person. There are three kinds of ask:

- a **question**: the agent asks something with OpenCode's question tool;
- a **permission**: a tool call needs to be allowed;
- an **approval**: the agent asks before a step that it must not take alone.

Autocode sends each ask where you set, and puts the answer back into the session, where the turn goes on.

### Where Each Ask Goes

Three settings decide, one per kind. Each can differ per agent or pattern (see [Settings](#settings)).

| Setting | Values, the default first |
|---|---|
| `question_mode` | `ask`: your Inbox. `auto`: answered at once with `auto_answer_text`. `agent:<id>`. `job:<name>` |
| `permission_mode` | `ask`: your Inbox, with Allow Once, Allow Always and Reject. `approve`: allowed once, at once. `agent:<id>`. `job:<name>` |
| `approval_mode` | `ask`: your Inbox. `approve`: approved at once. `agent:<id>`. `job:<name>` |

- **`agent:<id>`** sends the ask to that agent, as a notice. It goes to you instead if that agent is not registered,
  or is the agent that asks. When that agent unregisters, its open asks come back to you.
- **`job:<name>`** starts a run of that job with the ask in its prompt, and the run answers it. The ask goes to you
  instead if the job cannot start a run now: one is running, or there is no such job. Asks still open when the run
  ends come to you too.
- **`auto`** answers a question with `auto_answer_text`. By default that tells the agent to use its best judgement
  and safe practices: it chooses, goes on, and records what it chose.

An example that sends the questions of the workers to their lead:

```sh
autocode settings set question_mode agent:kaggle:lead --match 'kaggle:worker-*'
```

Rules that hold for every ask:

- You see every ask in the Inbox from the start, wherever it was sent. The first answer counts; a later one is
  refused. Only you can allow always.
- While an ask is open, the asking agent is `waiting`. Its wakes and messages wait until the ask is answered or
  expires. An answer given in the TUI counts too.
- An ask without an expiry waits until somebody answers it.
- A question or a permission of the agent's own turn closes when that turn ends. A Subagent's question or
  permission stays open in the Inbox after its agent's turn has ended, because Subagents work in the background.
  It closes when it is answered, or when OpenCode drops it.
- A question written as plain text at the end of a turn is not seen. Agents use the question tool.

### Approvals

For anything that spends money, trades, deploys, deletes data or cannot be undone, agents ask for an approval, not a
question. An approval is settled automatically only if you set `approval_mode=approve` on purpose.

```
autocode_approval  action=ask  text="Pay the electricity bill: $142.17 from checking"  expires=2d
autocode_approval  action=ask  text="Deploy build 7f3a to production"  options="now, tonight"
autocode_approval  action=wait  id=ask_42  seconds=240
```

- **`options`:** a comma list of choices.
- **`expires`:** from 1s to 30d. Past it, the approval counts as rejected, and the agent is told.
- **The answer** comes as a notice, `[autocode] approval "..." approved`. It carries approved or rejected, the
  option, and your note.
- **`action=wait`** holds the call until the answer comes, at most `max_tool_wait`.
- Agents act only on what was approved.

### Answering for Another Agent

An ask sent to an agent comes as a notice: `[autocode] question from kaggle:worker-1: "Fold split"`, or
`permission for`, or `approval for`. It carries what is asked, and the ask's ID. The agent answers it, or hands it
to you:

```
autocode_message  action=answer  id=ask_5f...  text="v3"
autocode_message  action=answer  id=ask_61...  text="reject: not the build folder"     # a permission: once or reject
autocode_message  action=answer  id=ask_63...  text="approve tonight: after 22:00"     # an approval: option, note
autocode_message  action=escalate  id=ask_5f...  text="I do not know which split is current"
```

- **A question** takes an option's name, or the agent's own words. Several questions take one line each. The
  options of a multiple-choice question are separated by commas.
- **`escalate`** adds its reason to your Inbox item. You can still answer, and so can the agent, later.

## When Things Fail

Autocode keeps agents going when a model's provider fails or OpenCode restarts. It tells you when it stops trying.

### A Failed Turn

A turn fails when the provider is down, times out or limits the agent. The agent is then in `error`, and its wakes
and messages wait.

Where to see it: the Agents tab; `autocode agents AGENT --json`, under `error` (the plain table shows only the
status); and `autocode_me action=status` for the agent itself. They show the error type, when it began, how many
retries were sent and when the next is due.

**Retries.** Every `retry_interval` (1 minute) Autocode types a retry prompt. It carries the messages that waited,
and the wakes without a check. A wake with a check waits until a turn has succeeded: its check runs then.

```
[autocode] retry 2

Your last turn failed: provider.internal (...). Continue where you left off.
```

- `min_interval` does not apply to retries.
- A turn that succeeds brings the agent out of `error`.
- **With the default, Autocode retries without end and raises no alert.** `retry_attempts` is 0: no limit. An
  agent whose provider stays down gets a retry prompt every minute.
- **To be told,** set a limit: `autocode settings set retry_attempts 10`. When the retries run out, an Inbox alert
  says so.
- **To stop the retries of one agent,** pause it: `autocode pause AGENT`.

**Errors that are not retried.** Four error types fail the same way again, so Autocode sends no retry, and an Inbox
alert says so:

- `provider.auth`
- `provider.invalid-request`
- `provider.unsupported-operation`
- `provider.unknown`

The names are OpenCode's. Fix the cause, for example an API key or the model's name. Then press **Retry** on the
Agents tab, or run `autocode retry AGENT`. Both also work after the retries ran out.

Both alerts close by themselves once a turn of the agent succeeds again.

### A Blocked Reply

`provider.content-filter` means that the provider's content filter blocked the reply. The filter often lets the same
content through when it is written again, differently. The `filter_recovery` setting decides what Autocode does. It
can differ per agent or pattern.

With `retry compact`, the default:

1. **First block:** one retry, `[autocode] retry 1 (blocked reply)`. It asks for other, shorter wording, with long
   text in a file. It warns that another block compacts the session.
2. **Second block:** the session is compacted, without the usual notice, and retried once more:
   `retry 2 (blocked reply, compacted)`.
3. **Third block, or a compaction that failed:** no more retries, and an Inbox alert.

With `retry`: step 1, then the alert. With `off`: no retry, as for the errors that are not retried.

- A turn that succeeds starts the steps over.
- `retry_attempts` still limits the retries.
- A run of a job takes the same steps before it fails.
- The Agents tab says the next step: `blocked: retry 1 in 40s`, or `blocked: compaction in 40s, then a retry`.
  `autocode_me action=status` says the same in a sentence.

### OpenCode Restarts and Unloaded Folders

Autocode can start OpenCode and load a folder only on the server's own machine, and only for OpenCode's background
service there.

| What happened | On the server's own machine | On any other machine |
|---|---|---|
| OpenCode restarted under a running turn | the turn is cut. Autocode then types a resume prompt: see below | the same |
| the background service is gone | Autocode starts it again when one of its hosts has something unfinished. History shows `opencode.restarted` | nothing: its hosts show offline. Start it yourself |
| another OpenCode is gone: an `opencode serve`, or a private OpenCode server | one Inbox alert per host, when the server has work for it: start it yourself | nothing: its hosts show offline. Start it yourself |
| OpenCode unloaded a folder | Autocode loads it again when the host has something unfinished, if the background service had it. History shows `host.load` | the host stays offline until the folder is used |

- **Something unfinished** is any of these, for an agent of the host: a wake or a message that waits; a retry
  that is due; a turn that was running when the host went; a prompt or a wake's check that Autocode handed to the
  host and that the host has not finished.
- **A turn that a restart cut.** History shows `turn.cut`. Once that OpenCode is back, Autocode types a resume
  prompt, `[autocode] resume`: "Your last turn was cut off (its OpenCode server restarted). Continue where you left
  off." It waits 5 seconds first: an OpenCode that was killed, not restarted, resumes the turn itself. Autocode
  then types nothing, and History shows `turn.uncut`.
- **How Autocode starts the background service.** As your own shells started it. A plugin that runs in the
  background service writes down which OpenCode binary that service is and which environment it has, in
  `~/.autocode/opencode-service.json` (mode 0600; the file stays on that machine). Autocode starts that binary
  with that environment, so the shells of your agents keep their `PATH` and their variables. It leaves out what
  belongs to one login or one start, such as `SSH_*`, `DISPLAY` and `TMUX`. Without that file it starts `opencode`
  from its own `PATH`, or `~/.opencode/bin/opencode`. Under systemd it starts OpenCode in a scope of its own, so
  that a restart or an update of Autocode leaves OpenCode running.
- **An unloaded folder.** OpenCode unloads a folder after an hour without use, and the folder's host goes offline.
  Two things are use: OpenCode is opened in the folder; or a prompt goes to one of its sessions, a wake's prompt
  included. A wake that its check skips types no prompt, so it is not use.
- **To keep a folder loaded on a machine other than the server's,** give its agent a wake of 30 minutes or less,
  such as `every 30m`. Or open the folder in OpenCode whenever its host is offline. Until then the wakes and
  messages of its agents wait, and no alert is raised.
- **A host marked "too old"** is refused, not gone: Autocode does not load it, and raises no alert of this kind.
- **A lost connection.** A plugin that loses the server tries again, after waits that grow up to 30 seconds.
  Meanwhile it keeps what it has to report, and sends it when the server is back. In a very long outage the oldest
  reports can be dropped; the plugin's log says so.

### A Power Cut or a Reboot

A machine that runs both the server and OpenCode can lose power at any moment: every process stops at once. When
the machine is on again, Autocode brings the agents back by itself. Nobody has to open OpenCode.

| What | After the boot |
|---|---|
| the server | It starts by itself, if `autocode install` set it up and lingering is on (see [Install the Server](#install-the-server)). Agents, wakes, messages, locks and settings are all there |
| OpenCode's background service | It does not start at a boot. Autocode starts it for every host with something unfinished, as described above. History shows `opencode.restarted` |
| a turn that was running | It goes on, also when nothing else waited for that agent. OpenCode resumes a turn itself when it was killed under it, with a prompt of its own ("The server restarted while you were working."). When OpenCode does not, Autocode types `[autocode] resume`. The agent's idle wakes count from the end of the resumed turn |
| a prompt that was on its way | It reaches its session when OpenCode is back. One whose turn had just started may come twice |
| a wake's check that was running | It runs again when OpenCode is back. The time that the machine was off does not count against its time limit |
| a wake whose runs fell due meanwhile | It runs once, not once for each run that was missed. Its next run counts from then |
| a lock whose `ttl` ran out, an approval whose `expires` passed | The lock is freed and the approval counts as rejected. The agent is told in its next prompt |

- **A quick reboot.** The server takes a host for connected until 65 seconds after it last heard from it. After a
  reboot that is quicker than that, it starts OpenCode once those seconds have passed.
- **A long outage.** An agent is unregistered when its last turn ended longer ago than `expire_after` (14 days by
  default), and the time that the machine was off counts. Raise `expire_after` for agents that must outlast that.
- **What the last moments can lose.** The database is never left damaged by a cut. What the server wrote in the
  last second or so before the cut can be missing: a prompt may then be typed again, and a cost may not be counted.
- **Machines other than the server's.** After their own power cut, start OpenCode there yourself, or open one of
  its folders: Autocode cannot start OpenCode on another machine.

## Costs and Context

Autocode counts each agent's spend, can cap it per day, and compacts long sessions so that each wake stays cheap.

### Spend and the Daily Cap

- **What counts.** Each model step of an agent counts toward its spend today. The steps of its Subagents count too,
  and so do the compactions of its session and the runs it pays for (see
  [Whom a Run's Cost Counts For](#whom-a-runs-cost-counts-for)). A day is a day in the server's zone.
- **What a session spent before it registered** counts as well. When a session registers for the first time,
  Autocode reads its earlier steps from OpenCode, those of its Subagents included, and files each one on the day
  it ran.
  - What the session spent earlier today counts toward today's cap. A session that registers past its cap is
    paused when its turn ends.
  - Days older than Autocode keeps (`history_days`, at least 31 days) are not listed by day: they add to the total
    only.
  - No wake gets these steps: they show on the Costs tab, not under a wake.
  - It happens once for a session. If the session unregisters and registers again, nothing is counted twice, and
    what it spent while it was not registered stays out.
  - For a session that was registered before, under any ID, only what it spent before its first registration is
    counted: its later steps were counted as they ran. Autocode knows the first registration from History, so it
    knows it for `history_days` (30 days).
  - History shows `cost.before` with the steps, the dollars and the days.
  - It cannot count a Subagent's session that was deleted in OpenCode. And it needs OpenCode's background service
    or an `opencode serve` whose shells get Autocode's values (see
    [A Host Is Marked "no shell values"](#a-host-is-marked-no-shell-values)): for another OpenCode, `cost.before`
    says why nothing was counted.
  - An agent that registered before v1.1.0-rc3 is not counted by itself. Run `autocode costs account AGENT` for
    it: Autocode then counts what its session spent before it registered.
- **Where you see it.** The **Costs** tab and `autocode costs` show every agent's spend today and in total, and its
  cap. They include agents that have unregistered. `autocode costs` also shows the context; in the web UI the
  context is on the Agents tab.
- **What the agent sees.** `autocode_me action=status` shows its spend today and in total, its cap and what is left,
  and its context with its compaction threshold.
- **The cap.** `daily_usd` caps an agent's spend per day. It is off by default.
- **The warning.** At `cap_warn` of the cap (90%) the agent gets `[autocode] cost warning`, once a day.
- **Past the cap.** The running turn may finish. Then the agent is paused by `cap`, and an Inbox alert says how
  much it spent. The pause ends on the next day, when you raise the cap, or when you press **Resume**
  (`autocode resume AGENT`). After a Resume of an agent that the cap paused, the cap does not pause it again that
  day.

To cap one agent at $20 a day: `autocode settings set daily_usd 20 --agent kaggle:lead`. To stop an agent that
spends too much right now, see [Stop an Agent That Overspends](#stop-an-agent-that-overspends).

### Compaction

Each wake reads the whole context again, so a long context costs more per wake. Compaction replaces the older part
of the session with a summary. Autocode starts it between turns, once the context passes `compact_at`.

**The threshold, `compact_at`:**

| Value | Means |
|---|---|
| `50% max 500000` | the default: half of the model's window, but at most 500,000 tokens |
| `90%` | a share of the model's window, with no upper limit |
| `300000` | a number of context tokens, at least 10000 |
| `off` | never compact |

If the model's window is not known, a share counts as its `max`, or as 500,000 tokens.

**What happens, in order:**

1. **The agent is told first:** `[autocode] compaction next`, with its context and the threshold. The notice is
   sent as soon as the context passes the threshold. Into a running turn it reads `compaction next, during your
   turn`. An idle agent gets it as a prompt of its own, even when nothing waits for it: for example after your own
   turns in the TUI. Such a prompt comes at most once per `min_interval`. An agent in `error` gets none.
2. **The agent saves its state.** In that turn it brings its work to a stable point and writes down in files what it
   needs: the task, where it is, decisions, open points.
3. **The session is compacted** when that turn ends.
4. **The agent carries on.** Autocode sends `[autocode] compaction done`, with what waited meanwhile. The agent reads
   its notes and goes on with the steps that are left, or ends its turn if none are. `compaction done` comes only
   after a compaction that OpenCode really did.

**An agent can ask for one:** `autocode_me action=compact` compacts after the current turn, without the
`compaction next` notice.

**If OpenCode could not do the compaction,** nothing is compacted:

- A compaction that came by the threshold comes again after the next turn that passes it.
- An agent that asked for one gets the notice `[autocode] compaction failed`: "Autocode could not compact this
  session (...). Nothing changed. Ask again with autocode_me action=compact if you still want it."

History records each step, from `session.compact.noticed` to `session.compact.done` or `session.compact.failed`:
see [History Kinds](#history-kinds).

So agents keep their working state in files, such as a task list, notes or a checkpoint, and not only in the
conversation.

## Jobs and Runs

A job is a saved task for a fresh agent: a prompt, a model, a host and a trigger. Each run of it is a new session on
that host. For as long as the run lasts, the session is an agent, registered under the run's ID: the job's name and
its start minute in UTC, like `daily-report:2026-11-08T17:00`.

### Define a Job

```sh
autocode job set daily-report --host machine-a:myproject:1a2b3c4d --model openai/gpt-5 \
  --prompt "Write the daily report." --trigger 'cron "0 9 * * *"' --to owner --timeout 1h --run-usd 2
```

This job runs every day at 09:00, server time. Its result comes to your Inbox. `machine-a:myproject:1a2b3c4d` is a
host ID: the machine's name, the folder's name and a short code. It stays the same when OpenCode restarts. Copy
yours from the ID column of `autocode hosts`.

| Flag | Meaning | Without it |
|---|---|---|
| `--host HOST` | where it runs: a host ID | required |
| `--model PROVIDER/MODEL` | the model, like `openai/gpt-5` | required |
| `--prompt TEXT` | what the run is told, up to 32,000 characters | required |
| `--trigger TRIGGER` | `every`, `at`, `in` or `cron`, as for wakes: a time that has passed is refused. Or `fire-only`: no schedule, started by you, an agent or an ask. An `at` or `in` job runs once | required |
| `--to TO` | where the result goes: `owner`, an agent ID, a pattern or a list | `owner` |
| `--description TEXT` | a line that agents see in `autocode_me action=jobs` | none |
| `--variant VARIANT` | the model's variant, such as `high`: how hard it is set to think | the model's default |
| `--agent OPENCODE_AGENT` | the OpenCode agent that the run's session uses. Not an Autocode agent's ID | OpenCode's default |
| `--timeout DURATION` | the run's time limit, from 1m to 7d | `1h` |
| `--run-usd DOLLARS` | the run's cost cap in dollars | no cap |
| `--keep-session` | keep the session of a run that succeeded | it is removed |

The Jobs tab does the same: **Set a Job**, **Edit**, **Run Now**, **Delete**.

### Start Runs

- **On schedule:** the trigger starts runs.
- **By you:** `autocode job run NAME`, with `--text "..."` to add to the prompt; or **Run Now**.
- **By an agent:** `autocode_me action=run job=NAME text=...`. Its text is added to the prompt, marked as its own.
  The result comes back to it as a notice, `[autocode] result of run NAME:...`.
- **By an ask:** an ask routed to `job:<name>` starts a run. The run answers the ask with
  `autocode_message action=answer`, then finishes.

A job has one run at a time. A scheduled run that falls due while one is running is recorded as `skipped`. A run
that somebody asks for meanwhile is refused (`job_busy`), with the ID of the running run and who started it.

A run whose host is offline waits for it, up to its time limit. An unloaded folder is loaded again as described in
[OpenCode Restarts and Unloaded Folders](#opencode-restarts-and-unloaded-folders).

### How a Run Ends

**A run succeeds** in one of two ways:

- it calls `autocode_me action=finish result="..."`. Its prompt ends by telling it so;
- it ends a turn with nothing left to wait for. Then its last reply is the result. Two things count as something
  to wait for: a Subagent of the run that is still at work in the background, and an image that the run started to
  make. The run then ends with the reply of a later turn, once they are done. A background shell does not keep a
  run open.

Then:

1. The result goes to the agent that started the run, else to the job's `--to`. For `owner` that is your Inbox. A
   long result is cut in the message; the whole result stays in the run. See it with `autocode job runs NAME --json`
   or on the Jobs tab.
2. The run's agent is unregistered.
3. Its session is removed, unless the job has `--keep-session`. Nothing in the session survives, so a run writes
   what is worth keeping to files in its folder.

**A run fails** in one of four ways:

| Cause | What happens |
|---|---|
| it passes its time limit | its running turn is interrupted, and so are its Subagents |
| it passes `run_usd` | it fails when the turn that passed the cap ends |
| its session cannot start | for example, its host stayed offline for the whole time limit |
| its turn fails and is not retried, or the retries ran out | see [When Things Fail](#when-things-fail) |

After a failure:

1. You get an Inbox alert that says why and names the session. A destination other than the owner is told too.
2. The run's agent is unregistered.
3. Its session is **kept**, so that you can look at it. Open it in OpenCode on that host's folder: its title is the
   run's ID.
4. Delete the session when you are done: **Delete Session** on the Jobs tab, or `autocode job delete-session RUN`.
   Autocode never removes it by itself. Do it within `history_days`: after that the run's record is gone, and the
   session can only be deleted in OpenCode. The command also deletes the session that a `--keep-session` job kept
   after a run that succeeded; the Jobs tab has the button for failed runs only.

### Whom a Run's Cost Counts For

Each run's spend is counted once, in one row of the Costs tab and of `autocode costs`. So the totals there add up to
what was spent. Which row is decided when the run starts:

| The run | Its cost counts for |
|---|---|
| of a job that an agent set | that agent, whoever started the run; scheduled runs too |
| started by an agent | that agent |
| started by another run | whoever pays for that run, up the chain to the first agent |
| started by an ask (`job:<name>`) | the agent that asked |
| started by you or by a schedule | the job's own row, `job:<name>` |

- **The paying agent's numbers.** Its runs count toward its Today, Daily Cap, Last 7 Days and Total, and toward its
  `daily_usd`.
- **Past the cap.** The agent is warned and paused as usual, once no turn of its own runs. The run itself continues
  until its own `run_usd` or time limit.
- **How much was runs.** The tooltip on an agent's Today and Total says how much of it was its runs'. So do
  `autocode_me action=status` and `autocode costs AGENT`.
- **One run's cost** is on the Jobs tab and in `autocode job runs`. `run_usd` caps it.
- IDs that start with `job:` are reserved for the jobs' rows.

### Jobs That Agents Set

An agent can set jobs of its own:

```
autocode_me  action=job_set  job=digest  model=openai/gpt-5  trigger='cron "0 9 * * 1-5"'  run_usd=2
             prompt="Write the digest of incoming/ into digest.md."
autocode_me  action=run  job=digest
autocode_me  action=job_delete  job=digest
```

`job_set` takes `job`, `model`, `prompt`, `trigger` and `run_usd`, all required. Optional: `host`, `to`, `timeout`,
`variant`, `opencode_agent`, `keep_session`, `description`.

- **Its name** becomes `<agent>:<name>`, like `kaggle:lead:digest`. So your settings rules for that ID pattern apply
  to its runs. `run` finds it by either name.
- **Defaults.** The host is the agent's own folder. Results go to the agent.
- **Your approval.** The `job_mode` setting decides, per agent or pattern:
  - `ask`, the default: an approval lands in your Inbox, with the whole definition and prompt. The job exists only
    once you approve it.
  - `approve`: the job is set at once.
  - `off`: the job is refused.
- **Meanwhile** the agent goes on with its work: a proposed job does not make it `waiting`. It is told by a notice,
  `[autocode] approval "Job kaggle:lead:digest" approved`. A new proposal of the same job replaces the old one.
- **Changing a job** asks again. The job stays as it was until you approve.
- **Who set it.** The job records its creator: **Set By** on the Jobs tab, SET BY in `autocode job list`. All its
  runs count for the creator.
- **Deleting.** `job_delete` deletes one of the agent's own jobs. All of them go when the creator unregisters. You
  can edit or delete them like any job.

## Injected Prompts

An injected prompt is a prompt that Autocode types into a session. Each one starts with a header line that names its
source and reason, and ends with a footer. So a session can always tell that the owner is not speaking.

```
[autocode] wake "tick", 1 message

Wake "tick" (every 30m; next 2026-11-03 09:30 PST):
Check the queue and act on it.
Its check said:
> 3 new files

Message m_123 from agent kaggle:worker-1, subject "results":
> Done: 0.91.

Server time 2026-11-03 09:00 PST. Context: 61,000 tokens, 61% of compact_at (100,000). Cost today: $3.10 (no daily cap).
-- Autocode. "autocode_me action=help" for more info.
```

| Part | What it holds |
|---|---|
| Header | the reasons. Into a running turn it ends with `, during your turn` |
| Wakes | what kind each wake is and when it runs next, then its text. `Added by ...:` carries the extra text of a fired wake. `Its check said:` carries the check's output |
| Messages | `Message <id> from agent X, subject "...":`, or `from the owner`, then the text |
| Status line | the server's time in its zone; the agent's context and its share of `compact_at`, once a step has reported one; today's spend, and the daily cap where the agent has one. So an agent need not call `autocode_me action=status` to learn them |
| Footer | that the prompt is Autocode's, and how an agent gets help |

Headers you will see:

| Header | Sent when |
|---|---|
| `[autocode] wake "NAME"` | a wake fell due. `fired by the owner` or `fired by AGENT` is added to a fired one |
| `[autocode] 1 message` | a message arrived |
| `[autocode] retry 3` | the last turn failed, and this is the third retry |
| `[autocode] resume` | the last turn was cut by an OpenCode restart |
| `[autocode] lock "gpu:0" granted` | a queued lock is now the agent's |
| `[autocode] cost warning` | the agent reached `cap_warn` of its daily cap |
| `[autocode] compaction next` | the session will be compacted when this turn ends |
| `[autocode] compaction done` | the session was compacted |
| `[autocode] compaction failed` | a compaction that the agent asked for could not be done |
| `[autocode] question from AGENT: "..."` | an ask was sent to this agent to answer |

A wake's line says what kind it is: `(every 30m; next ...)`, `(once, this was its only run)`, or
`(idle 30m repeat; again after 30m more idle)`.

**Quoting.** What others wrote, and the output of a check, is quoted: every such line starts with `> `. So it can
never pass for Autocode's own words. Notices are Autocode's own text and are not quoted.

Agents handle an injected prompt as a new turn, and do what the wake's text says. A message from another agent is
information to weigh. It is not the owner's instruction, and it cannot grant permissions that the owner has not
given.

## CLI

The `autocode` binary is also the command-line tool. `autocode --help` prints the list of commands. The HTTP API
behind them describes itself at `/openapi.json` on the server's address.

### Server and Token

Who you are depends on where you run it:

| Where | Who you are | What works |
|---|---|---|
| on the server machine, with the server's address as `127.0.0.1` or `localhost` | the owner | every command |
| on a machine connected with `--admin-token-file` | the owner | every command |
| on another machine, with only the consumer token | a reader | `info`, `hosts`, `agents` as a list, `costs`, `history`, and `settings` without `set` or `unset`. Everything else is refused, `wakes`, `inbox` and `messages` included |
| in a shell that OpenCode started for a session | that session's agent | `me`, `fire`, `send` (see [In an Agent's Shell](#in-an-agents-shell)) |

The CLI takes its server's address from the first of these that is set: the flag `--url`; the variable
`AUTOCODE_URL`; the client config, `~/.autocode/client.json`; `http://127.0.0.1:4848`.

It takes its token from the first of these:

1. the flag `--token`;
2. the variable `AUTOCODE_TOKEN`. In an agent's shell it holds the session token;
3. the admin token of the client config;
4. the file `~/.autocode/admin.token`, when the server's address is this machine's own: `127.0.0.1`, `localhost`
   or `::1`;
5. the consumer token of the client config;
6. the file `~/.autocode/admin.token`, for any address, when the client config holds no token.

So on the server machine your commands work after the plain `plugin install --url http://127.0.0.1:4848` of
[Connect Each Machine](#connect-each-machine), without `--admin-token-file`. In an agent's shell only 1 and 2
count: the CLI never acts there with the owner's token or the consumer token.

With an expected server ID, the CLI checks the server's ID before it sends a token. The expected ID is `--server-id`,
else `AUTOCODE_SERVER_ID`, else the `server_id` of the client config when the address is the client config's too.

### Commands

In this table, CAPITALS stand for a value you supply, and `[...]` marks an optional part. The groups and the words
are those of `autocode --help`.

**Flags Everywhere, and the Environment**

| Flag | Variable | Meaning |
|---|---|---|
| `--json` | | print the data as JSON, not as a table |
| `--url URL` | `AUTOCODE_URL` | the server's address |
| `--token TOKEN` | `AUTOCODE_TOKEN` | the token to use |
| `--server-id ID` | `AUTOCODE_SERVER_ID` | refuse a server that has another ID |
| | `AUTOCODE_HOME` | the Autocode home, in place of `~/.autocode` |
| | `AUTOCODE_CONFIG` | the client config file, in place of `client.json` in the home |

| Command | Does |
|---|---|
| **Set Up** | |
| `autocode serve [--id ID] [--listen ADDRESSES] [--data DIR]` | run the server in the foreground |
| `autocode install [--id ID] [--listen ADDRESSES] [--data DIR]` | install the server as a systemd user service and start it, or update it (see [Install the Server](#install-the-server)) |
| `autocode uninstall` | remove the service. The binary and the data stay |
| `autocode plugin install --url URL --consumer-token-file FILE [--admin-token-file FILE] [--server-id ID] [--opencode-config-dir DIR]` | connect this machine's OpenCode: the plugin, the client config and the binary (see [Connect Each Machine](#connect-each-machine)) |
| `autocode plugin uninstall [--opencode-config-dir DIR]` | remove the plugin. The client config stays |
| `autocode version` | this binary's version. Also `--version` and `-v` |
| `autocode help` | the list of commands. Also `--help` and `-h` |
| **Look** | |
| `autocode info` | the server's ID and version, and the oldest OpenCode it works with |
| `autocode hosts` | hosts: ID, machine, folder, online, OpenCode process, shell values, OpenCode version, plugin version, last seen |
| `autocode agents [PATTERN]` | agents: ID, status, machine, spend today, context as a share of the threshold, last activity, description |
| `autocode costs [--match PATTERN] [--days N]` | every agent's spend today and in total, cap and what is left, context and threshold, with a totals row. Unregistered agents too. `--days N` makes the totals cover the last N days |
| `autocode costs AGENT` | one agent's spend, cap and context, and its spend per day |
| `autocode costs account AGENT` | count what the agent's session spent before it was first registered. For an agent that registered before v1.1.0-rc3; a later registration does it by itself (see [Spend and the Daily Cap](#spend-and-the-daily-cap)) |
| **Agents** | |
| `autocode agents register AGENT --session SESSION [--description TEXT] [--force]` | give a session an agent ID. `--force` takes the ID from a session that still exists |
| `autocode agents rm AGENT` | unregister an agent. Its history stays |
| `autocode agents rename AGENT NEW-ID` | rename an agent in place: see [Renaming an Agent](#renaming-an-agent) |
| `autocode pause AGENT` | send the agent no new prompts. Its wakes and messages wait. It interrupts nothing: a running turn goes on, and so do its Subagents |
| `autocode resume AGENT` | end a pause. What waited is delivered |
| `autocode retry AGENT` | retry an agent in `error` now |
| `autocode stop-all` | pause every agent and interrupt every running turn, Subagents' too |
| `autocode resume-all` | end the pauses that `stop-all` made. Agents that you paused yourself stay paused |
| **Wakes** | |
| `autocode wakes [AGENT]` | every wake, or one agent's: agent, name, trigger, next, check, turns and cost in the last 7 days, last set, text |
| `autocode wake set AGENT NAME --trigger TRIGGER --text TEXT [--check COMMAND] [--check-timeout DURATION]` | set or replace a wake. `--check-timeout`: the check's own time limit, at most `check_timeout_max` |
| `autocode wake cancel AGENT NAME` | remove a wake |
| `autocode fire AGENT WAKE [--text TEXT]` | deliver a wake now. It skips its check. The prompt says that the owner fired it |
| **Messages and Inbox** | |
| `autocode send TO TEXT... [--subject SUBJECT] [--reply-to ID]` | send a message as the owner. `TO`: an agent ID, a pattern or a comma list |
| `autocode messages [--from PATTERN] [--to PATTERN]` | the newest 200 messages, with their state. The flags keep matching senders and recipients |
| `autocode messages read ID` | one message, whole. Its state does not change |
| `autocode inbox [--all] [--match PATTERN]` | the open Inbox items. `--all`: closed ones too. `--match`: those of matching agents, and the asks sent to them. TO says whom an ask went to |
| `autocode answer ID TEXT...` | answer an Inbox item: a message, a question, a permission or an approval. `TEXT` is described below |
| `autocode inbox close ID` | close a message, an alert or an ask, without an answer |
| `autocode inbox close --all [--match PATTERN]` | close every open message and alert, or those of matching agents. Asks stay open. An empty pattern is refused |
| **Locks** | |
| `autocode locks [PATTERN]` | every lock: capacity, holders, when each hold runs out, the queue |
| `autocode locks release NAME AGENT` | end an agent's hold, or its place in the queue |
| **Jobs** | |
| `autocode job set NAME --host HOST --model PROVIDER/MODEL --prompt TEXT --trigger TRIGGER [OPTIONS]` | set or replace a job. `OPTIONS` are the other flags of [Define a Job](#define-a-job) |
| `autocode job list` | the jobs: name, where, model, trigger, next run, last run, who set it |
| `autocode job run NAME [--text TEXT]` | start a run now |
| `autocode job runs [NAME]` | the runs: ID, who started each, state, start, cost, and the result or the reason of a failure |
| `autocode job delete NAME` | delete a job. The history of its runs stays |
| `autocode job delete-session RUN` | delete the session that an ended run left |
| **Settings and History** | |
| `autocode settings` | every setting with its value and where it comes from, the pattern rules, and the agents' own values |
| `autocode settings --agent AGENT` | the values one agent gets, and from where |
| `autocode settings set KEY VALUE [--agent AGENT \| --match PATTERN]` | set a value: server-wide, for one agent, or for the agents a pattern matches |
| `autocode settings unset KEY [--agent AGENT \| --match PATTERN]` | clear a value |
| `autocode history [--agent AGENT] [--kind KIND] [--since TIME] [--until TIME] [--limit N]` | what happened, newest first (see [History Kinds](#history-kinds)) |
| `autocode hosts rm HOST` | remove an offline host's row now. Refused while the host is online, or while an agent, a job or a run needs it. The others go by themselves: see [What the Database Keeps](#what-the-database-keeps) |
| **Tokens** | |
| `autocode token rotate AGENT` | replace an agent's session token |
| `autocode token rotate --admin` | replace the admin token. The new one is saved on the server, in `admin.token`, never printed |
| `autocode token rotate --consumer` | replace the consumer token, in `consumer.token`. Every session token stops working too |

What `answer` takes as `TEXT`: for a message, your reply; for a question, an option's name or your own words; for a
permission, `once`, `always` or `reject: why`; for an approval, `approve` or `reject`, then an option and a note,
like `approve tonight: after 22:00`.

For `history`: `TIME` looks like `2026-10-28T12:00:00Z`. `--limit` is from 1 to 1000; without it, 100. `--kind` takes
one kind, or a group such as `wake.*`.

`token rotate` takes an agent or one flag, never two of them: see [Replace a Leaked Token](#replace-a-leaked-token).

### Exit Codes

Every command ends with one of four exit codes: 0, done; 1, refused or failed, with `refused (CODE): reason` (see
[Error Codes](#error-codes)); 2, wrong usage; 3, the server cannot be reached.

### In an Agent's Shell

A shell that OpenCode started for a session is an agent's shell, whether the session is registered or not. There the
CLI acts as that session's agent. It never uses the owner's token or the consumer token.

- It has `me`, `fire` and `send`: see [Shell Values and Scripts](#shell-values-and-scripts).
- The machine's set-up commands also work: `info`, `serve`, `install`, `uninstall`, `plugin`.
- Every other command is refused, unless you pass a token with `--token`.
- **`!` commands.** A command that you type yourself in that session's TUI, after a `!`, runs in the same kind of
  shell once the session has run a shell. There you act as the agent too.

### History Kinds

History records each event with a kind. `autocode history --kind KIND` and the Kind list of the History tab filter
by one kind, or by a group such as `wake.*`.

| Kind | Recorded when |
|---|---|
| `server.started`, `settings.changed` | the server started; a setting changed |
| `host.online`, `host.offline` | a host connected; the server stopped hearing from it |
| `host.removed` | a host's row was removed: by `expired` (offline for `host_expire_after`) or by `owner` (`autocode hosts rm`). The data has its machine, its folder and when it was last heard from |
| `host.load`, `host.load_failed` | the server loaded an unloaded folder again; it could not |
| `opencode.restarted` | the server started a background service that was gone |
| `session.token`, `session.deleted` | a new session token was made; a session was deleted in OpenCode |
| `token.rotated` | a token was replaced: an agent's, the admin token or the consumer token |
| `agent.registered`, `agent.moved` | a session registered an ID; an ID moved to another session |
| `agent.refused` | a registration was refused: `id_taken` or `session_has_id` |
| `agent.changed` | an agent's description changed |
| `agent.renamed` | an agent was renamed in place. The data has its old ID (`from`), its new one (`to`) and who did it (`by`: `owner` or `self`) |
| `agent.unregistered`, `agent.expired` | an agent was unregistered, and the data says by whom; `expire_after` passed, and the agent was unregistered |
| `agent.paused`, `agent.resumed` | an agent was paused; its pause was ended. The data says by whom |
| `stop_all`, `resume_all` | Stop All and Resume All |
| `agent.error`, `agent.recovered` | a turn failed and the agent went into `error`; a turn succeeded again |
| `turn.ended` | a turn ended: succeeded, failed or interrupted |
| `turn.cut`, `turn.resumed` | a turn was cut by an OpenCode restart; the resume prompt was sent |
| `turn.uncut` | a turn that Autocode took for cut had ended by itself |
| `retry.sent`, `retry.requested`, `retry.exhausted` | a retry prompt was sent; somebody asked for a retry now; `retry_attempts` ran out |
| `recovery.retry`, `recovery.compact`, `recovery.compacted` | after a blocked reply: a retry was planned; a compaction was planned; the compaction was started |
| `recovery.failed`, `recovery.stopped` | after a blocked reply: the compaction failed; the reply was blocked again and Autocode stopped |
| `wake.set`, `wake.cancelled` | a wake was set or cancelled |
| `wake.due`, `wake.fired` | a wake fell due; somebody fired a wake |
| `wake.skipped`, `wake.check_failed` | a wake's check exited 1; it failed or ran too long |
| `wake.merged` | a wake fell due again while it still waited: the two became one |
| `injection.sent` | Autocode typed a prompt, or put messages into a running turn |
| `injection.failed`, `injection.no_turn` | a prompt did not reach its session; it reached OpenCode, but no turn started |
| `message.sent`, `message.dropped` | a message was sent; a waiting message was dropped, because its agent unregistered |
| `message.read` | an agent took a message with `read` or `wait`, or its Inbox item was answered or closed; the data says which. A message that arrived in a prompt or in a running turn is in `injection.sent` |
| `inbox.opened`, `inbox.answered`, `inbox.closed` | an Inbox item was opened, answered or closed |
| `ask.opened`, `ask.sent` | an agent asked a question, met a permission prompt or asked for an approval; the ask was sent to another agent, or to a run of a job |
| `ask.answered`, `ask.escalated` | an ask was answered; an agent handed it to the owner |
| `ask.settled` | an ask was answered in OpenCode itself, for example in the TUI |
| `ask.expired`, `ask.closed` | an approval expired; the owner closed an ask |
| `ask.gone`, `ask.reopened` | an ask ended without an answer, because its turn or its session ended; an answer did not reach OpenCode, and the ask is open again |
| `lock.acquired`, `lock.queued` | an agent got a lock; it joined a queue |
| `lock.renewed`, `lock.released` | a hold was renewed; it was released |
| `lock.left`, `lock.expired` | an agent left a queue; a hold ran out |
| `cap.warned`, `cap.reached`, `cap.lifted` | the cost warning was sent; the agent was paused by its cap; that pause ended |
| `cost.before` | what a session spent before it registered was counted. The data says the steps, the dollars and the days, and how much of it is older than the days kept; or why nothing could be counted |
| `session.compact.noticed`, `session.compact.asked` | the agent was told that a compaction is next; the agent asked for one |
| `session.compacted`, `session.compact.done`, `session.compact.failed` | a compaction was started; it succeeded; OpenCode could not do it, and nothing was compacted |
| `job.set`, `job.deleted` | a job was set or deleted |
| `run.started`, `run.finished`, `run.failed` | a run started, succeeded or failed |
| `run.skipped`, `run.session_deleted` | a scheduled run was skipped, because one was running; the owner deleted the kept session of a run |
| `scheduler.error` | the server hit an error while it delivered to an agent; the data says which |

### Error Codes

A refused call names a code. The CLI prints `refused (CODE): reason`; a tool answers `error (CODE): reason`.

| Code | Means |
|---|---|
| `unauthorized` | no token was sent, or the server does not accept it: it was replaced, revoked, or belongs to another server |
| `forbidden` | this kind of token may not do that. Most owner commands need the admin token |
| `opencode_too_old` | the machine's OpenCode is older than 2.3.0 |
| `not_registered` | no agent has that ID, or the calling session is not registered |
| `id_taken` | the ID is registered already, to another session. For your `agents register`: that session still exists, so add `--force`. For a rename: another agent holds it |
| `session_has_id` | the session is already registered under another ID |
| `reserved_id` | the ID is reserved: `owner`, `autocode`, or one that starts with `job:` |
| `job_exists` | a rename would give one of the agent's jobs the name of a job that exists. Delete or rename one of the two |
| `bad_id` | the ID has characters that are not allowed, or is too long |
| `unknown_session` | `agents register`: the server does not know that session, or it was deleted |
| `session_gone` | the session was deleted in OpenCode. A deleted session never gets a token again |
| `unknown_host` | no host has that ID. See `autocode hosts` |
| `host_online` | `hosts rm`: the host is online. Its row goes after its folder is closed in OpenCode |
| `host_in_use` | `hosts rm`: an agent is registered there, a job is set on it, or a run still runs there. The message says which |
| `no_recipient` | a message reaches nobody: the ID is not registered, or the pattern matches no agent |
| `no_message` | there is no such message, or it is not one that the sender sent or got |
| `too_large` | the text is longer than allowed: 32,000 characters for a message |
| `bad_trigger` | a trigger is not written correctly, its cron line or its duration included. The reason says what is expected |
| `bad_duration`, `bad_time` | a lock's `ttl` or a job's time limit is not a duration; a time does not exist in its zone |
| `lock_busy` | `mode=try`: the lock is held. The reason says by whom |
| `lock_capacity` | the lock exists with another `max` |
| `not_held`, `no_lock` | the agent does not hold that lock; there is no such lock |
| `no_wake`, `no_ask`, `no_approval`, `no_item` | there is no wake of that name for the agent; no ask, approval or Inbox item with that ID |
| `ask_closed`, `closed` | the ask or the Inbox item was already answered or closed |
| `not_in_error` | `retry`: the agent is not in `error` |
| `no_job`, `no_run` | there is no job or run of that name |
| `job_busy` | the job has a run that is running now. The reason names it |
| `run_running` | `job delete-session`: the run is still running |
| `no_session`, `no_host` | `job delete-session`: the run has no kept session; its host is no longer known |
| `not_a_run` | `finish`: the calling agent is not a run of a job |
| `bad_setting` | a setting's name or value is wrong. The reason says what is expected |
| `bad_pattern` | a pattern is not IDs with `*`, separated by commas |
| `bad_request`, `bad_json` | the call itself is wrong. The reason says what |

Errors of a failed turn, such as `provider.auth`, are not Autocode's codes: see
[When Things Fail](#when-things-fail).

## Web UI

The web UI shows you every agent, wake, message, lock, job and cost, with your controls. It has a light and a dark
theme.

### Sign In and Behavior

**Signing in**

- Open the server's address, like `http://machine-a:4848/`, and sign in with the admin token. The consumer
  token and session tokens are refused.
- The token is kept for that browser tab. With **Stay signed in** it is kept on that browser, until **Sign Out**.
- A token that the server stops accepting sends you back to the sign-in form.
- Other sites cannot show the UI inside a frame.

**Tables**

- Lists load again every 10 seconds, Costs every 5 seconds. The footer says how long ago. The result of an action
  shows in the toolbar.
- A table shows 25 rows at first. The "..." row at its end shows 25 more.
- Agents, Hosts and Wakes are grouped, by machine or by agent, with 25 rows a group. Click a group's heading to fold
  or open it; the browser remembers. A link to a row opens its group.
- **Sorting.** Click a column heading to sort by it; click again to reverse. The whole heading cell is clickable.
  The browser remembers the choice per table. Grouped tables sort within each group. History sorts the rows that
  are loaded.
- **First order.** Tables with a date start newest first: Inbox and Messages by Time, Runs by Started, History by
  Time, Agents by Last Active, Hosts by Last Seen, Wakes by Last Set, the days of Costs by Day. Jobs, Locks and
  Costs start by name.

**Filters and links**

- A filter field matches what you type anywhere in an ID: `lead` finds `kaggle:lead`. Commas separate several
  parts. The API and the CLI take exact patterns with `*` instead.
- A filter applies a second after you stop typing, or at once on Enter. History, Costs, Locks, Inbox and Messages
  keep their filter in the address, so that you can bookmark it.
- An agent's or a host's ID is a link to its row on the Agents or Hosts tab. The row is highlighted, and a filter
  that would hide it is cleared.

**Dates** read like `05-Nov-26`, times like `05-Nov-26 14:22:03 PT`, in your browser's zone. The days of the Costs
tab are days in the server's zone.

### Tabs

**Hosts**

- One row per host, grouped by machine: ID, folder, status, process, OpenCode version, plugin version, last seen.
- **Process** is the OpenCode process and its ID. It is one of three: the background service; an `opencode serve`
  that you started; or a private OpenCode server, which a TUI or `opencode run` starts for itself. That happens
  with `--standalone`, or when the background service is turned off.
- **too old**, under the OpenCode version: this OpenCode is older than 2.3.0 (see
  [A Host Is Marked "too old"](#a-host-is-marked-too-old)).
- **no shell values**, under the process: the shells of that host get no Autocode values (see
  [A Host Is Marked "no shell values"](#a-host-is-marked-no-shell-values)).
- Offline hosts show only with the **Offline** box. A link to an offline host turns the box on. A host marked
  "too old" always shows.
- An offline host leaves the list a day after it was last heard from (`host_expire_after`), unless an agent is
  registered there, a job is set on it or a run still runs there. When its folder is opened in OpenCode again, it
  is back.
- A TUI attaches to the background service by default. So its folders stay loaded after the TUI exits, and their
  hosts online, until OpenCode unloads a folder an hour after its last use.

**Agents**

- One row per agent, grouped by machine: status, model, effort, spend, context, host, folder, session, times.
- **Model** is the model that the agent's last step ran: its provider in grey, a slash and the model, like
  `claude-agent/fable`. Hover for its name where OpenCode has one, like `Fable 5.2`. The name comes from the
  agents' steps, so it is there once one agent has run that model. A `claude-agent` model also shows its version,
  taken from that name: `claude-agent/fable (5.2)`.
- **Effort** is how hard the model is set to think, like `high` or `max`. OpenCode calls it the model's variant.
  It is empty when the model runs with its default. You set it in OpenCode, not in Autocode.
- **Spend** is today and in total. A click shows the agent on the Costs tab.
- **Context** is three numbers, like `854K/777K/1M`: what the session holds now, the size at which Autocode
  compacts it, and the most the model can hold. The tooltip has the exact numbers. The bar under it shows how close
  the session is to compaction: amber from 75%, red from 100%. Without a threshold, the bar shows the share of the
  model's window.
- **Last Active** is when the agent's session last started or ended a turn, ran a step or called Autocode. A
  working agent is active now.
- **Status details.** A paused agent's tooltip says who paused it. An agent in `error` shows its error and one of
  `retry 3 in 40s`, `retrying now`, `not retried` or `retries ran out`.
- **In a row:** click the description to edit it; **Pause**, **Resume**, **Retry**, **New Token**, **Unregister**.
- **At the top:** **Stop All**, after you confirm, and **Resume All**; a filter; and the **Unregistered** box. That
  box is off by default. It adds the agents that are gone, dimmed, with their spend.

**Inbox**

- Messages to you, alerts, and asks. You answer each here.
- **The tab's top edge is red-pink** while something waits for you: a message, an alert, or an ask that is yours
  to answer. It shows on every tab; hover over the Inbox tab for how many. Reports do not light it, and neither
  does an ask that an agent or a job is answering, until that one hands it back to you.
- **Sent To** says whom an ask went to. An agent that escalates adds a note.
- **A question:** click an option, or write your words and press **Answer**.
- **A permission:** **Allow Once**, **Allow Always** or **Reject**, with a reason. With Allow Always, OpenCode
  saves the rule for the project.
- **An approval:** an option, a note, then **Approve** or **Reject**. One that may expire says when.
- **A message:** **Answer** it, or **Close** it. **An alert:** **Close** it.
- **Reports** shows and hides the messages that agents marked as reports: they need no answer, and close by
  themselves after 7 days. See [Reports](#reports).
- **Close All** closes the open messages and alerts that are shown, after you confirm. Asks stay open, because an
  agent waits for each.
- **Closed** adds the closed items; the open ones always show. The **Agent** filter shows the items of matching
  agents, and the asks sent to them.
- The Kind is colored: message green, alert red, question sky blue, permission amber, approval violet. A report
  is grey.

**Messages**

- The messages that have not arrived, newest first: up to 200. With the **Processed** box off the server leaves the
  processed ones out, so a message that waits shows however many came after it. The box adds the processed ones:
  then the tab shows the newest 200 of all.
- Columns: ID, sender, recipient, subject, the first 200 characters, and the state (see
  [Message States](#message-states)). Click the text to see it whole, shown as markdown.
- **From** and **To** filter by sender and by recipient.
- **Send a Message** sends as the owner. Looking at a message never changes its state.

**Locks**

- Every lock, as Mutex or N places; its holders, and when each hold runs out; its queue, in order.
- **Release** frees a hold; **Remove** takes an agent out of the queue. Both ask you to confirm, and the agent is
  told. A **Lock** filter.

**Wakes**

- Every agent's wakes: trigger, next run, text and check, who set it, **Last Set**, last fired. The schedule counts
  from Last Set. Click a long text or check to see it whole. A check with its own time limit shows it: "up to 5m".
- **Last 7 Days** is what the wake cost: the dollars of the turns that its prompts started, and the turns under
  them. Hover for how often it fell due and how often its check skipped it. The heading sorts, the costliest
  first. See [What a Wake Costs](#what-a-wake-costs).
- **Fire**, **Cancel**, and **Set a Wake** for any agent. **Check Timeout** in the form is the check's own time
  limit, like `5m`.

**Jobs**

- The jobs: where, model and effort (both as on the Agents tab), trigger, next run, where results go, Last Run,
  and **Set By**: the owner, or the agent that set it.
- **Run Now**, with optional text; **Edit**; **Delete**; **Set a Job**, on a host that is online.
- Below, the runs, newest first: who started it, state, times, its own cost, result, and why one failed or was
  skipped. **Delete Session** removes the kept session of a failed run.
- A link to a job from the Costs tab highlights it.

**Costs**

- One row per agent: status, spend today and in total, the daily cap with a bar of the share spent, and **Last 7
  Days**.
- **Last 7 Days** is one bar per day, today at the right. Hover over a bar for its value.
- An agent's total includes the runs it paid for; the tooltip says how much of it. Runs that no agent started
  have their job's row, `job:<name>`, with status `job`; its ID leads to the job (see
  [Whom a Run's Cost Counts For](#whom-a-runs-cost-counts-for)).
- **Days**, in a row, shows that row's spend per day.
- The **Agent** filter; the **Days** field, which makes the totals cover the last X days (empty: all time); and the
  **Unregistered** box, on by default. Job rows always show.
- The totals row adds up what is shown. Each cost is in one row only, so nothing is counted twice.

**History**

- Every event, newest first: time, kind, agent, host, session, data. Click the data to see it whole.
- The **Agent** filter, and the **Kind** list: one kind with its count, or a group like `wake.*` (see
  [History Kinds](#history-kinds)).
- The "..." row past the loaded rows fetches the next 100 from the server.

**Settings**

- Server-wide values, with **Save**, and **Reset** to the default.
- Pattern rules: edit, move, remove.
- The agents' own values, and **Resolved for an Agent**: the values that one agent gets, and where each comes from.
- A mode setting lists its values. **Agent...** or **Job...** picks one.

**Help** is the Help page: how to use Autocode from OpenCode, the CLI and the web UI.

## Settings

Settings tune delivery, asks, retries, costs and the server. Change them with `autocode settings set` or on the
Settings tab.

### Layers

Autocode uses the first of these that exists for an agent:

1. the agent's own value, set with `--agent ID`;
2. the first pattern rule that matches its ID, set with `--match PATTERN`. A new rule goes last;
3. the server-wide value;
4. the built-in default.

Settings of scope `server` exist only server-wide. `autocode settings --agent ID` shows an agent's values and where
each comes from.

```sh
autocode settings set min_interval 5m
autocode settings set question_mode agent:kaggle:lead --match 'kaggle:worker-*'
autocode settings set daily_usd 20 --agent kaggle:lead
autocode settings unset daily_usd --agent kaggle:lead
```

The first line sets a server-wide value, the second a pattern rule, the third one agent's own value. The fourth
clears that value again.

### All Settings

| Setting | Scope | Default | What it does |
|---|---|---|---|
| `min_interval` | agent | `1m` | at most one prompt per session this often |
| `check_timeout` | agent | `60s` | a wake's check is stopped after this long, unless the wake has its own limit |
| `check_timeout_max` | agent | `10m` | the longest time a wake may ask for its own check (`check_timeout` on the wake) |
| `check_output` | agent | `2000` | how many characters of a check's output go into the prompt |
| `max_tool_wait` | agent | `5m` | the longest a tool waits inside a turn: `autocode_message action=wait`, `autocode_approval action=wait` |
| `question_mode` | agent | `ask` | where questions go: `ask`, `auto`, `agent:<id>` or `job:<name>` (see [Where Each Ask Goes](#where-each-ask-goes)) |
| `auto_answer_text` | agent | "Act according to your best judgement and safe practices to achieve my goals." | the answer in `auto` mode |
| `permission_mode` | agent | `ask` | where permission prompts go: `ask`, `approve`, `agent:<id>` or `job:<name>` |
| `approval_mode` | agent | `ask` | where approvals go: `ask`, `approve`, `agent:<id>` or `job:<name>` |
| `job_mode` | agent | `ask` | jobs that an agent sets: you approve first (`ask`), set at once (`approve`), or refused (`off`) |
| `filter_recovery` | agent | `retry compact` | after a blocked reply: `retry compact`, `retry` or `off` (see [A Blocked Reply](#a-blocked-reply)) |
| `retry_interval` | agent | `1m` | the wait after a failed turn before a retry prompt, and between retries |
| `retry_attempts` | agent | `0` | the most retries in a row before Autocode stops and tells you. 0: no limit |
| `daily_usd` | agent | `off` | the agent's cost cap per day, in dollars: `12.50` or `$12.50`, or `off` |
| `cap_warn` | agent | `90%` | warn the agent at this share of its cap |
| `compact_at` | agent | `50% max 500000` | compact a session past this context size (see [Compaction](#compaction)) |
| `expire_after` | agent | `14d` | unregister an agent this long after its session's last turn |
| `host_expire_after` | server | `1d` | forget a host this long after it was last heard from, once it is offline and nothing needs it. `0`: never (see [What the Database Keeps](#what-the-database-keeps)) |
| `report_close_after` | server | `7d` | close a report in the Inbox this long after it came. `0`: never (see [Reports](#reports)) |
| `history_days` | server | `30` | how many days history is kept, at least 1 (see [What the Database Keeps](#what-the-database-keeps)) |
| `timezone` | server | the server machine's zone | the days of caps and costs, and the zone of `at` and `cron` triggers without one. A `cron` wake keeps the zone it was set with |
| `listen` | server | `localhost,tailscale:4848` | the addresses and the port the server answers on. A change takes effect at the next start. The `--listen` flag wins over it |

Durations look like `90s`, `5m` or `1h30m`.

## Files, Tokens and Backups

Everything of an install lives in one folder, the Autocode home: `~/.autocode/`, or the folder that `AUTOCODE_HOME`
names.

### Where Things Live

| In the home | What | On which machine |
|---|---|---|
| `autocode.db` | the server's database, in SQLite | the server |
| `autocode.db-wal`, `autocode.db-shm` | SQLite's working files. They belong to the database: never delete them while the server runs | the server |
| `autocode-backup.db` | the copy that [Back Up](#back-up) makes | the server |
| `admin.token`, `consumer.token` | the admin and the consumer token, mode 0600 | the server |
| `admin.token.backup`, `consumer.token.backup` | the copies that [Back Up](#back-up) makes | the server |
| `config.json` | optional: the server's ID, as `{"id": "home"}`. The server never writes it | the server |
| `bin/autocode` | the binary, copied there by `install` and by `plugin install` | the server, and each connected machine |
| `client.json` | the client config: the server's URL, the tokens, the expected server ID. Mode 0600 | each connected machine |
| `opencode-service.json` | the binary and the environment of OpenCode's background service, written by the plugin so that the server can start that service again the same way. Mode 0600 | each connected machine |
| `logs/plugin.log` | the plugin's log. At 1 MB it is renamed to `plugin.log.1` and started again | each connected machine |

Two files live outside the home:

- the systemd unit, `~/.config/systemd/user/autocode.service`, on the server machine;
- the plugin, `plugins/autocode/index.js` in OpenCode's config folder, on each connected machine.

Folders that Autocode makes for a home have mode 0700. The server's own log is in the journal:
`journalctl --user -u autocode`.

### Tokens

| Token | Made by | Used by | It allows |
|---|---|---|---|
| admin | the server's first start | your CLI and the web UI | everything |
| consumer | the server's first start | the plugin on every machine; your CLI on a machine without the admin token, for reading | connecting hosts, and getting a session token for any session. Not the web UI. Keep it as secret as the admin token |
| session | the plugin, one per session. A Subagent uses the token of the agent that started it | that session's tools, and the scripts in its shells | acting as that session's agent |

Where the copies of each token are:

- **admin:** `~/.autocode/admin.token` on the server machine; `~/.autocode/client.json` on each machine connected
  with `--admin-token-file`; your browser, while you are signed in; any file that you made to carry it.
- **consumer:** `~/.autocode/consumer.token` on the server machine, and on each machine that you copied it to;
  `~/.autocode/client.json` on every connected machine.
- **session:** OpenCode's storage for plugins, on the agent's machine; the environment of the session's shells, as
  `AUTOCODE_TOKEN`, and of the commands started from them.

- **The database holds no tokens**, only their hashes. So a token whose file is lost cannot be read back from the
  server.
- **The first start** makes the admin and the consumer token, and saves them in the two files. Run in a terminal,
  `autocode serve` also prints them once. A service's log gets only the paths. At a later start the server makes a
  token only if the database has none of that kind.
- **To set the tokens yourself** at the first start, for automation, put them in `AUTOCODE_ADMIN_TOKEN` and
  `AUTOCODE_CONSUMER_TOKEN`. An admin token starts with `aca_`, a consumer token with `acc_`; at least 32 more
  characters follow.
- **A session keeps its token** when the plugin is loaded again or installed again. History shows `session.token`
  only when a new one is made.
- **A session token unused for 30 days is revoked.** Any use counts, also by a long command that still runs in one
  of the session's shells.
- **Deleting a session** in OpenCode revokes its tokens. Unregistering an agent does not: its session can register
  again.
- **Replacing the consumer token** makes every session token stop working too. So does the refusal of a too-old
  OpenCode, for the sessions of its hosts.

To replace a token, see [Replace a Leaked Token](#replace-a-leaked-token).

### What the Database Keeps

The server cleans the database by itself: at each start, and then every 5 seconds.

| What | Kept for |
|---|---|
| history events | `history_days` (30 days) |
| messages, with their text | `history_days` after they were sent, whatever their state: also one that still waits |
| the prompts that Autocode typed | `history_days` |
| closed Inbox items | `history_days` after they were closed. Open items stay |
| answered, rejected and expired asks | `history_days` after they were closed. Open asks stay |
| ended runs, with their results | `history_days` after they ended |
| each agent's spend per day | `history_days`, but at least 31 days |
| each agent's spend in total | for good, also after it unregistered |
| agents, wakes, locks, jobs, settings | until they are removed |
| hosts | `host_expire_after` (1 day) after they were last heard from, once offline. Not while an agent is registered there, a job is set on it or a run still runs there |

`history_days` is a whole number of days, at least 1. To change it: `autocode settings set history_days 60`.

`host_expire_after` is a duration, like `1d` or `36h`; `0` keeps every host. A host that is forgotten loses its row,
its sessions and their tokens; History says `host.removed`. Nothing else is lost: when its folder is opened in
OpenCode again, it is a host again. To remove one offline host at once: `autocode hosts rm HOST`.

The file does not shrink by itself: the space of deleted rows is used again for new ones. To make it smaller, see
[Shrink the Database](#shrink-the-database).

### Back Up

A backup is the database and the two token files. The token files matter: the database holds only hashes. Run this
on the server machine. The server may keep running.

1. Copy the database into a backup file. This needs the `sqlite3` command-line tool, which is not part of Autocode:

   ```sh
   sqlite3 "$HOME/.autocode/autocode.db" ".backup '$HOME/.autocode/autocode-backup.db'"
   ```

2. Copy the two token files beside it:

   ```sh
   cp -p ~/.autocode/admin.token ~/.autocode/admin.token.backup
   cp -p ~/.autocode/consumer.token ~/.autocode/consumer.token.backup
   ```

3. Check: `ls -l ~/.autocode/` shows the three copies, with the time of the backup.
4. To survive the loss of the machine, copy the three files to a safe place, and `config.json` if you have one. Keep
   the copies private: they hold the tokens.

Each backup replaces the last one. Without `sqlite3`, do step 1 with the server stopped:
`systemctl --user stop autocode`, then `cp -p ~/.autocode/autocode.db ~/.autocode/autocode-backup.db`, then
`systemctl --user start autocode`.

## Operate

A restart of OpenCode is part of several procedures here: `opencode service restart` for the background service.
It closes open TUIs and cuts the turns that run on that machine; Autocode resumes the agents' turns.

### Upgrade

The server and the plugin come from one binary and are tested together: bring every machine to the same version.

1. **Back up**, on the server machine: see [Back Up](#back-up).
2. **Keep the old binary**, in case you must go back:

   ```sh
   cp -p ~/.autocode/bin/autocode ~/.autocode/bin/autocode-old
   ```

3. **Find the flags of the last install.** `systemctl --user cat autocode` prints the unit. Its `ExecStart` line
   ends with the flags the service was installed with.
4. **Run the new binary's `install` with the same flags.** From the folder where you built it, for example:

   ```sh
   dist/autocode install --id home --listen localhost,tailscale:4848
   ```

   It replaces `~/.autocode/bin/autocode` and restarts the service. The data and the tokens stay. The new server
   brings the database to its own schema when it starts.
5. **Check:** `autocode info` shows the new version.
6. **On the server machine,** run `autocode plugin install` as in [Connect Each Machine](#connect-each-machine),
   then restart OpenCode. Do not repeat step 2 there: the binary is already the new one.
7. **On each other connected machine:** keep the old binary as in step 2, copy the new binary there as
   `~/autocode`, run `~/autocode plugin install` with the same flags as before, then restart OpenCode.
8. **Check:** `autocode hosts` shows the new version under PLUGIN, for each host that is online.

### Roll Back

An older binary never opens a database that a newer one has changed. It stops with a line like this in the log:

```
the database at /home/you/.autocode/autocode.db is at schema 21, newer than this autocode knows (20)
```

Going back needs the old binary that you kept. If the newer version changed the database, it also needs the backup
from before the upgrade, and what happened since that backup is lost. So try the old binary first. Run this on the
server machine.

1. Run the old binary's `install`, with the flags that `systemctl --user cat autocode` shows:

   ```sh
   ~/.autocode/bin/autocode-old install --id home --listen localhost,tailscale:4848
   ```

2. Check: `autocode info`. If it shows the old version, the newer version had not changed the database, and nothing
   is lost: go to step 5.
3. If `install` says "the service did not answer", and `journalctl --user -u autocode -n 20` shows the line above,
   put the backup back. Check first that it is from before the upgrade: `ls -l ~/.autocode/autocode-backup.db`
   shows its time.

   ```sh
   systemctl --user stop autocode
   cp -p ~/.autocode/autocode.db ~/.autocode/autocode-newer.db
   cp -p ~/.autocode/autocode-backup.db ~/.autocode/autocode.db
   rm -f ~/.autocode/autocode.db-wal ~/.autocode/autocode.db-shm
   systemctl --user start autocode
   ```

   The second line keeps the newer database, in case you go forward again. If you replaced a token after the backup,
   put the two token files back too, before the start: copy `admin.token.backup` over `admin.token`, and
   `consumer.token.backup` over `consumer.token`.
4. Check: `autocode info` shows the old version, and `journalctl --user -u autocode -n 20` shows no error.
5. On the server machine, run `autocode plugin install` as in [Connect Each Machine](#connect-each-machine): the
   binary there is the old one again. On each other connected machine, run
   `~/.autocode/bin/autocode-old plugin install` with the same flags as before. Then restart OpenCode on each.
6. Check: `autocode hosts` shows the old version under PLUGIN.

Without a backup from before the upgrade, a database that the newer version changed cannot go back: install the
newer binary again. Without `autocode-old`, build the old version from its source.

### Move the Server

To move the server to another machine, copy its data and install it there with the same server ID. In this example
the server moves from `machine-a` to `machine-c`.

**During the move** agents keep working, but get no prompts, and their `autocode_*` tools answer with an error. The
plugins keep what they have to report, such as costs, in memory only: the restart of step 5 loses what was not
sent. So move the server while the agents are idle, or after Stop All.

1. **On `machine-a`,** note the flags of the install: `systemctl --user cat autocode`. Then stop the server:
   `systemctl --user stop autocode`.
2. **On `machine-c`,** make the home and copy the data into it:

   ```sh
   mkdir -p ~/.autocode && chmod 700 ~/.autocode
   scp -p 'machine-a:.autocode/autocode.db*' 'machine-a:.autocode/*.token' ~/.autocode/
   ```

   If `machine-a` has `~/.autocode/config.json`, copy it the same way.
3. **On `machine-c`,** copy the binary there as `~/autocode`, as in
   [Connect Each Machine](#connect-each-machine), step 1. Install the server with the same ID, then keep it running
   after you log out:

   ```sh
   ~/autocode install --id home --listen localhost,tailscale:4848
   sudo loginctl enable-linger $USER
   ```

   If `--listen` named an address of `machine-a`, give `machine-c`'s. The copied tokens stay valid: the server makes
   a token only if the database has none of that kind.
4. **Check:** `~/.autocode/bin/autocode info` there prints the same server ID. Sign in to the web UI at the new
   address, with the same admin token.
5. **On every connected machine,** run `plugin install` with the new address and the other flags as before, then
   restart OpenCode there. On `machine-c` itself the address is `http://127.0.0.1:4848`. An admin token that the
   client config already holds stays in it.

   ```sh
   autocode plugin install --url http://machine-c:4848 --server-id home \
     --consumer-token-file ~/.autocode/consumer.token
   ```

6. **Check:** `autocode hosts` lists the hosts as online again, once their folders are used.
7. **On `machine-a`,** remove the service: `~/.autocode/bin/autocode uninstall`. Then delete the old data in
   `~/.autocode/` there: `autocode.db*`, `autocode-backup.db`, `admin.token` and the two `.backup` files. Keep
   `client.json`, `consumer.token` and `bin/` if agents still run on that machine.

What changes with the machine:

- **Restarts and unloaded folders.** Autocode starts a background service that is gone, and loads an unloaded
  folder again, only on the server's own machine. After the move that is `machine-c`. The agents on `machine-a` are
  then in the position of any other machine: see
  [OpenCode Restarts and Unloaded Folders](#opencode-restarts-and-unloaded-folders).
- **The zone.** The `timezone` setting defaults to the server machine's zone. If the new machine is in another
  zone, the days of caps and costs move with it. To keep the old zone, set it:
  `autocode settings set timezone America/Los_Angeles`.
- **The ID.** Without `--id` and without `config.json`, the server ID is the machine's name, so it would change.
  Machines connected with `--server-id` then refuse the server.
- **Old shells.** Shells and commands that agents started before the move keep the old address.

### Replace a Leaked Token

The old token stops working the moment you replace it. The command never prints a token.

| Token | Replace it with | What stops working at once | What you do next |
|---|---|---|---|
| an agent's session token | `autocode token rotate AGENT`, or **New Token** on the Agents tab | that session's old token | look at the commands that the agent left running: see below |
| the consumer token | `autocode token rotate --consumer` | the old consumer token, and every session token | give each other machine the new token: see below |
| the admin token | `autocode token rotate --admin` | the old admin token | sign in to the web UI again; then see below |

Run `--consumer` and `--admin` where you are the owner: normally on the server machine. The server saves the new
token in its file there, `~/.autocode/consumer.token` or `~/.autocode/admin.token` (mode 0600), and the command
prints that path. A session that is not registered has no ID to give to `token rotate AGENT`: replace the consumer
token instead.

**After `--consumer`**

1. On every other connected machine, copy the new file and install the plugin again with it:

   ```sh
   scp -p machine-a:.autocode/consumer.token ~/.autocode/consumer.token
   autocode plugin install --url http://machine-a:4848 --server-id home \
     --consumer-token-file ~/.autocode/consumer.token
   ```

2. Check: `autocode hosts` lists the hosts as online again, within about a minute.

- **No OpenCode restart is needed.** A running plugin takes the new token from the client config and reconnects by
  itself. Until a machine has the new token, its hosts are offline.
- **Why every session token stops too:** whoever held the consumer token could get a session token for any session.
  The plugins get new session tokens by themselves when they reconnect.

**After `--admin`**

1. Sign in to the web UI again, with the new token.
2. On each other machine whose client config holds the admin token: copy the new file there, and run
   `autocode plugin install` again with `--admin-token-file` and the other flags as before.
3. **If the admin token leaked, replace the consumer token too:** with the admin token one can make a new consumer
   token. Replace the admin token first.

**More to know**

- **Shells and commands.** A shell that a session opens after the replacement carries the new session token, and so
  does a wake's check. A command that an agent started before keeps the old one: its closing
  `autocode fire me ...` is refused. So ask each agent to look at the commands that it left running, or fire the
  wake yourself: `autocode fire AGENT WAKE`. This holds after `--consumer` and after `token rotate AGENT` alike.
- **This machine's client config.** If it holds the admin or the consumer token that you replaced, the command puts
  the new one into it. It does so only when that config has the same address as the command used. A config with
  `http://machine-a:4848` is left alone when the command ran with `http://127.0.0.1:4848`, and the command says so:
  run `autocode plugin install` again there.
- **If the command cannot write the client config,** it says so and ends with exit code 1. The server has replaced
  the token all the same: run `autocode plugin install` again on this machine.
- **One thing per command:** an agent, `--admin` or `--consumer`. Two of them together are a usage error.
- **Delete the copies** of the old token that you made by hand.

**The admin token is lost**

No command recovers it: the database holds only its hash.

- If `~/.autocode/admin.token` exists on the server machine, read it there.
- If the file is gone, but the client config of another machine still holds the admin token: run
  `autocode token rotate --admin` on that machine. The server saves a new file.
- If no copy is left, make the server create a new one. Run this on the server machine. It needs `sqlite3`:

  1. Back up: see [Back Up](#back-up).
  2. `systemctl --user stop autocode`
  3. `sqlite3 "$HOME/.autocode/autocode.db" "DELETE FROM tokens WHERE kind = 'admin'"`
  4. `systemctl --user start autocode`. At that start the server finds no admin token in the database, makes a new
     one, and saves it in `~/.autocode/admin.token`.

### Stop an Agent That Overspends

1. **See who spends:** the Costs tab, or `autocode costs`.
2. **Stop new prompts:** `autocode pause AGENT`, or **Pause** on the Agents tab. Its wakes and messages wait. Pause
   interrupts nothing: a turn that is running goes on to its end, and so do the Subagents that work for the agent.
   When a Subagent ends, OpenCode starts a turn of the agent with its result, also while the agent is paused.
3. **Stop the running turn**, if you cannot wait for its end. No Autocode command interrupts the turn of one agent.
   You have two ways:
   - interrupt it in OpenCode. The Agents tab shows the agent's machine and folder. There, start a TUI in that
     folder, open the session titled `@` and the agent's ID, and stop the turn as you stop any turn in OpenCode;
   - `autocode stop-all`, or **Stop All**. It pauses every agent. It interrupts every running turn, the Subagents
     that work for an agent, and the turn that OpenCode starts in an agent when its Subagent is stopped. Afterwards
     `autocode resume-all` ends those pauses; the agent that you paused in step 2 stays paused. The other agents
     lose their running turn: each goes on at its next wake or message.
4. **Cap it for the future:** `autocode settings set daily_usd 20 --agent AGENT`. Past the cap the agent is paused
   after its turn, until the next day.
5. **End your pause** when you are ready: `autocode resume AGENT`. The cap still holds: an agent that is already
   past it today is paused by the cap after its next turn. Only a Resume of an agent that the cap itself paused
   switches the cap off for the rest of that day.

For a run of a job:

- **No command stops one run** by its ID. A run stops at its time limit, or when a turn ends past its cost cap.
- **To end a run now,** make its job's time limit shorter than the run's age. On the Jobs tab, **Edit** the job and
  set its Time Limit to `1m`. Within seconds the run fails as past its time limit, and its turn is interrupted.
  Then set the limit back.
- **To stop new runs** of a job, set it again with another trigger, or delete it: `autocode job delete NAME`.
  Deleting does not stop a run that is running: it goes on, with the time limit and the cost cap it started with.
- **Stop All** also pauses runs and interrupts their turns. An interrupted run is not finished. It keeps its job
  busy until its time limit, so scheduled runs are recorded as `skipped` meanwhile, unless a later turn finishes it
  or you end it as above.

Stop All interrupts turns, those of Subagents too. It does not look for commands that agents left running in the
background, such as a training command started with `nohup`: stop those yourself.

### Shrink the Database

Autocode has no command for this. The database is a plain SQLite file, so `sqlite3` can rebuild it without the
empty space. Run this on the server machine.

1. To keep less, lower `history_days` first, and wait a minute for the cleanup. This also deletes the messages
   older than that, those that still wait included.
2. Back up: see [Back Up](#back-up).
3. `systemctl --user stop autocode`
4. `sqlite3 "$HOME/.autocode/autocode.db" "VACUUM;"`
5. `systemctl --user start autocode`
6. Check: `autocode info` answers, and `ls -l ~/.autocode/autocode.db` shows the new size.

## Troubleshooting

Find the symptom, then follow its checks in order.

Where to look first:

| What | Where |
|---|---|
| the server's log | `journalctl --user -u autocode`, on the server machine |
| the plugin's log | `~/.autocode/logs/plugin.log`, on the agent's machine (see [Lines in the Plugin's Log](#lines-in-the-plugins-log)) |
| what happened to an agent | `autocode history --agent AGENT`, or the History tab |
| which hosts are connected | `autocode hosts`, or the Hosts tab |

### I Cannot Sign In

1. Use the admin token. The sign-in form refuses the consumer token and session tokens.
2. Read it again on the server machine: `cat ~/.autocode/admin.token`. Copy the whole line.
3. If it was replaced with `autocode token rotate --admin`, the old one no longer works: use the new file.
4. If the page does not load at all, the server is down or cannot be reached: `systemctl --user status autocode`
   on the server machine, and check the address and port.
5. If the file is gone: see "The admin token is lost" in [Replace a Leaked Token](#replace-a-leaked-token).

### The Server Does Not Start

The symptom: `autocode install` waits, then says "the service did not answer"; or the web UI does not load after an
upgrade. Read the log, `journalctl --user -u autocode -n 20`, and find its line here:

| The log says | Do this |
|---|---|
| `is at schema N, newer than this autocode knows` | this binary is older than the database: install the newer binary again, or [roll back](#roll-back) |
| a failure to listen on an address, or a port in use | another program holds the port, or `--listen` names an address that this machine does not have: free the port, or change `--listen` |
| `needs a port at the end`, `bad port in`, `is not a host name or IPv4 address` | `--listen` or the `listen` setting is written wrongly (see [Install the Server](#install-the-server)) |
| `the server ID from ... must be 1 to 255 characters` | fix `--id`, or the `id` in `~/.autocode/config.json` |
| `cannot read .../config.json` | `config.json` is not valid JSON: fix it or delete it |
| an SQL error right after an upgrade | the new version could not change the database. It changes it in numbered steps, and a step that fails is undone; steps before it stay. [Roll back](#roll-back): the old binary opens the database if no step had passed, and refuses it otherwise. Keep the log |

### Agents Did Not Come Back After a Reboot

The symptom: the machine was restarted or lost power, the server answers again, and its agents stay `offline`.

1. **Does anything wait for them?** Autocode starts OpenCode only for a host with something unfinished (see
   [A Power Cut or a Reboot](#a-power-cut-or-a-reboot)). An agent that was idle and has no wake has nothing: it
   comes back when you open its folder.
2. **Could Autocode start OpenCode?** `autocode history --kind host.load_failed` says when it could not, and why.
   "Failed to start server" means that it did not find OpenCode's binary: start OpenCode once yourself, with
   `opencode service restart` in a terminal. The plugin then writes down where the binary is, and Autocode starts
   it by itself from then on.
3. **Is it another machine than the server's?** Autocode cannot start OpenCode there: start it yourself.
4. **Is OpenCode not the background service?** For an `opencode serve` that is gone, the Inbox has an alert:
   start it yourself.

### A Host Is Offline Though OpenCode Runs

A host is one project folder, not the machine. So one machine can have online and offline hosts at once. A host goes
offline 65 seconds after the server last heard from its plugin.

1. **Was the folder unused for an hour?** OpenCode unloads it then, and its host goes offline. Start OpenCode in
   the folder, or send a prompt to one of its sessions. On the server's own machine Autocode loads the folder again
   by itself when the host has something unfinished. On every other machine it does not: see
   [OpenCode Restarts and Unloaded Folders](#opencode-restarts-and-unloaded-folders) for what keeps a folder loaded.
2. **Is the host marked "too old"?** See [A Host Is Marked "too old"](#a-host-is-marked-too-old).
3. **Can that machine reach the server?** Run `autocode hosts` there.
   - Exit code 3: the server cannot be reached. Check the network, Tailscale, and the `url` in
     `~/.autocode/client.json`.
   - "the server at ... is X, not Y": the client config expects another server ID.
   - `refused (unauthorized)`: the consumer token was replaced. Give that machine the new one: see
     [Replace a Leaked Token](#replace-a-leaked-token). No restart is needed for that.
4. **Read the plugin's log** on that machine: `tail ~/.autocode/logs/plugin.log`.
5. **Was OpenCode restarted after the first `autocode plugin install`?** If not, restart it:
   `opencode service restart`. This closes open TUIs and cuts the turns that run there; Autocode resumes the agents'
   turns.

The row of a host whose folder is gone leaves by itself, a day after the host was last heard from
(`host_expire_after`). To remove it now: `autocode hosts rm HOST`.

### The Tools Are Missing

The symptom: an agent says that it has no `autocode_me` tool; or `autocode hosts` lists no host for the machine.

1. **Was a folder used?** OpenCode loads the plugin with a folder only when that folder is used. Open the folder in
   a TUI, or send a prompt.
2. **Is the plugin installed?** As the user that OpenCode runs as, on that machine,
   `ls ~/.config/opencode/plugins/autocode/` should list `index.js`. If OpenCode uses another config folder, look
   there: `$OPENCODE_CONFIG_DIR`, else
   `$XDG_CONFIG_HOME/opencode`. If the file is missing, run `autocode plugin install` (see
   [Connect Each Machine](#connect-each-machine)). OpenCode needs no entry in its config for it.
3. **Was OpenCode started before the install?** Restart it: `opencode service restart`.
4. **Did the plugin start?** `tail ~/.autocode/logs/plugin.log` on that machine. If there are no new lines at all,
   OpenCode did not load the plugin: look in OpenCode's own log, usually
   `~/.local/share/opencode/log/opencode.log`.

If the tools exist but answer `error: the Autocode server is not reachable`, the host is offline: see
[A Host Is Offline Though OpenCode Runs](#a-host-is-offline-though-opencode-runs).

### A Host Is Marked "too old"

The symptom: "too old" on the Hosts tab or in `autocode hosts`; or a tool says "this OpenCode is v2.2.0; Autocode
needs v2.3.0 or later. Update OpenCode on this machine, then start it again."

1. Check the version on that machine: `opencode --version`.
2. Update that OpenCode to 2.3.0 or later, and start it again.
3. Check: `autocode hosts` shows the host online, without the mark.

Until then nothing on the hosts of that OpenCode is served:

- they are offline, and their sessions' tokens stop working;
- the `autocode_*` tools there answer with the reason above;
- their shells get no Autocode values;
- the Hosts tab keeps the mark, and shows such a host also when the **Offline** box is off.

You get one Inbox alert for the host and its version. Once closed, it does not come again for `history_days`. No
"OpenCode ... is gone" alert is raised for such a host.

### A Host Is Marked "no shell values"

The symptom: **no shell values** on the Hosts tab, and `no` under SHELL VALUES in `autocode hosts`; or a script in
an agent's shell fails with "this shell belongs to an OpenCode session but has no AUTOCODE_TOKEN".

Only the scripts that agents start are affected. The tools in the conversation work without shell values, and so do
the checks of wakes.

1. **If SHELL VALUES says `no`:** the plugin cannot reach the local API of its own OpenCode server, which it needs
   to set the values. Two kinds of OpenCode server are like that:
   - a private OpenCode server, which a TUI or `opencode run` starts for itself: with `--standalone`, or when the
     background service is turned off;
   - an `opencode serve` that was started without `--port`, or without a password. OpenCode reads the password
     from `OPENCODE_PASSWORD` or `OPENCODE_SERVER_PASSWORD`.

   Stop that OpenCode. Then open the folder with the background service, which a TUI uses by default. Or start
   `opencode serve` with `--port`, and with one of the two variables set. The mark goes when the plugin starts in
   the folder again, in a server that it can reach.
2. **If it says `yes`:** the Autocode server could not be reached when that shell started, or the host is marked
   "too old". Open a new shell once the host is online.
3. **Meanwhile,** a script can pass a token with `--token`.

### Lines in the Plugin's Log

`~/.autocode/logs/plugin.log`, on the agent's machine.

| Line | Means | Do this |
|---|---|---|
| `started for FOLDER as HOST` | the plugin runs for that folder | nothing |
| `connected to SERVER as HOST` | the host is online | nothing |
| `no client config: the plugin stays off` | `client.json` is missing or incomplete, so the tools are missing too | run `autocode plugin install` on that machine |
| `channel: ...; next try in N ms` | the server cannot be reached, or refused the token. The reason is in the line | check the network and the URL. After a token change, install the plugin again |
| `the client config has a new consumer token: using it` | the consumer token was replaced, and the plugin took the new one | nothing |
| `the server at URL is X, not Y` | the server's ID is not the `server_id` of the client config | fix the client config with `plugin install --server-id`, or the server's `--id` |
| `refused: this OpenCode is ...` | OpenCode is older than 2.3.0 | update OpenCode |
| `superseded by a newer instance of this host; waiting` | two OpenCode processes have the same folder open. The newest one holds the connection; the older takes over when it is gone | nothing: tools and shell values work in both |
| `no shell values for SESSION: ...` | the plugin could not set a session's shell values | see [A Host Is Marked "no shell values"](#a-host-is-marked-no-shell-values) |
| `more than 50000 events wait for the server: the oldest are dropped` | the server has been away for very long | bring the server back |

### A Wake Does Not Come

Run `autocode wakes AGENT`, or open the Wakes tab: it shows when the wake falls due next and when it was last fired.
Then check, in order:

1. **The agent's status**, in `autocode agents`. A `paused`, `offline` or `waiting` agent gets no prompts. For an
   agent in `error`, a wake without a check comes with the next retry prompt; a wake with a check waits until a
   turn has succeeded.
2. **A long turn.** A wake waits for the running turn to end.
3. **The check.** Exit 1 skips the wake quietly: History shows `wake.skipped`. A failed check shows
   `wake.check_failed`.
4. **`min_interval`.** Was the last prompt less than `min_interval` ago? The wake comes when it has passed.
5. **History:** `autocode history --agent AGENT --kind 'wake.*'` shows whether the wake fell due (`wake.due`).

### A Message Does Not Arrive

Run `autocode messages --from SENDER`: it lists what the sender sent, to whomever, with the newest 200 messages.
Read the STATE column. [Message States](#message-states) says what each state means.

1. **`queued`:** it waits. Look at the recipient's status in `autocode agents`: a paused, offline or `waiting`
   agent, or one in `error`, gets it later. A working agent gets it when the tool call that runs now ends. For an
   idle agent, `min_interval` has not passed yet.
2. **`processed`:** it arrived. With `(read)` or `(wait)` the agent took it with its own tool, so no prompt came.
3. **`dropped`:** the agent unregistered before it arrived. Send it again, to an agent that is registered.
4. **Not listed:** the send was refused, for an unknown ID or a pattern that matches nobody; IDs are
   case-sensitive. Or the message is older than `history_days` and was deleted, even if it still waited.

### An Agent Is Not Idle or Working

| Status | Check |
|---|---|
| `offline` | Its host is offline: see [A Host Is Offline Though OpenCode Runs](#a-host-is-offline-though-opencode-runs). Or its session was deleted in OpenCode: move the ID and its wakes to a new session with `autocode agents register ID --session SES` |
| `waiting` | It has an open ask. `autocode inbox` shows it; TO says whether it went to another agent. Answer it. Its wakes and messages wait until then |
| `error` | Its last turn failed: `autocode agents AGENT --json` shows the error, and [A Failed Turn](#a-failed-turn) what Autocode does. If the error is not retried, fix the cause, then **Retry** or `autocode retry AGENT`. If it is retried without end, set `retry_attempts`, or pause the agent |
| `paused` by `cap` | It passed `daily_usd` today. It stays paused until the next day, until you raise the cap with `autocode settings set daily_usd 20 --agent AGENT`, or until you resume it |
| `paused` by `owner` or `stop-all` | You paused it, or Stop All did. End the pause: `autocode resume AGENT`, or `autocode resume-all` |

### Other Symptoms

| Symptom | Check |
|---|---|
| An agent seems to ignore Autocode | Ask it to load the `autocode` skill, or to call `autocode_me action=help` |
| A run failed | Its Inbox alert says why: `time limit`, `run cap`, `the session could not start`, or the error of its failed turn. Its session is kept until you delete it: see [How a Run Ends](#how-a-run-ends). A scheduled run that falls due while another is running is not a failure: it is `skipped` |
| An agent or a run spends too much | See [Stop an Agent That Overspends](#stop-an-agent-that-overspends). No command interrupts the turn of one agent, or stops one run by its ID |
| Registering says `id_taken` | The ID is registered already, to another session. Choose another ID, unregister the agent that holds it, or move the ID to the new session: `autocode agents register ID --session SES` (with `--force` when the old session still exists) |
| A tool says `session_gone` | The session was deleted in OpenCode. A deleted session never gets a token again: use a new session |
| A session's context grows without end | Is `compact_at` `off` for it? `autocode settings --agent AGENT` shows it. Otherwise look in History: `session.compact.failed` says that OpenCode could not compact it, and why |
| OpenCode was restarted under a turn | Nothing to do if it is back: see [OpenCode Restarts and Unloaded Folders](#opencode-restarts-and-unloaded-folders) |
| A lock stays held | `autocode locks` shows the holder and when the hold runs out. It is freed then, or at once with `autocode locks release NAME AGENT`. Unregistering an agent releases its locks |
| The database file is large | It never shrinks by itself: see [What the Database Keeps](#what-the-database-keeps) and [Shrink the Database](#shrink-the-database) |
| The CLI says "the server at ... is X, not Y" | The address answers with another server ID than expected. No token was sent. Fix `--url`, or the expected ID |
| The CLI says "in an agent's shell the CLI has only me, fire and send" | You ran an owner command in an agent's shell. Run it in your own terminal, or pass `--token` |
| The CLI prints `refused (unauthorized)` | The token is not accepted: it was replaced, or the client config points at another server |

## Development

To build Autocode from source, run its tests or change it, see [`DEVELOPMENT.md`](DEVELOPMENT.md): the layout of the
repository, the build, the test suites and the CI scripts.
