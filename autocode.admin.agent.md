# Autocode: Guide for Whoever Installs and Administers It <!-- omit in toc -->

This guide is for the person who installs and looks after Autocode, or for an AI agent that does it for them. It has
the steps only. [`README.md`](README.md) explains the same install at more length, and [`reference.md`](reference.md)
has every detail. "The owner" is the person who runs Autocode.

- [What This Repository Is](#what-this-repository-is)
- [Rules](#rules)
- [Install](#install)
- [Check That It Works](#check-that-it-works)
- [Upgrade](#upgrade)
- [Roll Back](#roll-back)
- [Replace a Leaked Token](#replace-a-leaked-token)
- [Uninstall](#uninstall)
- [When Something Fails](#when-something-fails)

## What This Repository Is

Autocode is a long-term autonomy support framework for [OpenCode](https://opencode.ai) agents: it gives them what
they need to work on their own for days or weeks, and keeps them under their owner's control.

- **One binary**, `autocode`: the server, the command line, the OpenCode plugin and the web UI are all inside it.
- **The server** runs on one machine as a systemd user service. Everything it keeps is in `~/.autocode/`.
- **The plugin** runs in each machine's OpenCode and connects it to the server. It gives sessions the `autocode_*`
  tools and the `autocode` skill, whose text is [`autocode.consumer.agent.md`](autocode.consumer.agent.md).
- **The code:** `shared/`, `server/`, `plugin/`, `cli/`, `web/`, `tests/`, `ci/`. To change it, read
  [`DEVELOPMENT.md`](DEVELOPMENT.md).

## Rules

- Ask the owner before you install, upgrade, uninstall or restart anything that runs: agents depend on it.
- A token is a password. Never print one, and never put one on a command line, in a chat, a message, a log or a commit.
- Tokens move only as files. One copy is needed: `~/.autocode/consumer.token` from the server machine to each other
  machine, with `scp -p`, which keeps its mode 0600. Copy `admin.token` the same way only to a machine where the
  owner wants the owner's commands. No other copy of a token is needed.
- Give tokens to commands as files: `--consumer-token-file`, `--admin-token-file`. Do not use `--consumer-token` or
  `--admin-token`: the shell history and the process list would show the token.
- Do not delete `~/.autocode/`: it holds the data and the tokens.
- In a shell that OpenCode started for a session, the CLI acts as that session's agent (`me`, `fire`, `send`). Of
  the owner's commands only `autocode install`, `uninstall`, `plugin`, `serve` and `info` work there. The others,
  such as `hosts`, `agents` and `token rotate`, are refused: if you are an agent, ask the owner to run them in a
  terminal and to tell you what they print.
- One command below uses `sudo`. If it asks for a password, ask the owner to run it.

## Install

The examples use `machine-a` for the server machine and `machine-b` for a second one. Both may run agents.

You need OpenCode 2.3.0 or later on every machine (`opencode --version`), and Linux with systemd on the server
machine, ARM64 or x86-64. Run every command as the owner's normal user, not as root. Autocode speaks plain HTTP:
Tailscale encrypts it, and on a plain LAN the tokens travel unencrypted.

1. **Get the binary.** Releases carry no binaries. Build it on Linux with git, [Bun](https://bun.sh) and Docker:

   ```sh
   git clone https://github.com/myurasov/Autocode
   cd Autocode
   ci/dist.sh
   ```

   It worked if the last line names the build, like `build 1: v1.1.0-rc1-build1`. The binary is `dist/autocode`, for
   this machine's CPU. For another CPU, or for a Mac, run `AUTOCODE_TARGETS=all ci/dist.sh`: it also makes
   `dist/autocode-linux-x64`, `dist/autocode-linux-arm64` and `dist/autocode-darwin-arm64`.

2. **Install the server** on `machine-a`, in the `Autocode` folder:

   ```sh
   dist/autocode install --id home --listen localhost,tailscale:4848
   sudo loginctl enable-linger $USER
   ```

   - `--id` names the server; `home` is an example. `--listen` says where it answers: `localhost,tailscale:4848` is
     the default, and `0.0.0.0:4848` is every address of the machine, for a LAN without Tailscale.
   - `install` copies the binary to `~/.autocode/bin/autocode`, starts the `autocode` service and creates
     `~/.autocode/admin.token` and `~/.autocode/consumer.token`, mode 0600. It worked if it prints
     `server home ... answers at http://127.0.0.1:4848`.
   - The second line keeps the service running after the owner logs out, and starts it at boot. Run it as the
     owner's user, as written: in a root shell `$USER` is root.

   **Typing `autocode`.** This guide writes `autocode` for `~/.autocode/bin/autocode`. Nothing changes the `PATH` of
   a terminal: type the full path, or add the folder once and open a new terminal, with
   `echo 'export PATH="$HOME/.autocode/bin:$PATH"' >> ~/.bashrc`. Scripts that agents start need no setup: the
   plugin puts that folder first in the `PATH` of their shells, on every host that `autocode hosts` lists with `yes`
   under SHELL VALUES.

3. **Connect each machine's OpenCode.** On `machine-a`:

   ```sh
   autocode plugin install --url http://127.0.0.1:4848 --server-id home \
     --consumer-token-file ~/.autocode/consumer.token
   ```

   On `machine-b`, where `machine-a` stands for the server machine's Tailscale name or LAN address:

   ```sh
   mkdir -p ~/.autocode && chmod 700 ~/.autocode
   scp -p machine-a:.autocode/bin/autocode ~/autocode
   scp -p machine-a:.autocode/consumer.token ~/.autocode/consumer.token
   ~/autocode plugin install --url http://machine-a:4848 --server-id home \
     --consumer-token-file ~/.autocode/consumer.token
   ```

   - With another CPU on `machine-b`, or on a Mac, copy the matching file from step 1 as `~/autocode` instead. A
     Mac takes `dist/autocode-darwin-arm64`, also when `machine-a` is ARM64.
   - `plugin install` copies the binary to `~/.autocode/bin/autocode`. Delete `~/autocode` afterwards.
   - It worked if it prints `plugin installed in ...` and `client config ... points at home`.
   - Keep the copied token file: an upgrade runs the same command again.
   - On `machine-a` the owner's commands work as they are: they use the server's own `admin.token`. To run them on
     `machine-b` too, copy `admin.token` there the same way and add `--admin-token-file ~/.autocode/admin.token`.
     Without it, only `autocode info`, `hosts`, `agents`, `costs`, `history` and `settings` (to read) work there.
     Every other command, `autocode wakes`, `inbox` and `messages` included, is refused.

4. **Restart OpenCode** on each machine where it runs, so that it loads the plugin: `opencode service restart`. It
   closes OpenCode's open terminal windows, so ask the owner first.

5. **Tell the owner** how to sign in: the web UI is at `http://machine-a:4848/`, and the admin token is the one line
   in `~/.autocode/admin.token` on `machine-a`. Name the file; do not show its content.

## Check That It Works

| Run | It worked if |
|---|---|
| `autocode info` | it prints `server home, autocode v1.1.0-rc1-build1, for OpenCode v2.3.0 or later, at ...`, with your build's number |
| `systemctl --user status autocode` on `machine-a` | it says `active (running)` |
| `autocode hosts`, after OpenCode has opened a project folder | that machine and folder are listed, with `yes` under ONLINE and the plugin's version under PLUGIN |
| in an OpenCode session: "what is your Autocode status?" | the agent calls `autocode_me` and answers; it is not registered at first |

To test a whole round, ask a session to "register with Autocode as `test:check`". `autocode agents` then lists
`test:check`, and `autocode agents rm test:check` removes it.

Logs: the server's with `journalctl --user -u autocode`, the plugin's in `~/.autocode/logs/plugin.log` on each machine.

## Upgrade

1. Build the new binary: `git pull`, then `ci/dist.sh`, in the `Autocode` folder.
2. On `machine-a`, keep the old binary, back up the database and save the two token files beside it. The backup
   may run while the server runs:

   ```sh
   cp -p ~/.autocode/bin/autocode ~/.autocode/bin/autocode-old
   sqlite3 "$HOME/.autocode/autocode.db" ".backup '$HOME/.autocode/autocode-backup.db'"
   cp -p ~/.autocode/admin.token ~/.autocode/admin.token.backup
   cp -p ~/.autocode/consumer.token ~/.autocode/consumer.token.backup
   ```

   Without the `sqlite3` command, stop the service first (`systemctl --user stop autocode`), then copy
   `~/.autocode/autocode.db` to `~/.autocode/autocode-backup.db`.
3. On `machine-a`, run the new binary's `install` with the same flags as before. `systemctl --user cat autocode`
   shows them in its `ExecStart` line.

   ```sh
   dist/autocode install --id home --listen localhost,tailscale:4848
   ```

   It replaces `~/.autocode/bin/autocode` and restarts the service. The data and the tokens stay, and the database
   is brought up to date at the start. It worked if `autocode info` prints the new version.
4. On `machine-a`, run the same `autocode plugin install` command as in Install, step 3.
5. On `machine-b`, keep the old binary the same way. Then copy the new one as `~/autocode` and run the same
   `~/autocode plugin install` command as in Install, step 3: it replaces `~/.autocode/bin/autocode`.
6. On every machine: `opencode service restart`. Ask the owner first: turns that run are cut, and Autocode resumes
   them. It worked if `autocode hosts` shows the new version under PLUGIN for each host that is online.

## Roll Back

An older binary does not open a database that a newer one has changed. It stops with "the database ... is at schema
N, newer than this autocode knows". Going back then needs the backup from Upgrade, step 2, and loses what happened
since.

1. On `machine-a`, install the old binary again, with the same flags:

   ```sh
   ~/.autocode/bin/autocode-old install --id home --listen localhost,tailscale:4848
   ```

   It worked if `autocode info` prints the old version. Then go to step 3.
2. If it fails with "the service did not answer", and `journalctl --user -u autocode -n 20` shows the schema message
   above, put the backup back:

   ```sh
   systemctl --user stop autocode
   cp -p "$HOME/.autocode/autocode-backup.db" "$HOME/.autocode/autocode.db"
   rm -f "$HOME/.autocode/autocode.db-wal" "$HOME/.autocode/autocode.db-shm"
   systemctl --user start autocode
   ```

   If a token was replaced after that backup, also put back the two token files saved in Upgrade, step 2, before
   the start: copy `admin.token.backup` over `admin.token`, and `consumer.token.backup` over `consumer.token`.
   Without them, follow "The admin token is lost" below, then replace the consumer token.
3. On every machine, install the plugin from the old binary: the command of Install, step 3, started as
   `~/.autocode/bin/autocode-old plugin install` on `machine-b`. Then `opencode service restart`.

## Replace a Leaked Token

Run these on `machine-a`. The old token stops working at once. The command prints the path of the new token's file,
never the token. A leaked admin token means replacing both: with the admin token, one can make a new consumer token.

**The consumer token**

1. On `machine-a`: `autocode token rotate --consumer`. Every session token ends with it. The plugins get new ones
   by themselves when they reconnect, and shells that a session opens afterwards carry the new token.
2. On every other machine, copy the new file and install the plugin again with it:

   ```sh
   scp -p machine-a:.autocode/consumer.token ~/.autocode/consumer.token
   autocode plugin install --url http://machine-a:4848 --server-id home \
     --consumer-token-file ~/.autocode/consumer.token
   ```

   OpenCode needs no restart: a running plugin reads the new token and connects again within about a minute. Until a
   machine has the new token, its hosts are offline. On `machine-a` the command itself updates the client config.
3. It worked if `autocode hosts` lists the hosts with `yes` under ONLINE again.
4. A command that an agent started before the rotation keeps the old token: its closing `autocode fire me ...` is
   refused. Ask each agent to look at the commands it left running, or fire the wake yourself:
   `autocode fire AGENT WAKE`.

**The admin token**

1. On `machine-a`: `autocode token rotate --admin`, then `autocode token rotate --consumer` as above.
2. The owner signs in to the web UI again, with the new token from `~/.autocode/admin.token`.
3. On every other machine whose `plugin install` had `--admin-token-file`: copy the new `admin.token` there with
   `scp -p`, and run that command again.

**An agent's session token:** `autocode token rotate AGENT`, where `AGENT` is the agent's ID, such as `kaggle:lead`.
The Agents tab has the same as **New Token**. Shells that the session opens afterwards carry the new token. A
command that the session started earlier keeps the old one, and its `autocode fire me ...` is refused.

**The admin token is lost.** No command reads a token back: the server keeps only a hash. If
`~/.autocode/admin.token` is gone but another machine was connected with `--admin-token-file`, run
`autocode token rotate --admin` there. If no copy is left, make the server create a new one. On `machine-a`, with
the `sqlite3` command:

```sh
systemctl --user stop autocode
sqlite3 "$HOME/.autocode/autocode.db" "DELETE FROM tokens WHERE kind = 'admin'"
systemctl --user start autocode
```

The server makes a new `~/.autocode/admin.token` at that start.

## Uninstall

1. On each machine: `autocode plugin uninstall`, then `opencode service restart`. The client config
   `~/.autocode/client.json` and the binary stay.
2. On `machine-a`: `autocode uninstall`. It stops and removes the service. The binary and the data stay.
3. Only when the owner asks for it, remove the rest. This deletes all data and the tokens, on each machine:
   `rm -rf ~/.autocode`. Also remove the `PATH` line from `~/.bashrc` if you added it.

## When Something Fails

| You see | Check |
|---|---|
| `autocode: command not found` | Type `~/.autocode/bin/autocode`, or add the folder to the `PATH` as in Install, step 2. |
| `autocode hosts` says `no hosts yet`, or lacks a machine | A folder is listed only after OpenCode has opened it, after the restart of Install, step 4. Then read `~/.autocode/logs/plugin.log` on that machine. |
| `refused (forbidden): this route is not open to a consumer token` | This machine has no admin token: run the command on `machine-a`, or connect this machine with `--admin-token-file`. |
| "in an agent's shell the CLI has only me, fire and send" | The shell was started by OpenCode for a session: the owner runs that command in a terminal. |
| "the server at ... is X, not Y" | The server's ID is not the expected one: compare `--id` on the server with `--server-id` on that machine. |
| `autocode install` waits, then fails with "the service did not answer" | `journalctl --user -u autocode -n 20`: a port in use, an address in `--listen` that this machine does not have, or a `--listen` without `localhost`: `install` checks the service at 127.0.0.1. |
| after a reboot or a power cut the agents stay `offline` | `autocode history --kind host.load_failed`. "Failed to start server": Autocode did not find OpenCode's binary. Run `opencode service restart` once in a terminal (ask the owner first); the plugin then records the binary and Autocode starts it by itself from then on. See `reference.md`, A Power Cut or a Reboot. |
| a host is marked "too old" | Its OpenCode is older than 2.3.0, so nothing on that machine is served. Update OpenCode there and start it again. |
| hosts go offline after a consumer token was replaced | That machine still has the old token: Replace a Leaked Token, step 2. |

More symptoms: `reference.md`, Troubleshooting. What you cannot fix: tell the owner what you ran and what it said.
