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

A session's token is kept in OpenCode's plugin storage, so a plugin reload or a deploy uses it again (History shows a
`session.token` row only when one is new). A session token unused for 30 days is revoked; a running job keeps the one
it started with as long as it uses it. `autocode token rotate AGENT` and unregistering revoke all of a session's tokens.

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
| `autocode agents [PATTERN]` | agents with status, machine, spend today, context (the share of the compaction threshold) and last activity (`kaggle:*`, `a,b`) |
| `autocode costs [AGENT] [--match PATTERN]` | every agent's spend today and in total (unregistered ones too, and the totals), daily cap and what is left, context and its compaction threshold; `AGENT`: its spend per day (kept `history_days`, at least 31 days) |
| `autocode agents rm AGENT` | unregister an agent (its history stays) |
| `autocode agents register AGENT --session SES [--force]` | bind an ID to a session; `--force` moves it away from a live session |
| `autocode hosts` | plugin instances: machine, folder, online, OpenCode process, whether its shells get Autocode values |
| `autocode token rotate AGENT` | replace an agent's session token |
| `autocode settings ...` | see [Settings](#settings) |
| `autocode history [--agent ID] [--kind KIND] [--since TIME] [--limit N]` | the history, newest first |
| `autocode inbox [--all]` | the owner's inbox: messages to `owner`, alerts (three failed checks in a row; a failed turn not retried; retries run out), and agents' questions, permission prompts and approvals (tier 0d; TO says whether one was also sent to an agent) |
| `autocode answer ITEM TEXT...` | answer a message (the reply goes to the agent as a message from the owner), a question (an option or words; one line per question), a permission (`once`, `always`, or `reject: why`) or an approval (`approve` or `reject`, then an option and a note); the first answer counts |
| `autocode inbox close ITEM` | close an inbox item (an alert, or a message you will not answer) |
| `autocode pause AGENT` / `resume AGENT` | stop or restart an agent's injections (wakes and messages keep queuing) |
| `autocode retry AGENT` | retry an agent in the error state now (also after an error that is not retried, or after the retries ran out) |
| `autocode job set NAME --host H --model M --prompt P --trigger T` | define or replace a job (tier 0f): its host (`autocode hosts` lists them), the model, the prompt, `every`/`at`/`cron`/`fire-only`; `--to` (default owner), `--timeout` (1h), `--run-usd`, `--keep-session` |
| `autocode job list` / `job run NAME [--text T]` / `job runs [NAME]` / `job delete NAME` | the jobs; start a run now (refused while one runs); the runs with state, cost and result; delete a job |
| `autocode locks [PATTERN]` | every lock: capacity, holders with their expiry, the queue (tier 0c) |
| `autocode locks release NAME AGENT` | free an agent's hold on a lock (or take it out of the queue); the agent gets a notice, the next in the queue the lock |
| `autocode stop-all` / `resume-all` | pause every agent and interrupt every running turn; resume what stop-all paused (your own pauses stay) |
| `autocode wakes [AGENT]` | every wake (agent, name, trigger, next run, check, text), or one agent's |
| `autocode wake set AGENT NAME --trigger T --text TEXT [--check CMD]` | set or replace an agent's wake |
| `autocode wake cancel AGENT NAME` | cancel a wake |
| `autocode fire AGENT WAKE [--text TEXT]` | deliver a wake now (it skips its check); the prompt says the owner fired it |
| `autocode send TO TEXT...` | send a text message as the owner to an ID, a pattern or a list |
| `autocode messages` | every message, newest first, with its state (queued; delivered: in a prompt, whole, or in your inbox; dropped: its agent unregistered first); your views (here, `messages read`, the web UI) never change a state |

In an agent's shell the same binary acts as that agent, with three commands only: `autocode me`, `autocode fire me
WAKE [--text TEXT]` and `autocode send TO TEXT...` (see `howto.md`); the owner's commands are refused there.

Exit codes: 0 done, 1 refused or failed, 2 wrong usage, 3 the server cannot be reached.

## Settings

- `autocode settings` shows every setting with its value and where it comes from, the pattern rules and the
  agents' own values. `autocode settings --agent ID` shows one agent's resolved values and their sources.
- `autocode settings set KEY VALUE` sets a server-wide value; `--match PATTERN` sets it in the rule for that
  pattern (a new rule goes last; the first matching rule wins); `--agent ID` sets the agent's own value, which wins
  over everything. `autocode settings unset KEY [...]` clears it.
- Server-wide only: `history_days`, `timezone`, `listen` (`listen` takes effect
  at the next start).
- In use: `history_days` (history trimming, with message bodies, settled injections and closed inbox items),
  `min_interval`, `check_timeout`, `check_output`, `max_tool_wait` (an approval's wait; a single wait is cut at 240 s
  and waited again), `timezone` (the default zone of `cron` and `at` wakes; a cron wake keeps the zone it was set
  with), `retry_interval` (1m: the wait between a failed turn and its retry), `retry_attempts` (0, no limit: the
  most retries in a row before Autocode stops and tells you), and (tier 0d) `question_mode` (`ask`, `auto`,
  `agent:<id>`), `auto_answer_text`, `permission_mode` and `approval_mode` (`ask`, `approve`, `agent:<id>`);
  `job:<name>` is accepted and goes to you until jobs come (tier 0f); (tier 0e) `daily_usd` and `cap_warn`, `compact_at`, `expire_after`. For example, to send every question of
  `team:worker-*` to `team:lead`: `autocode settings set question_mode agent:team:lead --match 'team:worker-*'`.
  The other settings are stored and resolved now and used by the tiers that add their features.

## Web UI

Open `http://<server address>:4848/` and sign in with the admin token; the consumer token and an agent's session
token are refused. The token is kept for that browser tab, or on that browser with **Stay signed in**, until **Sign
Out**; a token the server stops accepting sends you back to sign-in. Other sites cannot frame the UI. Pages:

- **Hosts:** each OpenCode server folder the plugin connects from, by machine (folder, status, the OpenCode process
  it runs in, OpenCode and plugin versions, last seen), refreshed every 10 s;
  it says how many seconds ago it last loaded. The process is the background service (`opencode serve --service`)
  or `opencode serve` (also the private server a TUI or `opencode run` starts for itself with `--standalone` or with
  the service turned off), with its process ID. A TUI attaches to the background service
  by default, so its folders stay online after the TUI exits, until OpenCode unloads a folder after an hour unused.
  **no shell values** under the process: that server's shells get no Autocode values, because the plugin cannot
  reach its local API (see Troubleshooting; `autocode hosts` shows a SHELL VALUES column).
- **Agents:** the agents by machine (status: idle, working, waiting, error, paused or offline; model, spend today and
  in total, context as the share of its compaction threshold (both link to Costs); host, folder, session, times),
  refreshed every 10 s, with a pattern filter that applies a second after the last key (Enter or **Refresh** at once;
  **Show All** clears it); edit a description, **Pause** or **Resume** an agent's injections, **New Token** (the same
  as `autocode token rotate`), **Unregister**; **Stop All** (pause every agent and interrupt its session, after you
  confirm) and **Resume All** (what Stop All paused). Like Hosts, it says how many seconds ago it last loaded. An
  agent in the **error** state (its last turn failed) shows the error and its retries under its status (`retry 3 in
  40s`, `retrying now`, `not retried`, `retries ran out`; the times in its tooltip), and **Retry** retries it now.
