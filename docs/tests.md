# Autocode Tests <!-- omit in toc -->

_How Autocode is tested, how to run the tests, and the dated results of each tier's checks, with the live checks'
model spend._

- [Suites](#suites)
- [Running Them](#running-them)
- [The Fake Model Server](#the-fake-model-server)
- [Results](#results)

## Suites

Every suite that is not specific to a platform runs in Docker on the CI host (Linux ARM64), one Compose project per
suite (`autocode-ci-<suite>`, its own network, removed afterwards). Only `ci/mac-check.sh` runs on a Mac, natively.

| Suite | What it covers | Topology |
|---|---|---|
| `unit` | type checks (`tsc`), lint (Biome), pure logic: IDs, patterns, durations, settings, the store and its migrations, plugin parts, the fake model, the test helpers | the runner alone |
| `api` | every route of the server, started in-process on an empty data folder with a fake clock; listening (a late Tailscale address); the plugin's channel against it; the plugin module set up with a fake OpenCode context (hooks in OpenCode's order, sessions, events); the CLI as a process | the runner alone |
| `plugin` | the spike checks against real OpenCode (a probe plugin beside the Autocode plugin) | server, one OpenCode machine, fake model |
| `one` | end-to-end: the plugin inside OpenCode, registration through the tool, discovery, shells | server, `node-a`, fake model |
| `two` | the same end-to-end tests across machines, plus a lost machine, a returning one and a network cut | server, `node-a`, `node-b`, fake model |
| `restart` | the server restarted on its volume; an OpenCode machine restarted | server, `node-a`, fake model |
| `install` | `autocode install` and `uninstall` as a systemd user service, and a reboot | a container that boots systemd |
| `web` | the web UI's unit tests (in its image build) and a browser smoke test against a real server | server, Playwright browser |
| Mac check | the macOS binary; macOS paths; `autocode plugin install` into a throwaway OpenCode config, loaded by this Mac's OpenCode, which connects to a local server | native, no Docker |

No automated test calls a real model: OpenCode machines use the fake model server, and the built-in free provider
is off (`OPENCODE_DISABLE_FREE_MODELS=1`).

## Running Them

- On the CI host, from a copy of `source/`: `ci/run.sh [suite...]` (default: all). Test output is kept in
  `__out/ci/<run>/<suite>/test.log`; a failed suite also keeps `services.log` and the server's data folder. The web
  UI's unit tests run while its image builds (`__out/ci/<run>/web-image.log`); the summary shows them as `web-unit`,
  or as cached when nothing in `packages/web` changed since they last passed.
- Binaries with the web UI inside: `ci/dist.sh` on the CI host (`AUTOCODE_TARGETS=all` for every platform) writes
  `dist/autocode` and `dist/autocode-<platform>`; it builds the web UI in Docker first. Every such build takes the next
  build number from the counter `~/.autocode-dev/build-number` on the CI host (`AUTOCODE_BUILD_FILE` to use another;
  `ci/build-number.sh` hands out each number once, under a lock) and checks that its binary says it: `autocode
  --version` prints `v0.1.0-build<n>`. The binaries CI builds for its tests are not numbered: `v0.1.0-dev`.
- The CI images are local only (`localhost/autocode-ci/...`, Compose `pull_policy: never`): a missing one is an error,
  never a pull from a registry.
- Development-time folders on the CI host live in `~/.autocode-dev/` (0700), never in `~/.autocode/`, which is for
  real installs.
- From a development machine: `AUTOCODE_CI_HOST=<ssh host> ci/dev.sh run 'ci/run.sh one two'` mirrors `source/`
  into `~/.autocode-dev/ci` on that host (`AUTOCODE_CI_DIR` names another copy) and runs the command there. Quick
  loops without Docker: `ci/dev.sh run 'bun test tests/unit tests/api'`. `ci/dev.sh fmt` formats there and brings
  the files back; `ci/dev.sh lock` refreshes `bun.lock`. On the CI host itself, `AUTOCODE_CI_HOST=local` does the
  same without ssh: the same copy under this home, and the commands run in a fresh environment, as over ssh.
- On a Mac: `AUTOCODE_CI_HOST=<ssh host> ci/mac-check.sh` (cross-builds the macOS binary on the CI host, in its own
  copy `~/.autocode-dev/dist`, so it never disturbs a run in `~/.autocode-dev/ci`), or `ci/mac-check.sh <path to a
  darwin-arm64 autocode>`. Everything it starts lives under `__out/mac/` (its HOME, so its Autocode home is
  `__out/mac/home/.autocode`).
- `CI_KEEP=1 ci/run.sh <suite>` leaves the suite's containers in place for debugging; remove them with
  `docker compose -p autocode-ci-<suite> -f ci/compose/<suite>.yml down -v`.
- Every container, command and request has a time limit; end-to-end tests wait on events with deadlines.

## The Fake Model Server

`ci/fake-model/server.ts` answers OpenAI-compatible chat completions (streaming or not). Each OpenCode machine
gets its own namespace (`http://fake-model:9000/<node>/v1`). Tests script it with `POST /<ns>/_script
{steps, append}` and read every request with `GET /<ns>/_requests`. A step is a reply (with token counts), tool
calls, an error with a status, a hang or a cut stream; `session`, `match` and `model` pick which request takes it.
OpenCode's own side requests (session titles, compaction summaries) get default answers and never take a scripted
step.

## Results

### Tier 0a (Foundation)

2026-10-28, OpenCode 2.2.0, CI host myspark3 (Linux ARM64, Docker 29.6.2, Compose 5.2.0), Mac check on mymbp4.

**Suites** (`ci/run.sh` run `20261028T132927Z`, 06:29 to 06:37 PT; the web UI's unit tests ran in the identical web
image's build at 06:28 PT):

| Suite | Tests | Result |
|---|---|---|
| `web-unit` (Vitest, in the web image build) | 44 | pass |
| `unit` (with `tsc` and Biome) | 66 | pass |
| `api` | 109 | pass |
| `plugin` (spike checks 1, 2, 6, 10) | 23 | pass (about 6 min: one tool waits 330 s) |
| `one` | 13 | pass |
| `two` (spike check 9 among them) | 19 | pass |
| `restart` | 4 | pass |
| `install` | 3 | pass |
| `web` (Playwright smoke) | 4 | pass |
| Mac check | 9 | pass |

**Spike** (details in the spec's Spike section and in `aipack/instructions.md`): checks 1, 2, 6, 9 and 10 pass. The
plugin can inject, interrupt, compact, create and delete sessions, read status, cost and context size, and answer
permissions in-process; forms and a session's environment need OpenCode's local API (and its password). A tool
waited 330 s inside a turn. OpenCode names a shell's session (`OPENCODE_SESSION_ID`) only after the plugin's shell
hook, on the same environment object, which is where the plugin applies each session's values. Two OpenCode
processes on one data folder see each other's sessions (so a newer plugin instance never reports the older one's live
sessions gone).

**Live checks** (`ci/live-check.ts`; the server as a development process on myspark3, the session in a throwaway
OpenCode 2.2.0 on mymbp4 over Tailscale; variant `high`): each model registered through `autocode_me`, was seen by
the server on the other machine (`autocode agents 'live:*'` there), stayed registered across a server restart, and
its next `autocode_me status` reached the restarted server.

| Model | Agent | Result | Cost |
|---|---|---|---|
| `nvidia-ih/nvidia/moonshotai/kimi-k3` | `live:mymbp4:kimi-k3:20261028T1313` | all 9 steps pass | $0.0460 |
| `nvidia-ih/nvidia/zai-org/glm-5.3` | `live:mymbp4:glm-5.3:20261028T1314` | all 9 steps pass | $0.0184 |

Total live-check spend: $0.064.

**Review:** an adversarial review found 2 high, 5 medium and 8 low issues, plus tests that passed for the wrong
reason; each got a failing test first, then the fix. The high ones: a shell could get another session's token when an
earlier call with the same command never started its shell (the plugin now applies the values when OpenCode names
the shell's session), and a rotated token was kept in plain text in the instruction queue (the instruction now carries
only the session; the plugin fetches the new token). Among the others: a superseded plugin instance's tools failed,
the CLI fell back to the owner's tokens in an agent's shell and never checked the server ID, a server started before
Tailscale listened on localhost only, a deleted session could come back through a late token request, and settings
keys such as `constructor` caused a 500. A second round checked those fixes (one had a new problem: a superseded
instance did not send its events; fixed) and reviewed the web UI (2 medium, 8 low): other sites can no longer frame
the UI, a late 401 for an older token no longer signs the owner out, typed values survive saving another row, a rule
cannot name a setting twice, the token is kept per tab unless the owner asks to stay signed in, and the CI images are
local only. The consumer token's power (it can act for any session, so the UI's read-only view was read-only in the
UI only) went to the owner, who decided that the web UI takes the admin token only (see below).

**After the tier:** the web UI takes the admin token only (the owner's direction, 2026-10-28); the consumer token and
session tokens are refused at sign-in, and the read-only view is gone. `ci/run.sh` run `20261028T225758Z` (15:58 to
16:06 PT): every suite passes with the counts above, except `web-unit` with 43 (the read-only view's two tests went; a
consumer token kept from an earlier sign-in is now refused at start). The browser smoke test checks the refusal.

**Homes and comments (2026-10-28):** everything of an install now lives in `~/.autocode/` (the client config as
`client.json`, the plugin's log in `logs/`; `AUTOCODE_HOME` at install time becomes the service's `--data`), the
development-time folders in `~/.autocode-dev/`, and every source file that allows comments starts with one saying
what it does. `ci/run.sh` run `20261028T232911Z` (16:29 to 16:37 PT) from `~/.autocode-dev/ci`: every suite passes
with the counts above except `unit`, which stopped at Biome's formatting of one test line; after the fix, run
`20261028T233733Z`: `unit` 69 (three new: the Autocode home's paths, the log's 0700 folders, `--data` from
`AUTOCODE_HOME`) and `api` 109 pass. Mac check 9/9 at 16:29 PT (`client.json` 0600 and `logs/plugin.log` in the
macOS home).

**Block headers and 80 columns (2026-10-28 to 29):** every code file now starts with a block comment saying what it
does (`/* */` in TypeScript, CSS and JSONC, `<!-- -->` in HTML, `#` lines where the language has no block comment),
and code lines stay within 80 columns (Biome's line width 80). The only longer lines are test titles, JSON strings
(`package.json` scripts), two sha256 values in `ci/images/opencode/Dockerfile` and a data URL in `index.html`. Every
changed TypeScript file compiles to the same minified code as before, except for whitespace inside the CLI's usage
text, one inline web template and three SQL queries. The shell scripts parse the same, and the Compose files load to
the same values. The CI build image moved to `ci/images/builder/`, since `.gitignore` and Syncthing skip folders
named `build`. `ci/run.sh` run `20261029T073724Z` (00:37 to 00:46 PT), started with `AUTOCODE_CI_HOST=local
ci/dev.sh` on the CI host itself: every suite passes with the counts of the runs above (`web-unit` 43, `unit` 69,
`api` 109, `plugin` 23, `one` 13, `two` 19, `restart` 4, `install` 3, `web` 4). The Mac check for this change is
still to run.

**Web UI layout (2026-10-30):** the Agents and Hosts tables fit their frame (long IDs, folders and sessions wrap
after `:`, `/` and `_`, a session no narrower than 10 characters; a time wraps between its date and clock; the
action buttons stack), the header's items are centered vertically, the main text is 15 px (headings, notes and small
buttons grew by the same step), and a page's first item has no top margin. Five new browser checks (fit at 1280 and
1024 px with an agent as long as a real one, header centers within 1 px, 15 px text, first item without top margin)
and one unit test failed first, then passed: `ci/run.sh web` run `20261030T101102Z`, `web-unit` 44 and `web` 9. Only
the web suites ran, since only the web UI changed. Then the action buttons got a little space between their lines when
they wrap (a sixth check, red at 0 px first): run `20261030T101636Z`, `web-unit` 44 and `web` 10; the owner
then made that space one pixel smaller (3.8 px): run `20261030T101954Z`, the same counts.

**Web UI pages and uninstall (2026-10-30):** a Hosts tab before Agents; the agents by machine (a group row per
machine, no Machine column); no page headings on Hosts and Agents; headings and table headers in Title Case; page
titles with an en dash; the version as `v0.1.0`; buttons as tall as the text fields beside them; all text but
headings 15 px; the favicon an outlined pink-red pyramid; the Agents filter applies a second after the last key.
New checks (a Hosts page unit spec, grouping, the live filter, Title Case, no spaced hyphen in page text, the
favicon, button heights) failed first, then passed: `ci/run.sh web` run `20261030T103829Z`, `web-unit` 49 and `web`
17. `autocode uninstall` now keeps the binary (the owner's `uninstall` on myspark3 had removed `~/.autocode/bin/`):
the install check failed first (exit 127), then `ci/run.sh unit install` run `20261030T103425Z` passed (`unit` 69,
`install` 3). Then three more, each red first: the favicon is a flat outlined triangle (one closed path, no inner
edge; web run `20261030T104311Z`); Hosts and Agents say "Updated Xs ago.", counting up every second, instead of the
load time and the refresh interval (a unit spec of its own; run `20261030T104520Z`, `web-unit` 50); and the Settings
table's Value column holds the edit control with the current value, Save and Reset, with no Change column (run
`20261030T104717Z`: `web-unit` 50, `web` 17). Last, more room: tables sit 0.8rem below what precedes them (was 0.4rem) and cells
have 2 px more padding on each side (6 px and 10 px); two checks, red first: run `20261030T105050Z`, `web-unit` 50,
`web` 19. Then, each check red first: the page title stays "Autocode" on every page; the Agents toolbar has Refresh
and "Updated" at the left and the filter at the right; every button's text is 15 px and every button label is in
Title Case; Settings' "What It Does" is "Description", Save and Reset sit as close as the Agents row buttons and are
as tall as the field, and the Value column is 1.5 times its old width (304 to 456 px at 1280 px); the header shows
`v0.1.0` without the server ID, its title is 17 px and the "admin" badge has no border; checkboxes take the
favicon's pink-red, and the favicon's outline is 2 px. Run `20261030T110020Z`: `web-unit` 50, `web` 24. Then
dropdowns draw their own arrow 9 px from the right border (the native one sat too far right on the Mac), and the
header's "admin", Sign Out and icon are evenly spaced; both checks red first. One layout check was flaky: it could
catch the Agents page's "Loading..." row as it went; the tests now open a tab and wait for its data rows. Runs
`20261030T110937Z` and `20261030T111000Z`: `web-unit` 50, `web` 26. Then 3 px more space between "admin" and Sign Out, and lighter button
borders in the light theme (#aaa); both red first: run `20261030T112928Z`, `web-unit` 50, `web` 27. Then times
show the viewer's own time zone (`28-Oct-26 03:00:00 PT`), wrapping only between the date and the clock with its
zone: a unit spec of `localTime` with fixed zones and a browser check in Pacific time, both red first; run
`20261030T113508Z`, `web-unit` 53, `web` 28. The aisee and browserctl plugins were detached the same day (owner).

**Hosts report their OpenCode process (2026-10-30):** the plugin's hello carries its process ID and kind (the
background service, `opencode serve`, `opencode run` or a terminal UI, read from OpenCode's command line); the
server keeps them (schema migration 2), `/v1/hosts` and `autocode hosts` return them, and the Hosts page has a
Process column. New checks, each red first: the kinds from command lines (unit), hello storing the process and
leaving a missing or bad one empty (api), the CLI's PROCESS column, the real plugin in `opencode serve` reporting
`serve` and its PID (`one`), the page's labels (web unit) and the column in a browser. `ci/run.sh unit api one web`
run `20261030T120142Z`: `web-unit` 54, `unit` 70, `api` 110, `one` 13, `web` 28. A second flaky layout check (it
could catch the Hosts page's "Loading..." row) now waits for the data rows too; three web runs in a row passed.

**Shell values through OpenCode's session environment (2026-11-02, spec draft 17):** the plugin now sets a session's
shell environment through its OpenCode server's local API (OpenCode's own environment plus the four values) before
the session's first shell call and after a rotation, instead of catching `OPENCODE_SESSION_ID` after the shell hook;
the process kinds are those that really occur (background service, standalone, `opencode serve`); the hello says
whether the plugin can set shell values (schema migration 3). New checks: the local API from each start-up (unit), the
environment set once per session, Subagents, re-set after a rotation, none where the API is out of reach (api, with a
fake local API), and against real OpenCode: shells keep OpenCode's own environment and the owner's `!` commands get
the values (`one`, `two`), the background service and a standalone server report their kind and whether shells get
values (`tests/e2e/process.test.ts`), OpenCode's real not-found errors pass the plugin's deleted-session check and a
live session does not (`plugin`), and the session environment replaces OpenCode's own (`plugin`, spike 6). The unit
and api checks and the web checks were red first; the Docker suites' new checks were written before the code but not
run red first. Full run `20261102T082548Z`: `web-unit` 55, `unit` 68, `one` 16, `two` 22, `restart` 4, `install` 3,
`web` 28 passed; `api` (4) and `plugin` (1) failed on two test mistakes (the runner's `OPENCODE_PASSWORD` won over the
test's password; the Autocode plugin, installed beside the probe, set the session's environment over the spike's own),
fixed: run `20261102T083532Z`, `api` 111, `plugin` 25. Then the Hosts page lost its Machine column for machine groups,
as on Agents, and Online became Status (red first): web run `20261102T084218Z`, `web` 28. Live on myspark3 at 00:43
PT: the service's host reports `service 2164472` with shell values, and this session's own shells got their values.

**Published OpenCode interfaces only (2026-11-02, owner's standing rule):** the plugin finds the background service
through `discover()` from the npm package `@opencode/client` (a new dependency), and otherwise reads `opencode serve`'s
documented flags and password variables; it uses a local API only if that API's `/api/info` gives its own process ID.
The process kinds come from the command line's documented subcommand and global flags only: the background service,
`opencode serve` or other (the undocumented "standalone" kind is gone). The deleted-session check takes OpenCode's
published `SessionNotFoundError` first and 2.2's in-plugin `Session.NotFoundError` as a fallback, with no message
matching. Changed checks: the kinds and `serveApiOf` (unit, red first on the import), finding the API from each
start-up (api; its red run was spoiled by an edit of mine, so it was not seen red), both not-found errors (`plugin`)
and a standalone server reporting `serve` (`tests/e2e/process.test.ts`). Full run `20261102T091249Z`: `web-unit` 55,
`unit` 67, `api` 111, `plugin` 25, `one` 16, `two` 22, `restart` 4, `install` 3, `web` 28. `ci/dist.sh` now runs
`bun install` every time (it had skipped it when `node_modules` existed, so the build missed the new package). Live on
myspark3 at 01:22 PT: both folder hosts report `service 2164472` with shell values, and this session's shell token
resolves to this session.

**The frame's padding (2026-11-02, owner):** the web UI's frame has 1.25rem (20 px) on all four sides (it was 1.2rem
by 1.6rem); phones keep their own 0.7rem. A browser check of the padding on the sign-in page and every tab, red first
(run `20261102T093453Z`: `19.2px 25.6px`), then web run `20261102T093547Z`: `web-unit` 55, `web` 29. Screenshots of
the four pages looked at by eye. Live on myspark3 at 01:38 PT.

**"bg service" (2026-11-02, owner):** the Hosts page calls the background service "bg service" (the CLI prints the
kind, `service`, unchanged). The two web unit cases and the browser check expect the new label, red first (run
`20261102T094029Z`, the web unit tests in the image build), then web run `20261102T094045Z`: `web-unit` 55, `web` 29;
the Hosts page looked at by eye. Live on myspark3 at 01:42 PT.

**Numbered builds and the "v" (2026-11-02, owner, spec draft 19):** Autocode's version is the release plus the build,
`0.1.0-build<n>` for a `ci/dist.sh` build and `0.1.0-dev` for any other (`packages/shared/src/version.ts`; the number
is compiled in as `AUTOCODE_BUILD`, in the binary and in the plugin bundle); `ci/build-number.sh` hands out numbers
from `~/.autocode-dev/build-number` under a lock; versions are shown with a `v` in the CLI and the web UI, JSON keeps
them bare. New checks: the version's form, the `v` rule, a numbered plugin bundle and binary, the counter (counting,
eight builds at once, a bad counter) (unit); `--version`, `info`, `hosts`, `serve` and `plugin install` show the `v`
(api); the install suite's install line; the header and Hosts page versions (web unit, browser). Red first: unit and
api in the quick loop (the version tests could not import; five CLI checks), the web unit tests (`versionText`
missing, run `20261102T094813Z`); the install check was not run red first. Full run `20261102T095233Z`: `web-unit`
56, `unit` 74, `api` 111, `plugin` 25, `one` 16, `two` 22, `restart` 4, `install` 3, `web` 29. Build 1 live at 02:01
PT, build 2 at 02:05 PT.

**Shell values in the Process column (2026-11-02, owner, spec draft 20):** the Hosts page has no Shell Values column;
a host whose shells get no Autocode values shows "no shell values" (amber, with the reason as its tooltip) under its
process; `autocode hosts` keeps its column. The browser fixture's long host is now an `opencode serve` without shell
values, so the layout checks cover the mark. Red first (run `20261102T100344Z`), then web run `20261102T100415Z`:
`web-unit` 56, `web` 29; screenshots looked at. Live as build 2.
