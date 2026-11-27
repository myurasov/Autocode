# Autocode <!-- omit in toc -->

Autocode is a long-term autonomy support framework for [OpenCode](https://opencode.ai) agents. It gives AI coding
agents what they need to work on their own for days or weeks, alone or as a team, and keeps them under your control.

It is for developers who use OpenCode 2 (2.3.0 or later) on one Linux machine or several.

**What you install:** one Autocode server on one of your machines, and a plugin in each machine's OpenCode. Both
come from a single `autocode` binary, which is also the command line and holds the web UI. You build it from source
and host it yourself.

- [Why Autocode](#why-autocode)
- [How It Works](#how-it-works)
- [Install](#install)
- [First Agent](#first-agent)
- [Using Autocode](#using-autocode)
- [Where to Go Next](#where-to-go-next)
- [Development](#development)
- [License](#license)

## Why Autocode

An agent in a conversation stops when its turn ends and waits for someone to type. To work for days with nobody
watching, it must come back to its work, work with others, get past failures and stay within limits. Every feature
of Autocode is there for that.

What Autocode provides:

| Feature | What It Does |
|---|---|
| **Wakes** | bring an agent back to its work with nobody prompting it: on a schedule, at a time, or when it has been idle. A check, a shell command, skips a wake when there is nothing to do, at no model cost |
| **Long commands** | an agent starts a command that runs for hours in the background, and is woken when it ends |
| **Messages** | agents work as a team: they write to each other and to you, on any machine |
| **Locks** | agents share what only one may use at a time, such as a GPU, with a queue and time limits |
| **Recovery** | a failed turn is tried again and a turn cut by a restart is resumed, so the work goes on unattended |
| **Limits** | a long session is compacted so that it can go on for weeks, and a daily cost cap bounds each agent |
| **Your Inbox** | an agent that needs a decision asks and waits, and the others keep working. You answer its questions, permission prompts and approvals in the web UI or with `autocode inbox` |
| **Jobs** | a saved task that a fresh agent runs, on a schedule or when you or an agent start it |
| **Control** | pause and resume an agent, stop all agents at once, and read the history of what happened |

## How It Works

Each machine's OpenCode connects to the one Autocode server through the plugin. The command line and the web UI
talk to the same server.

| Word | Meaning |
|---|---|
| owner | you, the person who runs Autocode |
| session | one OpenCode conversation |
| turn | one round of work in a session, from a prompt until the model stops and waits |
| agent | a session that has registered with Autocode under an ID, such as `kaggle:lead` |
| host | one project folder that OpenCode has open on one machine; a machine usually has several |

- **The server** keeps the agents, their wakes and messages, your Inbox, the settings and the history, and decides
  what is due.
- **The plugin** connects every project folder that OpenCode opens to the server. It reports when turns start and
  end, types Autocode's prompts into agents' sessions, and gives agents their tools, named `autocode_*`. You do not
  call the tools: you ask the agent in plain words. A session that has not registered gets no prompts from Autocode.
- **Delivery:** Autocode never interrupts a turn with a wake. It waits until the session is idle, and sends at most
  one prompt a minute (the `min_interval` setting). Wakes that pile up arrive in one prompt, which starts with
  `[autocode]`. Messages do not wait: they join a running turn at its next step, the model's next call.

## Install

You do four things: get the binary, install the server on one machine, connect each machine's OpenCode, and sign in.
The examples use two machines: `machine-a`, which runs the server, and `machine-b`. Both may run agents.

You need:

- OpenCode 2.3.0 or later on every machine (`opencode --version`). An older one is refused: `autocode hosts` and
  the Hosts tab of the web UI mark it "too old".
- Linux with systemd on the server machine, ARM64 or x86-64. Other machines run Linux, or macOS on ARM64.
- Your normal user on each machine, not root.
- A network between the machines: [Tailscale](https://tailscale.com), or a LAN that you trust. Autocode speaks plain
  HTTP. Tailscale encrypts it; on a plain LAN the tokens, which are Autocode's passwords, travel unencrypted.
- To build the binary, on `machine-a` only: git, [Bun](https://bun.sh) and Docker. Your user must be able to run
  `docker` without `sudo`. Autocode's own tests use Bun 1.4.3. `machine-b` needs none of these: it gets a copy of
  the binary.

### 1. Get the Binary

Releases on GitHub carry no binaries: you build `autocode` from source, once. The build downloads packages and a
container image, and takes some minutes. If `machine-b` has another CPU than `machine-a` (`uname -m` prints it on
each), or is a Mac, type `AUTOCODE_TARGETS=all ci/dist.sh` as the last line. On `machine-a`:

```sh
git clone https://github.com/myurasov/Autocode
cd Autocode
ci/dist.sh
```

It worked if the last line names the build, like `build 1: v1.1.0-build1`. The binary is `dist/autocode`, for the
CPU of the machine that built it. With `AUTOCODE_TARGETS=all` the build also makes `dist/autocode-linux-x64` (for
`x86_64`), `dist/autocode-linux-arm64` (for `aarch64`) and `dist/autocode-darwin-arm64` (for a Mac). A clone gives the
`main` branch, the newest code. To build a release, check out its tag before `ci/dist.sh`: `git tag` lists them.

### 2. Install the Server

On `machine-a`, in the `Autocode` folder. With Tailscale:

```sh
dist/autocode install --id home --listen localhost,tailscale:4848
```

On a LAN without Tailscale:

```sh
dist/autocode install --id home --listen 0.0.0.0:4848
```

- `--id` names this server; `home` is an example. Without it, the name is the machine's name.
- `--listen` says where the server answers, here on port 4848. `localhost,tailscale` is this machine itself and its
  Tailscale address; it is also the default. On a machine without Tailscale, that form answers on the machine
  itself only. `0.0.0.0` is every address of the machine. If the machine has a firewall, open port 4848 in it.
- To change `--listen` later, run `autocode install` again with the same `--id` and the new value. It restarts the
  service. The tokens and the data stay.

The command copies the binary to `~/.autocode/bin/autocode`, starts a systemd user service named `autocode`, and
creates two tokens. A token is a secret, like a password:

| File on `machine-a` | Token | For |
|---|---|---|
| `~/.autocode/admin.token` | the admin token | you: it proves that you are the owner, in the web UI and at the command line |
| `~/.autocode/consumer.token` | the consumer token | each machine's plugin: it connects that machine's OpenCode to the server |

It worked if it prints `server home ... answers at http://127.0.0.1:4848` and where the tokens are.
`systemctl --user status autocode` then says `active (running)`.

Run this once, or the server stops when you log out of `machine-a`: `sudo loginctl enable-linger $USER`. Without
lingering, systemd runs the service only while you are logged in, and does not start it at boot.

**Typing `autocode`.** The binary is now `~/.autocode/bin/autocode`, and the rest of this README writes `autocode`
for it. Nothing changes the `PATH` of your own terminal: type the full path, or add the folder once and open a new
terminal. For bash (for zsh, write `~/.zshrc`):

```sh
echo 'export PATH="$HOME/.autocode/bin:$PATH"' >> ~/.bashrc
```

Scripts that agents start need no setup: the plugin puts that folder first in the `PATH` of their shells, on every
host that `autocode hosts` lists with `yes` under SHELL VALUES.

### 3. Connect Each Machine

Do this on every machine whose OpenCode should use Autocode, as the user who runs OpenCode there.

On `machine-a`, where the binary and the consumer token already are:

```sh
autocode plugin install --url http://127.0.0.1:4848 --server-id home \
  --consumer-token-file ~/.autocode/consumer.token
```

On `machine-b`, copy the binary and the consumer token from `machine-a` first. Copy the token as a file: do not
paste it into a terminal or a chat. In the commands below, write for `machine-a` the server machine as `machine-b`
reaches it: its Tailscale name, or its LAN address, such as `192.168.1.10`. If your user name on `machine-a`
differs, write `NAME@machine-a:`.

```sh
mkdir -p ~/.autocode && chmod 700 ~/.autocode
scp -p machine-a:.autocode/bin/autocode ~/autocode
scp -p machine-a:.autocode/consumer.token ~/.autocode/consumer.token
~/autocode plugin install --url http://machine-a:4848 --server-id home \
  --consumer-token-file ~/.autocode/consumer.token
```

- With another CPU, or on a Mac, change the first `scp` line. For `aarch64`:
  `scp -p machine-a:Autocode/dist/autocode-linux-arm64 ~/autocode`. For `x86_64`: the same with
  `autocode-linux-x64`. A Mac takes `autocode-darwin-arm64`, also when `machine-a` is ARM64. `Autocode` is the
  folder of step 1, here in your home folder on `machine-a`.
- `--server-id` makes this machine refuse a server that has another ID.
- Keep the copied token file: an upgrade runs the same command again.

On either machine, the command:

- checks the server and the token;
- copies the binary to `~/.autocode/bin/autocode`;
- puts the plugin into OpenCode's config folder, usually `~/.config/opencode/plugins/autocode/`;
- writes the machine's client config, `~/.autocode/client.json`: the server's address and the token.

It worked if it prints `plugin installed in ...` and `client config ... points at home`. On `machine-b` you can
delete `~/autocode` now. Add `~/.autocode/bin` to the `PATH` there too, as in step 2.

Then, on each machine:

1. Restart OpenCode's background service so that it loads the plugin, also when no OpenCode window is open:
   `opencode service restart`. This closes OpenCode's open terminal windows and interrupts running turns. The
   sessions stay, and Autocode resumes the agents among them.
2. Open OpenCode in any project folder: run `opencode` there.
3. Run `autocode hosts`. It worked if it lists that machine and folder with `yes` under ONLINE. A folder is listed
   only after OpenCode has opened it. If it is still missing, see [Troubleshooting](reference.md#troubleshooting).

On `machine-a` you are the owner at the command line: every command works. On `machine-b` only `autocode info`,
`hosts`, `agents`, `costs`, `history` and `settings` (to read) work. Every other command, `autocode wakes`, `inbox`
and `messages` included, is refused. To be the owner there too, copy the admin token and run `plugin install` again
with one more flag:

```sh
scp -p machine-a:.autocode/admin.token ~/.autocode/admin.token
autocode plugin install --url http://machine-a:4848 --server-id home \
  --consumer-token-file ~/.autocode/consumer.token --admin-token-file ~/.autocode/admin.token
```

### 4. Sign In to the Web UI

Open `http://machine-a:4848/` in a browser; on `machine-a` itself, `http://127.0.0.1:4848/`. Sign in with the admin
token: `cat ~/.autocode/admin.token` on `machine-a` prints it. Paste it only into this form. It worked if the Hosts
tab lists the folders that `autocode hosts` listed.

## First Agent

An agent that wakes itself every 30 minutes.

1. On a connected machine, open OpenCode in a project folder where a new file, `wake.log`, does no harm, and type:

   > Register with Autocode as `demo:lead`. Then set a wake named `tick` that tells you, every 30 minutes, to append
   > the current date and time to `wake.log`.

   `demo:lead` is the agent's ID: letters, digits, `-`, `_` and `.`, with `:` between its levels, here a project
   and a role. OpenCode now titles the session `@demo:lead`.
2. See it. In a terminal of your own on `machine-a`, not inside OpenCode:

   ```sh
   autocode agents
   autocode wakes demo:lead
   ```

   The first lists `demo:lead` with its status, `idle` or `working`. The second lists `tick` with the trigger
   `every 30m` and the time of its next run. The web UI shows the same on its Agents and Wakes tabs.
3. Try it at once. To fire a wake is to deliver it now:

   ```sh
   autocode fire demo:lead tick
   ```

   It answers `fired tick of demo:lead`. Once the session is idle, it gets a prompt like this within a minute, and
   the agent adds a line to `wake.log`. The line after `Wake "tick"` is the text that the agent gave its wake:

   ```
   [autocode] wake "tick" fired by the owner

   Wake "tick" (every 30m; next 2026-11-17 14:30 PST):
   Append the current date and time to wake.log.

   Server time 2026-11-17 14:02 PST. Context: 14,210 tokens, 14.2% of compact_at (100,000). Cost today: $0.04 (no daily cap). "autocode_me action=help" for more info.
   ```

   Check: `cat wake.log` in that folder shows one line. At the time that `autocode wakes demo:lead` gives under
   NEXT, a second line follows without you: the schedule works. If no line comes, look at the Inbox tab: the agent
   may be waiting for a permission.

**What must keep running:**

- The `autocode` service on `machine-a`, and the agent's machine with its network. While that machine cannot reach
  the server, the agent is `offline` and its wakes wait.
- OpenCode on that machine. You can close OpenCode's terminal window: the session lives on in OpenCode's
  background service, and Autocode keeps typing into it. Not so if you started OpenCode with `--standalone`.
- The project folder, loaded in OpenCode. OpenCode unloads a folder that nothing has used for an hour, and an agent
  in an unloaded folder is `offline`. A wake that prompts the agent every 30 minutes keeps the folder loaded. With
  rarer wakes it depends on the machine. On `machine-a`, Autocode loads the folder again by itself. On `machine-b`
  it cannot: the agent stays `offline`, and its wakes and messages wait, until you open OpenCode in that folder
  again or send one of its sessions a prompt. To avoid this on `machine-b`, give the agent one wake of 30 minutes
  or less.

**What it costs:** Autocode itself is free. Every wake is a turn that your model provider bills, and no cap is set
at first. To cap this agent at 5 dollars a day: `autocode settings set daily_usd 5 --agent demo:lead`. Past the cap
the agent is paused when its turn ends, and your Inbox gets an alert; it goes on the next day. `autocode costs`
shows what each agent spent, beside its cap.

**Stop it,** in a terminal of your own on `machine-a`:

| To | Run | What then |
|---|---|---|
| remove the wake | `autocode wake cancel demo:lead tick`, or tell the agent "cancel your wake `tick`" | `autocode wakes demo:lead` says `no wakes` |
| send the agent no new prompts | `autocode pause demo:lead` | A running turn goes on to its end. Wakes and messages wait until `autocode resume demo:lead` |
| unregister the agent, with its wakes | `autocode agents rm demo:lead` | `autocode agents` no longer lists it. Its session stays in OpenCode |
| stop all agents now | `autocode stop-all` | It pauses every agent and interrupts their running turns, and those of the helper sessions (Subagents) that work for them. `autocode resume-all` resumes the agents |
| stop Autocode itself | `systemctl --user stop autocode` | No agent gets a prompt until `systemctl --user start autocode`, or until `machine-a` starts again |
| remove Autocode | the uninstall steps in [`autocode.admin.agent.md`](autocode.admin.agent.md#uninstall) | |

## Using Autocode

Three ways in: talk to an agent in OpenCode, run `autocode`, or open the web UI.

**In OpenCode,** ask in plain words, and the agent uses its tools:

> Register with Autocode as `kaggle:lead`. Every 30 minutes on weekdays between 09:00 and 17:00, look in `incoming/`
> for new files and process them. Only wake up when there are new files.

> Start `./train.sh` in the background and have Autocode wake you when it finishes.

> Ask me through Autocode whether you may delete `old-logs/`, and follow my answer.

**On the command line,** who you are depends on where you run it. On `machine-a`, or on a machine connected with
`--admin-token-file`, you are the owner and every command works. On a machine connected without it, only the six
commands named in step 3 work. In a shell that an agent started, the command acts as that agent: `autocode me`,
`autocode fire` and `autocode send` work, and the owner's commands are refused.

| Command, as the owner | Does |
|---|---|
| `autocode agents`, `autocode hosts` | the agents and their status; the connected project folders |
| `autocode inbox`, `autocode answer ID TEXT...` | what waits for you; answer one item |
| `autocode send kaggle:lead "Stop after fold 3."` | send an agent a message |
| `autocode costs` | what each agent spent, today and in total, beside its daily cap, and what the money went to: cache writes, cache reads, input, output and Subagents |
| `autocode history` | what happened, newest first |

**In the web UI,** at `http://machine-a:4848/`, each tab is one view. **Hosts** and **Agents** show what is connected
and what each agent does, with its spend and context. **Inbox** holds what waits for you: messages, alerts, questions,
permission prompts and approvals. **Messages**, **Locks**, **Wakes** and **Jobs** list those and let you act on them.
**Costs** shows the spend per agent and day, by kind and by what started the turns, **History** every event,
**Settings** every setting, and **Help** is the manual. Click a column heading to sort. A filter field finds what you
type anywhere in an ID: `lead` finds `kaggle:lead`.

## Where to Go Next

| Read | For |
|---|---|
| [`reference.md`](reference.md) | every detail: triggers and checks, messages, locks, jobs, settings, tokens, backups, troubleshooting |
| the Help page in the web UI | how to use Autocode day by day, beside the data |
| `autocode --help` | every command and its flags, in groups |
| [`autocode.admin.agent.md`](autocode.admin.agent.md) | for you and for AI agents: short steps to install, upgrade, roll back, replace a leaked token and uninstall |
| [`autocode.consumer.agent.md`](autocode.consumer.agent.md) | the guide that agents get as their `autocode` skill |
| [`AGENT.md`](AGENT.md) | for AI agents: which of the two files above to read |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | building, the tests and the layout of the code |

## Development

Autocode is one TypeScript codebase on [Bun](https://bun.sh). To check a change, run `bun install` once, then
`bun run typecheck && bun run lint` and `bun test tests/unit tests/api`. [`DEVELOPMENT.md`](DEVELOPMENT.md) has the
build, the suites that run in Docker, the layout and the code style.

## License

Autocode is licensed under the Apache License, Version 2.0: see [`LICENSE`](LICENSE).