- **Links:** an agent's ID anywhere else (Inbox, Messages, Wakes, Settings) opens the Agents page with that agent's
  row highlighted; a host's ID (on Agents) opens the Hosts page with that host's row highlighted.
- **Inbox:** messages to `owner` and alerts (a wake whose check failed three times in a row); **Answer** a message
  (the reply goes to the agent as a message from the owner) or **Close** an item; **Show Closed** shows the answered
  and closed ones.
- **Messages:** every message, newest first, with its ID, the first 200 characters of its text (a click shows it
  whole, another folds it; your read leaves its state) and its state (queued, delivered or dropped); **Send a Message**
  (it opens from its title) as the owner, to an ID, a pattern or a list.
- **Wakes:** every agent's wakes (trigger, next run, text and check (each the first 200 characters; a click
  anywhere in the cell shows it whole, another folds it; the check in a fixed-width font), end, who set it, when it
  was last set (its schedule counts from then), last fired), **Fire** one now or **Cancel** it; **Set a Wake** for
  any agent. `autocode wakes` shows the same, with a LAST SET column.
- **Locks:** every lock (tier 0c): its capacity (Mutex or N places), its holders with when each hold runs out and
  **Release** (after you confirm; the agent is told and the next in the queue gets it), and its queue in order; a **Lock**
  filter (a pattern, kept in the address). A lock exists only while someone holds it or waits. `autocode locks` is
  the same in the CLI.
