# Autocode: Instructions for an Agent That Installs and Runs It <!-- omit in toc -->

You are working in the Autocode repository, or you were asked to install Autocode for its owner. This file says what
this repository is and how to install, check and update Autocode. For every detail, see [`reference.md`](reference.md).

- [What This Repository Is](#what-this-repository-is)
- [Rules](#rules)
- [Install](#install)
- [Check That It Works](#check-that-it-works)
- [Update](#update)
- [Uninstall](#uninstall)
- [When Something Fails](#when-something-fails)

## What This Repository Is

Autocode lets AI coding agents keep working on their own for days or weeks, work with each other, and stay under
their owner's control. It links [OpenCode](https://opencode.ai) sessions, on one machine or several, to one Autocode
server.

- **One binary**, `autocode`: the server (`autocode serve`, or a systemd user service), the CLI, the OpenCode plugin
  (it installs itself) and the web UI are all inside it.
- **The server** runs on one machine and keeps everything (agents, wakes, messages, the owner's inbox, settings,
  history) in `~/.autocode/`.
- **The plugin** runs in each machine's OpenCode and connects it to the server. It gives sessions the `autocode_*`
  tools and the `autocode` skill, whose text is [`autocode.consumer.agent.md`](autocode.consumer.agent.md).
- **The code:** `packages/` (shared, server, plugin, cli, web), `tests/`, `ci/`. Development: see `reference.md`,
  Development.

## Rules

- Ask the owner before you install, uninstall, restart or change a server that runs: other agents depend on it.
- Never print, copy or send the tokens (`~/.autocode/admin.token`, `consumer.token`). Pass them as files
  (`--consumer-token-file`, `--admin-token-file`).
- Do not delete `~/.autocode/`: it holds the data and the tokens. Back up `autocode.db` before an update.
- In a session that is an Autocode agent, use the `autocode_*` tools, not the CLI. The owner's CLI commands are
  refused in an agent's shell.

## Install

You need OpenCode 2.2.0 or later on every machine that should use Autocode. The server runs as a systemd user service
on Linux (ARM64 or x86-64); the CLI also runs on macOS ARM64. Machines reach the server over the LAN or Tailscale.

1. **Get the binary.** Build it from this repository (needs [Bun](https://bun.sh) and Docker for the web UI):

   ```sh
   bun install
   ci/dist.sh                       # dist/autocode for this machine
   AUTOCODE_TARGETS=all ci/dist.sh  # also dist/autocode-linux-arm64, -linux-x64, -darwin-arm64
   ```

2. **Install the server** on the server machine, as the user who should own it:

   ```sh
   ./autocode install --listen localhost,tailscale:4848 --id <server-id>
   ```

   It copies itself to `~/.autocode/bin/autocode`, installs and starts the `autocode` service, and saves the admin and
   consumer tokens in `~/.autocode/` (mode 0600). For a start at boot, the owner runs `loginctl enable-linger $USER`
   once (it needs root).

3. **Connect each machine's OpenCode** (the server machine too, if agents run there). Copy the consumer token to that
   machine as a file (mode 0600), then:

   ```sh
   autocode plugin install --url http://<server>:4848 \
     --consumer-token-file <file> --server-id <server-id> \
     [--admin-token-file <file>]   # only where the owner runs owner commands
   ```

   Then restart OpenCode servers that were already running: `opencode service restart` for the background service
   (it closes open TUIs: ask the owner first).

4. **Tell the owner** how to sign in: the web UI at `http://<server>:4848/`, with the admin token from
   `~/.autocode/admin.token` on the server machine.

## Check That It Works

- `autocode info`: the server's ID and version (`v1.0.0-rc2-build<n>`).
- `autocode hosts`: one line per machine and OpenCode folder, `online yes`. A folder shows up once OpenCode uses it
  (a TUI opens it, or a prompt runs there).
- In an OpenCode session: `autocode_me action=status` answers (unregistered at first). Registering:
  `autocode_me action=register id=test:check description="install check"`, then `autocode agents` lists it;
  `autocode agents rm test:check` removes it.
- `systemctl --user status autocode`; logs: `journalctl --user -u autocode`; the plugin's log:
  `~/.autocode/logs/plugin.log`.

## Update

1. Build the new binary (Install, step 1).
2. Back up the data: `sqlite3 ~/.autocode/autocode.db ".backup ~/.autocode/autocode-backup.db"`.
3. Run the new binary's `install` again on the server machine (same flags). It replaces `~/.autocode/bin/autocode`
   and restarts the service; the data and tokens stay, and the database is migrated at the start.
4. On each machine, run `autocode plugin install` again with the new binary (same flags), then restart its running
   OpenCode servers so they load the new plugin (ask the owner first: a restart closes open TUIs). Check:
   `autocode hosts` shows the new plugin version for each online folder.

## Uninstall

- Server: `~/.autocode/bin/autocode uninstall` stops and removes the service; the binary and the data stay.
- Plugin: `autocode plugin uninstall` on each machine; the client config `~/.autocode/client.json` stays.
- Removing `~/.autocode/` deletes all data and the tokens: only when the owner asks for it.

## When Something Fails

See `reference.md`, Troubleshooting. The common cases:

- `autocode hosts` shows nothing for a machine: the plugin loads with a folder only when OpenCode uses it; read
  `~/.autocode/logs/plugin.log`.
- "the server at ... is X, not Y": the expected server ID differs; check `--server-id` and the client config.
- `autocode install` waits and fails: `journalctl --user -u autocode` (a port in use, a bad `--listen`).
- Anything you cannot fix: tell the owner what you ran and what it said.
