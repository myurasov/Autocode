# Autocode Runbook <!-- omit in toc -->

_How to install, run, check and repair Autocode. Matches tier 0a (Foundation): the server, tokens, the plugin's
channel, registration, settings, history, the CLI and the web UI's Agents and Settings pages. Later tiers add their
own sections._

- [Where Things Live](#where-things-live)
- [Install the Server (Linux)](#install-the-server-linux)
- [Run the Server by Hand](#run-the-server-by-hand)
- [Connect a Machine's OpenCode](#connect-a-machines-opencode)
- [Tokens](#tokens)
- [Everyday Commands](#everyday-commands)
- [Settings](#settings)
- [Web UI](#web-ui)
- [Uninstall](#uninstall)
- [Backups and Data](#backups-and-data)
- [Troubleshooting](#troubleshooting)

## Where Things Live

Everything of an install is in one folder, the Autocode home: `~/.autocode/`, or the folder `AUTOCODE_HOME` names.

| In the home | What |
|---|---|
| `autocode.db`, `admin.token`, `consumer.token`, `config.json` | the server's data, the owner's tokens (0600), its optional config file |
| `bin/autocode` | the installed binary (`autocode install`) |
| `client.json` | the machine's client config (`autocode plugin install`): server URL, tokens, expected server ID |
| `logs/plugin.log` | the plugin's log; `logs/serve.log` when the server runs in tmux (`ci/live-server.sh`) |

Only two files live elsewhere, where systemd and OpenCode look for them: the unit
`~/.config/systemd/user/autocode.service` and the plugin in OpenCode's plugin folder. Folders made for a home are
0700. Development-time copies and runs live in `~/.autocode-dev/`, never in `~/.autocode/` (see `docs/tests.md`).

## Install the Server (Linux)

1. Copy the binary for the machine (`dist/autocode-linux-arm64` or `dist/autocode-linux-x64` from a build, see
   `docs/tests.md`) to the server machine, for example as `~/autocode`.
2. Run `~/autocode install` as the user that should own the service. It copies itself to `~/.autocode/bin/autocode`,
   writes `~/.config/systemd/user/autocode.service`, enables and starts it, and waits until it answers. With
   `AUTOCODE_HOME` set, the binary goes to that home and the service keeps its data there too.
   - `--listen` sets the addresses, in the `listen` setting's format: names sharing one port
     (`localhost,tailscale:4848`) or addresses each with a port (`127.0.0.1:4848,0.0.0.0:4849`); without it the server
     uses its `listen` setting, by default `localhost,tailscale:4848` (127.0.0.1 and the machine's Tailscale address,
     port 4848). A server that starts before Tailscale has its address (at boot) listens on it as soon as it appears.
   - `--id ID` sets the server ID; without it the ID comes from `~/.autocode/config.json` (`{"id": "..."}`), and
     otherwise from the host name.
3. The service starts at boot only when user lingering is on (`loginctl enable-linger $USER`, needs root once);
   otherwise at login. `install` says so when lingering is off.
4. Check: `~/.autocode/bin/autocode info` and `systemctl --user status autocode`. Logs: `journalctl --user -u autocode`.

## Run the Server by Hand

`autocode serve [--id ID] [--listen ADDRESSES] [--data DIR]` runs it in the foreground. Data goes to `--data`, else
`$AUTOCODE_HOME`, else `~/.autocode`. Stop it with Ctrl-C (or SIGTERM). Until the service is installed, the live
checks run an install this way in tmux: `ci/live-server.sh start|stop|restart|status` (a development tool: a host
keeps its copy in `~/.autocode-dev/live-server.sh`, not in the install), with the home's `bin/autocode`, its data
and `logs/serve.log`; `LIVE_LISTEN` and `LIVE_ID` set the addresses and the ID.
`--web-dir DIR` serves a web UI build from a folder instead of the one inside the binary (development only).

## Connect a Machine's OpenCode

On each machine whose OpenCode should use Autocode (OpenCode 2.2.0 or later):

```sh
autocode plugin install --url http://<server address>:4848 --consumer-token-file <file with the consumer token> \
  [--server-id <expected server ID>] [--admin-token-file <file>]
```

- It checks the server (and its ID, when given), puts the plugin into OpenCode's global plugin folder
  (`$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`, in `plugins/autocode/`),
  and writes the client config `~/.autocode/client.json` (mode 0600; `AUTOCODE_CONFIG` names another file) with the
  URL and the token(s).
- `--admin-token-file` also lets the owner run the owner commands of the CLI from that machine.
- OpenCode loads the plugin with each workspace folder, when the folder is first used (a TUI opening it, or a
  prompt). Restart OpenCode servers that were already running (`opencode service restart` for the background
  service; it closes open TUIs).
- Check: `autocode hosts` lists one host per machine and folder, `online yes`.

## Tokens

| Token | Created | Kept in | Used by |
|---|---|---|---|
| admin | the server's first start | `~/.autocode/admin.token` (0600) on the server | the owner's CLI and web UI: full control |
| consumer | the server's first start | `~/.autocode/consumer.token` (0600) | the plugin's channel, and the owner's CLI for reading on a machine whose client config has no admin token; not the web UI (it can act for any session through the plugin's routes: a password, not a link to share) |
| session | for each top-level OpenCode session, by the plugin | memory of the plugin; the session's shell environment in OpenCode | that session's tool calls and scripts |

- The first start prints the admin and consumer tokens once when it runs on a terminal (a service's log gets only
  where they are saved); the files keep them. The database keeps only hashes.
- For automation, `AUTOCODE_ADMIN_TOKEN` and `AUTOCODE_CONSUMER_TOKEN` (an `aca_`/`acc_` prefix and at least 32
  more characters) set the tokens at the first start instead of random ones.
- `autocode token rotate <agent>` replaces a leaked session token: the old one stops working at once, and the
  plugin is told over its channel to get a new one and puts it into the session's shell environment (shells
  already running keep the old, dead token).
- Lost the admin token on another machine: read `~/.autocode/admin.token` on the server machine.

## Everyday Commands

The CLI reads its server and token from flags (`--url`, `--token`), then `AUTOCODE_URL`/`AUTOCODE_TOKEN`, then the
client config, then `~/.autocode/admin.token` with `http://127.0.0.1:4848` (on the server machine itself). In an
agent's shell (one OpenCode started) it uses only the first two: never the owner's or the consumer token. Your own
`!` commands in an agent's session count as that agent's shell once the session has run a shell (they share its
shell environment). With an
expected server ID (`--server-id`, `AUTOCODE_SERVER_ID`, or the client config's `server_id`) it checks the server's
ID before it sends a token. Every command takes `--json`.

| Command | Does |
|---|---|
| `autocode info` | the server's ID and version (`v0.1.0-build<n>`: the release and the build number) |
| `autocode agents [PATTERN]` | agents with status, machine and last activity (`kaggle:*`, `a,b`) |
| `autocode agents rm AGENT` | unregister an agent (its history stays) |
| `autocode agents register AGENT --session SES [--force]` | bind an ID to a session; `--force` moves it away from a live session |
| `autocode hosts` | plugin instances: machine, folder, online, OpenCode process, whether its shells get Autocode values |
| `autocode token rotate AGENT` | replace an agent's session token |
| `autocode settings ...` | see [Settings](#settings) |
| `autocode history [--agent ID] [--kind KIND] [--since TIME] [--limit N]` | the history, newest first |

Exit codes: 0 done, 1 refused or failed, 2 wrong usage, 3 the server cannot be reached.

## Settings

- `autocode settings` shows every setting with its value and where it comes from, the pattern rules and the
  agents' own values. `autocode settings --agent ID` shows one agent's resolved values and their sources.
- `autocode settings set KEY VALUE` sets a server-wide value; `--match PATTERN` sets it in the rule for that
  pattern (a new rule goes last; the first matching rule wins); `--agent ID` sets the agent's own value, which wins
  over everything. `autocode settings unset KEY [...]` clears it.
- Server-wide only: `history_days`, `keep_failed`, `restart_opencode`, `timezone`, `listen` (`listen` takes effect
  at the next start).
- Tier 0a uses `history_days` (history trimming); the other settings are stored and resolved now and used by the
  tiers that add their features.

## Web UI

Open `http://<server address>:4848/` and sign in with the admin token; the consumer token and an agent's session
token are refused. The token is kept for that browser tab, or on that browser with **Stay signed in**, until **Sign
Out**; a token the server stops accepting sends you back to sign-in. Other sites cannot frame the UI. Tier 0a pages:

- **Hosts:** each OpenCode server folder the plugin connects from, by machine (folder, status, the OpenCode process
  it runs in, OpenCode and plugin versions, last seen), refreshed every 10 s;
  it says how many seconds ago it last loaded. The process is the background service (`opencode serve --service`)
  or `opencode serve` (also the private server a TUI or `opencode run` starts for itself with `--standalone` or with
  the service turned off), with its process ID. A TUI attaches to the background service
  by default, so its folders stay online after the TUI exits, until OpenCode unloads a folder after an hour unused.
  **no shell values** under the process: that server's shells get no Autocode values, because the plugin cannot
  reach its local API (see Troubleshooting; `autocode hosts` shows a SHELL VALUES column).
- **Agents:** the agents by machine (status, folder, session, times), refreshed every 10 s, with a pattern filter
  that applies a second after the last key (Enter or **Refresh** at once; **Show All** clears it); edit a
  description, **New Token** (the same as `autocode token rotate`), **Unregister**. Like Hosts, it says how many
  seconds ago it last loaded.
- **Settings:** the server-wide values (each shown in its edit box: change it and **Save**, or **Reset** to the
  built-in default), the pattern rules, the agents' own values, and **Resolved for an Agent** (an agent's values
  with where each comes from).

## Uninstall

- Server: `~/.autocode/bin/autocode uninstall` stops and removes the service; the binary (`~/.autocode/bin/`) and
  the data in `~/.autocode/` stay (delete the folder by hand to remove everything and start over, which makes new
  tokens).
- Plugin: `autocode plugin uninstall [--opencode-config-dir DIR]` removes the plugin folder; the client config
  `~/.autocode/client.json` stays (delete it by hand).

## Backups and Data

- Everything lives in `~/.autocode/` ([Where Things Live](#where-things-live)); the data to back up is
  `autocode.db` (SQLite in WAL mode), `admin.token`, `consumer.token` and the optional `config.json`.
- Back up with the service stopped (`systemctl --user stop autocode`), or with `sqlite3 autocode.db ".backup
  copy.db"` while it runs.
- History older than `history_days` (30) is deleted automatically.

## Troubleshooting

| Symptom | Check |
|---|---|
| `autocode hosts` shows nothing for a machine | The plugin loads with a folder only when that folder is used: open it in a TUI or send a prompt. Read the plugin's log, `~/.autocode/logs/plugin.log`. |
| Plugin log: "no client config" | Run `autocode plugin install` on that machine. |
| Plugin log: "the server at ... is X, not Y" | The client config's `server_id` does not match the server; fix the config or the server ID. |
| A host is `online no` | Network or Tailscale between that machine and the server; the plugin retries with growing waits (up to 30 s). |
| Plugin log: "superseded by a newer instance" | Two OpenCode processes use the same folder and data folder; the newest one holds the channel, the older one waits and takes over when the newer one is gone. Tools and shell variables keep working in both. |
| An agent shows `offline` | Its host is offline (above), or its session was deleted (the ID can move to another session). |
| Registering says `id_taken` | The ID belongs to another session that still exists; unregister there, delete that session, or force the move: `autocode agents register ID --session SESSION --force`. |
| A tool says `session_gone` | The session was deleted in OpenCode; a deleted session never gets a token again. |
| A shell has no `AUTOCODE_TOKEN` | The plugin sets a session's shell values through its OpenCode server's local API before the session's first shell. The Hosts page marks the host **no shell values** (`autocode hosts`: SHELL VALUES `no`) when it cannot reach that API: a standalone server (`opencode run --standalone`, or a TUI with the service turned off), or `opencode serve` without `--port` or without `OPENCODE_SERVER_PASSWORD`; use the background service or start `opencode serve` with both. Otherwise the server was not reachable at that session's first shell; the next shell call sets them once the channel is back. The CLI in that shell refuses to run (it never falls back to the owner's tokens): open a new shell, or pass `--token`. |
| The CLI says "the server at ... is X, not Y" | The URL answers with another server ID than expected (`--server-id`, `AUTOCODE_SERVER_ID` or the client config's `server_id`); no token was sent. |
| `autocode install` waits and fails | `journalctl --user -u autocode`; a port already in use or a bad `--listen`. |