- **History:** what happened, newest first: time, kind, agent, host, session and data (a summary; a click shows it
  whole); an **Agent** filter (a pattern, like the Agents filter) and a **Kind** list (one kind with its count, or a
  group like `wake.*`), both kept in the address; **Older** loads the next 100. `autocode history` is the same in
  the CLI.
- **Costs:** every agent's spend today and in total (also past `history_days`; agents that unregistered too, dimmed),
  its daily cap with the share spent and what is left today, and its Context (the share of its compaction threshold,
  the threshold, the model's window as its most, and a bar), refreshed every 5 s; **Days** shows its spend per day
  (kept `history_days`, at least 31 days); an **Agent** filter (a pattern, kept in the address) and a totals row.
  `autocode costs` is the same in the CLI.
- **Help:** how to use Autocode from OpenCode, the CLI and the web UI, with a numbered table of contents.
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
| A lock stays held | `autocode locks` shows the holder and when its hold runs out (its `ttl`); it is freed then, or at once with `autocode locks release NAME AGENT` (or Release on the Locks page). Unregistering an agent releases its locks. |
| A run failed | Its alert says why (the time limit, `run_usd`, the session could not start); its session is kept: look at it in OpenCode, then delete it (Delete Session on the Jobs page, or `DELETE /v1/runs/{id}/session`). A scheduled run while one works is `skipped`. |
| An agent is paused by `cap` | It passed its `daily_usd` today (the server's zone; an inbox alert says how much): it stays paused until the next day, or until you raise its cap (`autocode settings set daily_usd 20 --agent ID`) or resume it. `cap_warn` (90%) warned it before. |
| A session's context grows without end | Autocode compacts it before the next prompt past `compact_at` (50% of the window, at most 500,000 tokens; `off` per agent). History shows `session.compacted`. |
| OpenCode was restarted under a turn | The turn is cut (`turn.cut` in History) and resumed with an `[autocode] resume` prompt once its OpenCode is back. The machine's background service (`opencode serve --service`) is started again by Autocode when it is gone (`opencode.restarted`); any other OpenCode gets an inbox alert: start it yourself. |
| An agent shows `waiting` | It has an open question, permission prompt or approval (tier 0d): `autocode inbox` shows it, with TO when it was sent to another agent. Its wakes and messages wait until it is answered (the first answer counts), it expires (approvals), or it is answered in the TUI. |
| An agent shows `error` | Its last turn failed: the Agents page (or `autocode agents --json`) shows the error (like `provider.internal`: the model's provider failed), the retries sent and the next. Autocode retries every `retry_interval` with what waited, until a turn succeeds (or `retry_attempts` run out: an inbox alert). Errors that come back the same way (`provider.auth`, `provider.invalid-request`, `provider.content-filter`, `provider.unknown`, `provider.unsupported-operation`) are not retried: fix the cause (a key, the model's name), then **Retry** or `autocode retry AGENT`. |
| Registering says `id_taken` | The ID belongs to another session that still exists; unregister there, delete that session, or force the move: `autocode agents register ID --session SESSION --force`. |
| A tool says `session_gone` | The session was deleted in OpenCode; a deleted session never gets a token again. |
| A shell has no `AUTOCODE_TOKEN` | The plugin sets a session's shell values through its OpenCode server's local API before the session's first shell. The Hosts page marks the host **no shell values** (`autocode hosts`: SHELL VALUES `no`) when it cannot reach that API: a standalone server (`opencode run --standalone`, or a TUI with the service turned off), or `opencode serve` without `--port` or without `OPENCODE_SERVER_PASSWORD`; use the background service or start `opencode serve` with both. Otherwise the server was not reachable at that session's first shell; the next shell call sets them once the channel is back. The CLI in that shell refuses to run (it never falls back to the owner's tokens): open a new shell, or pass `--token`. |
| The CLI says "the server at ... is X, not Y" | The URL answers with another server ID than expected (`--server-id`, `AUTOCODE_SERVER_ID` or the client config's `server_id`); no token was sent. |
| `autocode install` waits and fails | `journalctl --user -u autocode`; a port already in use or a bad `--listen`. |
