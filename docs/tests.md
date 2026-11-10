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

2026-10-28, OpenCode 2.2.0, CI host machine-a (Linux ARM64, Docker 29.6.2, Compose 5.2.0), Mac check on laptop.

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

**Live checks** (`ci/live-check.ts`; the server as a development process on machine-a, the session in a throwaway
OpenCode 2.2.0 on laptop over Tailscale; variant `high`): each model registered through `autocode_me`, was seen by
the server on the other machine (`autocode agents 'live:*'` there), stayed registered across a server restart, and
its next `autocode_me status` reached the restarted server.

| Model | Agent | Result | Cost |
|---|---|---|---|
| `nvidia-ih/nvidia/moonshotai/kimi-k3` | `live:laptop:kimi-k3:20261028T1313` | all 9 steps pass | $0.0460 |
| `nvidia-ih/nvidia/zai-org/glm-5.3` | `live:laptop:glm-5.3:20261028T1314` | all 9 steps pass | $0.0184 |

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
17. `autocode uninstall` now keeps the binary (the owner's `uninstall` on machine-a had removed `~/.autocode/bin/`):
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
as on Agents, and Online became Status (red first): web run `20261102T084218Z`, `web` 28. Live on machine-a at 00:43
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
machine-a at 01:22 PT: both folder hosts report `service 2164472` with shell values, and this session's shell token
resolves to this session.

**The frame's padding (2026-11-02, owner):** the web UI's frame has 1.25rem (20 px) on all four sides (it was 1.2rem
by 1.6rem); phones keep their own 0.7rem. A browser check of the padding on the sign-in page and every tab, red first
(run `20261102T093453Z`: `19.2px 25.6px`), then web run `20261102T093547Z`: `web-unit` 55, `web` 29. Screenshots of
the four pages looked at by eye. Live on machine-a at 01:38 PT.

**"bg service" (2026-11-02, owner):** the Hosts page calls the background service "bg service" (the CLI prints the
kind, `service`, unchanged). The two web unit cases and the browser check expect the new label, red first (run
`20261102T094029Z`, the web unit tests in the image build), then web run `20261102T094045Z`: `web-unit` 55, `web` 29;
the Hosts page looked at by eye. Live on machine-a at 01:42 PT.

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

## Tier 0b (2026-11-02)

**What was added and how it is tested.** Wakes and their triggers (`every`, `at`, `cron` with time zones and
daylight-saving changes, `idle` with `repeat`, `fire-only`), firing and checks; the injection queue (one prompt per
`min_interval`, only while idle, merging by name or text, the `[autocode]` header, what others wrote quoted with
`> `); messages (direct, group, list, owner, files, inline or listed, states, waiting); the owner's inbox, pause,
resume, stop-all and resume-all; turn status from the plugin (working, idle, paused, offline); the agent guide (the
`autocode` skill and the line for registered sessions); reloading a folder the background service unloaded; the
CLI's tier 0b commands; the Inbox, Messages and Wakes pages and the Agents page's controls.

- `unit`: `triggers.test.ts` (parsing, formatting, next runs, cron on fixed dates both ways around the 2026
  daylight-saving changes in Los Angeles); `store.test.ts` (migration 4 on schema-3 data, cascades).
- `api`: `wakes.test.ts`, `messages.test.ts`, `owner.test.ts`, `loader.test.ts`, `cli-0b.test.ts`,
  `review-0b.test.ts` (the adversarial review's findings), and the tier 0b block of `plugin-inprocess.test.ts` (the
  real plugin with a fake OpenCode context: instructions, checks with time and output limits, turn events, the
  guide, the tools with files kept inside the folder).
- `plugin`: spike check 11 (`spike-11-guide.test.ts`): on OpenCode 2.2.0 the skill is listed in the system text's
  skill guidance (not in the `skill` tool's description; the spec was corrected), its body loads through the `skill`
  tool though its path names no file, and the line reaches a registered session's requests and its Subagents' (a
  Subagent's request names the parent session in OpenCode's session header), the same text request after request.
- `one`, `two`: `wakes-messages.test.ts` on real sessions with the fake model: a fired and a scheduled wake arrive with
  the header; a check that exits 1 skips its wake with no model call (counted), one that exits 0 brings its output;
  wakes fired while paused merge; a message crosses machines; a message to the owner is answered back; turn status
  follows a real turn. The tier 0a registration test now expects `working` while the agent registers in its turn.
- `web`: Vitest specs for each page and the browser smoke test (each tab, Pause/Resume, Stop All, answering, sending,
  setting, firing and cancelling a wake).

**Red first, and where not.** Red before the code: the API tests of wakes, messages and the owner's controls (38 of
39 failed), the loader's, the review's (22 of 23), the web pages' (34 of 89 web unit tests, run `20261102T110134Z`),
and the CLI's version/`v` checks. Written before the code but not run red: `triggers.test.ts` and `cli-0b.test.ts`.
Written after the code: the tier 0b block of `plugin-inprocess.test.ts`, the migration-4 store test, spike check 11
and the end-to-end tests (spike 11 failed first on real OpenCode, which is how the skill listing's place was found).

**Runs.** Plugin suite `20261102T104936Z` (spike 11: 2 of 3 failed: the listing, the Subagent); `one two plugin` from
a snapshot (the web worker's red specs stopped the shared run) `20261102T110007Z` (the 0a registration test now saw
`working`; the Subagent check) and `20261102T111055Z`: `one` 23, `two` 29, `plugin` 28. Web worker:
`20261102T110657Z` and `20261102T111002Z`, `web-unit` 89, `web` 34. After the review's fixes, full run
`20261102T113027Z`: `web-unit` 89, `unit` 94, `api` 191 + 1 failed (the test used `pgrep`, which the image lacks; it
reads `/proc` now: api run `20261102T114013Z`, 192), `plugin` 28, `one` 23, `two` 29, `restart` 4, `install` 3, `web`
34.

**Adversarial review** (a separate reviewer, report only): 2 high, 11 medium, 13 low findings. Fixed test first: a
check's time limit now counts from when it was sent; turn events carry OpenCode's time and an older one changes
nothing, the plugin sends its running turns every minute and after a gap in its event stream, and an injection that
starts no turn frees its session after two minutes; agents' text, fired text and check output are quoted; a pause
takes back an injection or check not yet fetched; stop-all interrupts every online agent session, and an interrupt
expires after two minutes; a failed injection brings its wakes back; merging keeps a fire's text and skipped check;
one check at a time per wake, and messages wait behind it at most its limit; waits are cut at 240 s (the HTTP idle
limit is 255 s) and the plugin and CLI wait again; old injections and closed inbox items go with the history; the
owner reads any message; files are never written through a link; a check always runs as its session; checks run as
their own process group; one alert per streak; past times refused; prompt IDs grow with time; the loader checks
`/api/info`, backs off and records a failure once per streak; one bad agent or wake never stops the scheduler. Left:
a resync from `ctx.session.get` for hosts without OpenCode's local API (the watchdog and the running-turns list cover
the common cases), re-sending the very same injection once after an explicit failure, and loading a folder for
pending instructions (only queued wakes and messages trigger it).

**Deployed** on machine-a as build 3 (04:4x PT): database schema 3 to 4 (backup
`~/.autocode-dev/backup/autocode-schema3-20261102.db`), plugin reinstalled; both live hosts on `0.1.0-build3`.

**Live checks** (`ci/live-check-0b.ts`, 04:4x–05:00 PT; the server as build 4 on machine-a, the sessions in machine-a's
OpenCode background service, each model in a scratch folder under `~/.autocode-dev/live/`; variant `high`). Steps:
the folder's plugin connects; two sessions on the model; agent A registers and sets a fire-only wake through the
tools; agent B registers and messages A, and the injection wakes A; the owner fires A's wake and A answers; B's
message to the owner reaches the inbox and the answer reaches B; B loads the `autocode` skill; the agents' turns
were reported; the folder, unloaded through OpenCode's debug route, is loaded again by the server for a fired wake
and A answers.

| Model | Agents | Result | Cost |
|---|---|---|---|
| `nvidia-ih/nvidia/moonshotai/kimi-k3` | `live:0b:kimi-k3:{a,b}:20261102T1153` | 9 of 9 | $0.0806 |
| `nvidia-ih/nvidia/zai-org/glm-5.3` | `live:0b:glm-5.3:{a,b}:20261102T1157` | 9 of 9 | $0.0355 |

A first kimi-k3 run (build 3, $0.0796) passed 7 of 9 and found a bug: the server loaded a folder with
`?directory=`, which OpenCode ignores (a folder goes as `location[directory]=`, as its published client sends it);
fixed test first in the loader (and in the test helper), deployed as build 4. Its other failure was the script's
own: it unloaded the folder while a turn still ran there. Total tier 0b live-check spend: $0.196. The scratch sessions
were deleted afterwards. After the fix: `unit api one` run `20261102T120303Z`: `unit` 94, `api` 192, `one` 23.

**Web UI changes after the tier report** (owner, 2026-11-02 afternoon), by the web worker in its own CI copy, tests
first. Round 1 (the owner's four changes: "Updated Ns ago." in a footer at the bottom left; action results in the
toolbar where it was; Send a Message and Set a Wake full width and collapsed; table cells padded 0.5rem on all four
sides): red `20261102T224918Z` (`web-unit` 21 of 89 failed) and `20261102T225103Z` (`web` 4 of 37 failed: the CSS),
green `20261102T225415Z` (`web-unit` 89, `web` 37). Round 2 (the favicon's triangle before "Autocode" in the header),
under the owner's new rule of running only the tests of what changed: the web suite now takes `CI_GREP` (Playwright's
test-name filter); runs with `CI_GREP="header"` (6 browser checks; the unit specs all run in the image build): red
`20261102T225922Z` (`web-unit` 1 of 90 failed) and `20261102T225939Z` (`web` 1 of 6), green `20261102T230021Z`; the
check tightened to the letters' baseline and height after the screenshots, red `20261102T230400Z`, green
`20261102T230422Z` and `20261102T230534Z` (`web-unit` 90, `web` 6). The full CI did not run (the owner's rule).
Screenshots of both rounds looked at by eye (the worker's and mine). **Deployed** as build 5 (no schema change),
plugin reinstalled; the live UI on machine-a looked at in a read-only screenshot run.
Round 3 (the owner: the header triangle 2.5 times bigger): the header browser check now wants it about 1.7 em tall
and centered on the capitals (it stood on the baseline before); red `20261102T231830Z` (0.69 em, with `CI_GREP`
on that one check), green `20261102T231848Z` (`web-unit` 90, `web` 1), then the six header checks
`20261102T231949Z` (6 pass), since the header grew taller. Screenshots looked at in both themes. Deployed as build 6;
the live UI looked at again (read-only).
Round 4 (the owner: the triangle 15% smaller, 2.05em to 1.74em, about 1.47 em drawn): red `20261102T232342Z`
(1.73 em against at most 1.55), green `20261102T232400Z` (`web-unit` 90, the six header checks pass). Screenshots
looked at in both themes. Deployed as build 7; the live UI looked at again (read-only).
Round 5 (the owner: the triangle 1.25rem with no shift or margin of its own; the title 1.25rem, was 17 px; the
version 3 px lower; after a 1.5rem and a -0.05rem step on the way): the header checks now pin those values (the
version sits about 1.5 px below the header's middle by its margin): red `20261102T235814Z` (3 of 6) and
`20261102T235938Z` (the 1.25rem step), green `20261102T235849Z` (the 1.5rem step) and `20261103T000000Z` (6 pass,
final). Deployed as build 8. Round 6 (the owner: a checked checkbox in a neutral color): checkboxes take the theme's dim
grey (`--fg-dim`), checked on the sign-in form, Settings and the Inbox in both themes: red `20261103T000124Z` (still
pink-red), green `20261103T000154Z`. Screenshots of both rounds looked at in both themes. Deployed as build 9; the live
UI looked at (read-only). The full CI did not run (the owner's rule).
Rounds 7–10 (the owner, 16:0x–16:1x PT), each check first, only its own tests: font weight 500 for the title and
every bold text, one `--bold` variable (red `20261103T000427Z`, green `20261103T000459Z`; the CI font draws 500
like 400, so the computed weights are what the check tests); tables' top margin 1rem (red `20261103T000553Z`, green
`20261103T000615Z` with the weight and footer checks); the Send a Message result, or its error, beside the Send button
and the "Sent as the owner." note gone (unit red `20261103T000824Z`, green `20261103T000853Z`); the forms' titles in
the text color and 2 px after their fold marker (a span's margin: browsers ignore margins on `::marker`; red
`20261103T001000Z`, green `20261103T001035Z` with the Title Case and 15 px checks); the Messages table's ID column and
a click (or Enter) on a row opening its text below it, read through the owner's `GET /v1/messages/{id}` (unit red
`20261103T001307Z`: 4 of 93; green `20261103T001403Z`: `web-unit` 93, 9 browser checks with the page-fit ones).
Screenshots of each looked at in both themes. Deployed as builds 10 (weights, margin) and 11 (the rest); the live UI
looked at (read-only). The full CI did not run (the owner's rule).
Round 11 (the owner: h2 1rem, was 1.16rem): a new check of every h2's size on the sign-in form and Settings, red
`20261103T055435Z` (18.56 px), green `20261103T055454Z` (with the weight and first-item checks). Screenshots looked at.
Deployed as build 12. h3 (the rule editor's) stays 1.05rem, now a little above h2: left to the owner.
Round 12 (the owner: the sign-in form centered on the page): a check of its center at 1280×800 and 1024×700, clear of
the header whose light/dark button still works, and on a 1024×420 window below the header, centered across and
reachable: red `20261103T060928Z` (256 px off), green `20261103T060947Z` (the theme check then read the class before
Angular set it: it waits now, `20261103T061111Z`), the short window's centering red `20261103T061201Z`, green
`20261103T061207Z` with the other sign-in checks. Screenshots in both themes and the short window. Deployed as build 13
on machine-a only (machine-b keeps build 12: the owner's rule); the live sign-in page looked at.
Round 13 (the owner: the sign-in form's texts): one line above the field ("Paste the admin token below."), no visible
"Token" label (the field keeps the name Token for assistive tech), the checkbox "Stay signed in": unit red
`20261103T062707Z`, green `20261103T062730Z` (with the other sign-in checks) and `20261103T062805Z` (Title Case,
button heights, frame padding). Screenshots in both themes. Deployed as build 14 on machine-a only; the live page
looked at.
Round 14 (the owner: the token field's placeholder "admin token", the field 30% shorter): unit red
`20261103T063212Z` (the placeholder), the width check red `20261103T063230Z` (570 px), green `20261103T063257Z` (8
checks: sign-in, page fit, button heights). The field is 25rem (400 px), Sign In right after it. Screenshots in both
themes. Deployed as build 15 on machine-a only (machine-b stays on build 14); the live page looked at.
Round 15 (the owner: the sign-in form just as wide as its content): a check that the frame is the token row plus
its padding and border, at 1280 and 1024: red `20261103T063522Z` (704 px), then `fit-content`, which made the field
shrink to its natural width (a flex basis does not count toward fit-content; the field takes a width now): red
`20261103T063547Z`, green `20261103T063628Z` (8 sign-in and layout checks). Screenshots in both themes, with a refused
token's message (it widens the form, still centered) and in a short window. Deployed as build 16 on machine-a only.
Round 16 (the owner: the sign-in intro line removed): unit red `20261103T063800Z`, green `20261103T063833Z` (5 sign-in
and layout checks). Screenshots in both themes. Deployed as build 17 on machine-a, and on machine-b on the owner's word
("deploy to machine-b": server reinstalled and restarted, schema 4, plugin reinstalled, every online folder on plugin
build 17); both live sign-in pages looked at.
Round 17 (the owner: the sign-in heading's bottom margin 0.6rem): red `20261103T064420Z` (4.8 px), green
`20261103T064453Z` (6 sign-in and layout checks). Screenshots in both themes. Deployed as build 18 on machine-a and, on
the owner's word, machine-b (every online folder on plugin build 18); both live sign-in pages looked at.

**Before the tier 0b commit** (the owner's go, 2026-11-02 22:5x PT): typecheck and Biome clean; every changed line of
code within 80 columns (test titles and the dropdown arrow's data URL excepted, as in tier 0a); `unit` and `api`
without Docker, 286 pass (some lines of the server and plugin were re-wrapped); the whole `web` suite, since every
change since the last full run was the web UI: run `20261103T065905Z` found one browser check left behind by the
Messages table's new ID column (never matched by the per-round filters), fixed; run `20261103T070015Z`: `web-unit` 93,
`web` 46, all pass. The other Docker suites (`plugin`, `one`, `two`, `restart`, `install`) last ran on
`20261102T113027Z` and `20261102T120303Z`; nothing of theirs changed since but line wrapping.

## Tier 0b2 (2026-11-02/03)

**Why.** An agent on machine-b (`team:update-loop:machine-b`, Opus 5.5) could not tell from the guide when an idle
wake falls due, what an injected turn or a skipped check does to it, whether wakes merge, the `end` format or a
check's environment; it read the plugin's bundled code and the binary to find out, and moved its scheduling into
check scripts that use the CLI. Tier 0b2 makes the guide an exact reference and the tools usable first.

**What was added and how it is tested.** The guide (`autocode` skill and `autocode_me action=help [topic]`): use the
tools, how delivery works, every trigger exactly, checks, recipes, messages, prompts, scripts, trouble; longer tool
descriptions (every action, the triggers, how a job fires its wake), `autocode_wake show`, `status`/`set`/`list` that
say when things happen in the server's zone and from now; the `in <duration>` trigger; idle wakes counted from the
later of the idle start and the time they were set; cancelling drops waiting runs; injected wakes that say what they
are and when they run next, and a footer on every injection; `/v1/me` with the server's time and zone, the delivery
settings, the wakes and unread messages; migration 5 (a waiting run keeps its trigger); the owner's message list with
a 100-character preview; the CLI's no-token message points to the tools. Web (the web worker): a Help tab with a
numbered table of contents, wake and message texts shortened to 100 characters that expand on a click.

- `unit`: `triggers.test.ts` (`in`, `localTime`, the help text), `agent-guide.test.ts` (descriptions, status, set,
  list, show, help, the guide answers the update-loop agent's questions, the line), `agents-schedule.test.ts` (the agents
  suite's work-hours check).
- `api`: `agent-info.test.ts` (status, `due`, idle from the set time, cancel drops waiting runs, prompt sections and
  footer), `messages.test.ts` (preview), `cli-0b.test.ts` (no token: use the tools); older tests pinned old texts and
  were updated.
- `web`: Help (contents, anchors, layout), shortened texts on Wakes and Messages; the per-tab layout loops include
  Help.
- **`agents`** (new, real models, `ci/agents/run.ts`; only on the owner's word or in a full run): Opus 5.5, Sol 6.1,
  Kimi K3, GLM 5.3, Haiku 5.5 and Luna (`ci/agents/models.json`), six scenarios each from a plain request: register;
  a reminder in 10 minutes, then the wake fired and acted on; every 30 minutes in work hours on weekdays, only when
  there are new files (the cron schedule checked over a week, every check run with and without a new file); a
  background job that wakes the agent (the job's own command fires the wake); a loop spaced 20 minutes from the end
  of each run (re-armed after a run, or an idle wake); asking the owner and following the answer. Each fails if the
  agent ran the CLI instead of a tool (but in the job's command) or read the plugin's code. It runs on the host,
  isolated (its own Autocode server from the source, its own `opencode serve` with scratch config, data and state
  folders; the provider's key copied to a 0600 file and deleted after), all pairs in parallel; transcripts are kept.
- `ci/run.sh` runs suites in parallel (`CI_PARALLEL`, default 4): a full run took about 6 minutes, build included.

**Red first, and where not.** Red before the code: `in` and the help text, `agent-info` (8 of 8), the preview, the
CLI message, `agent-guide` (the file failed to load, then the job pattern 2 of 15), the web worker's (14 of 102 unit,
6 of 24 browser). Written with the code: the agents suite and its schedule check.

**Agents suite, finding by finding.** First runs on GLM 5.3 failed two scenarios through the harness, not the model
(it waited for the asking turn before answering, and read only the last message); then a transcript showed GLM
passing the job scenario by checking on the job and firing the wake by hand: the job scenario now requires the fire
in the job's own command. The first full run (`20261103T081558Z`): 33 of 36; GLM's polling setup (two cron wakes,
09:00–16:30 and 17:00) was right but the harness looked at one wake (now all together); GLM polled the job with
`every 15s`, and Haiku said it could not get a "job ended" wake: the wake tool's description and the guide's
`fire-only` line now say how a job fires its wake. Rerun of job and polling on all six: 12 of 12 (`20261103T082503Z`).

**Complete CI** (the owner's command) on the final code, run `20261103T082717Z`: `unit` 114, `api` 202, `plugin` 28,
`one` 23, `two` 29, `restart` 4, `install` 3, `web` 50, `web-unit` 103 (cached), `agents` 36 of 36 (Opus, Sol, Kimi,
GLM, Haiku and Luna each 6 of 6; $0.80). Tier 0b2 agents-suite spend, smoke runs included: $2.32.

**After 0b2: the Set column** (the owner, 2026-11-03 09:1x PT: "add "Set" column to all 3"): when a wake was last set
(`updated_at`; setting it again replaces it and restarts its schedule) in the web Wakes table (between Set By and
Last Fired), the CLI's `autocode wakes` (SET, before TEXT) and the agents' `autocode_wake list` (`set <time>[ by
<who>]`); the guide, Help, howto and runbook say so. Red first: `agent-guide` list and `cli-0b` wakes table (2 of 26),
the Wakes unit spec in the web image build (`20261103T171944Z`). Green: unit/api 38 (`agent-guide`, `cli-0b`,
`plugin-inprocess`), `20261103T172022Z` web-unit 103 and 16 Wakes and layout checks (page fit at 1280 and 1024 px),
`20261103T172138Z` 7 Help and layout checks after the Help text. Screenshots in both themes. Deployed as build 21 on
machine-a only (it has no wakes now, so the live table was empty).
Deployed as build 21 on machine-b too, on the owner's word (2026-11-03 12:5x PT): its database backed up at schema 4
(`~/.autocode/backup/autocode-schema4-20261103.db` there), then migrated to 5; plugin reinstalled, every online folder on
build 21; `autocode wakes` there shows SET for the update-loop agent's two wakes, and its `idle 30m repeat` wake fell due
30 minutes after the session's last turn ended (12:26 to 12:56 PST) and was being handled.

**After 0b2: folding, links and IDs** (the owner, 2026-11-03 13:0x–14:0x PT; the web worker, then me):
- The owner's message `preview` is 200 characters: `messages.test.ts` red, then green (12).
- Web: Wakes Text and Check and Messages Text fold at 200 characters and a click anywhere in the cell toggles them;
  Check in a fixed-width font (the check measures equal widths; it found that the CI container's generic monospace
  is a CJK font whose `…` is two characters wide, so `code` now names Consolas, Liberation Mono and DejaVu Sans Mono
  before `monospace`; Menlo still comes first on the Mac); the Wakes trigger wraps; Agents has a Host column; agent
  IDs elsewhere link to Agents and host IDs to Hosts, which highlight the row (scrolled into view, kept across the
  refresh, the Agents filter cleared when it hides it, a line when the ID is gone). Red `20261103T212456Z` (18 of 113
  unit), `20261103T213244Z` (5 of 30 browser), green `20261103T213534Z` (113 unit, 30 browser) and
  `20261103T213752Z` (13 more checks the font could touch).
- IDs and id-like names: first on one line (`white-space: pre`): Agents no longer fit at 1280 nor Agents, Wakes and
  Messages at 1024; the owner chose "long IDs wrap at : and _": each ID never breaks inside a part, only after `:` or
  `_` (`appId`, `idParts()`); 1024 still overflowed (a session ID's random part, a long wake name), and the owner
  chose "fit only at 1280 px": the page-fit check covers 1280, and a new check makes sure that at 1024 px every page
  scrolls inside the frame, never the window, and the Agents row's last button can be reached. Red
  `20261103T214320Z`, `20261103T214415Z`, `20261103T224136Z` (14 of 116 unit), `20261103T224338Z`; green
  `20261103T233652Z` (116 unit, 33 browser: page fit 1280, the 1024 frame scroll, "id cells:", `link:`, the layout
  loops, Messages, Wakes, Settings, Help). Screenshots in both themes and in Pacific time.
- IDs wrap as normal text (the owner, 16:0x PT: "instead of white-space: pre, use normal"): the parts keep the
  break points after `:` and `_`, and the browser's own (after `-`) come back; never inside a word. The "id cells:"
  check now walks each cell's characters and requires every queue but the last to end with a separator, and the long
  wake name to wrap: red `20261104T000006Z`. "Set" renamed "Last Set" (web column, the CLI's LAST SET, the agents'
  list `last set ...`): red `agent-guide` and `cli-0b` (2 of 26) and the Wakes unit spec (`20261104T000044Z`). Green
  `20261104T000145Z`: unit 116, browser 31 (ID cells, page fit 1280, the 1024 frame scroll, links, the layout loops,
  Messages, Wakes, Settings, Help); unit/api 38. At 1024 px Wakes fits again; Agents scrolls in the frame.
- Tabs with 2 px rounded top corners (the owner); the Help contents' links stay square: red `20261104T000411Z`,
  green `20261104T000429Z` (15: the new check, Help, header, tabs, Title Case, page fit, first item). Screenshots at
  3x in both themes.
- The highlighted row (the owner, 16:2x PT: an inset glow `box-shadow: inset 0px 0px 7px var(--link)` with the
  `--sel` background): now on the row, as cell backgrounds would cover a row's shadow; the 3 px left line goes. The
  host-link check compares the row's background, shadow and cells in both themes: red `20261104T013142Z`, green
  `20261104T013200Z` (8: `link:`, cell padding, room above tables, first item, page fit, the fixture). Screenshots
  in both themes, with a 2x close-up: the glow paints around the whole row.

**Before the tier 0b2 commit and tag** (the owner's "commit and publish -0b2 tag", 2026-11-03 22:0x PT): typecheck and
Biome clean; two lines over 80 columns re-wrapped. The complete CI (a release tag), run `20261104T055935Z`: `unit` 114,
`api` 202, `plugin` 28, `one` 23, `two` 29, `restart` 4, `install` 3, `web` 56, `web-unit` 116 (cached), all pass;
`agents` 31 of 36 ($0.79): GLM 5.3 got no answer at all in four sessions (no messages, $0.00, 6–8 minutes; its first
two passed): the provider, not the model's use of Autocode; Sol 6.1 ran the job in OpenCode's own background shell,
whose end notification woke the session before Autocode's prompt, and the harness took that turn for the wake's. The
job scenario now waits for Autocode's prompt (`injection.sent`) and the turn after it. The agents suite again on the
final code, run `20261104T061059Z`: 36 of 36 (each model 6 of 6; $0.80). Tier 0b2 agents spend so far: $3.91.

## Tier 0b3 (2026-11-04)

**Why.** The model provider was down for a while: the update loop on machine-b could not answer its wakes (its
turns failed with `provider.internal` at 14:51 and 15:22 PST), it still showed `idle`, and nothing retried; the hub
was back by 15:52 (that wake's turn succeeded). The owner: mark such agents as in an error state, and retry every X
minutes (a setting) up to X attempts (0: no limit, the default); answers: `retry_interval` 1m, only transient
failures retried, wakes and messages go with the retries, built now as 0b3.

**What was added and how it is tested.** Settings `retry_interval` and `retry_attempts` (the unused `retry`
backoff gone); migration 6 (the agent's error state); `retries.ts` (the state from each turn's end, which failures
retry, the owner's retry, the retry prompt's first part); delivery holds an agent in error and sends retry prompts
with what waited; agent status `error` and an `error` view; `POST /v1/agents/{id}/retry`; `autocode retry`;
`autocode_me status` and the guide explain it.

- `unit`: `settings.test.ts` (defaults, values, refusals), `agent-guide.test.ts` (the status text: retried, not
  retried, retries run out; the guide explains retries).
- `api`: `retries.test.ts` (13: the state and the next retry; retries every interval and recovery; the interval
  per agent; an interrupted turn; holding wakes and messages and carrying them; delivery as usual after recovery;
  pause; `retry_attempts` and the alert; failures not retried and their alert; the owner's retry; a failure without
  a type); `cli-0b.test.ts` (`autocode retry`, refused when not in error); two older tests pinned a failed turn's
  `idle` status and now expect `error`.

**Red first.** The 16 new unit and API tests failed before the code (and the CLI test), then passed: unit and API
328, CLI 29.

**Spike check 5's question, answered on the host** (OpenCode 2.2.0, a throwaway `opencode serve` and the fake
model): a provider that keeps answering 500 gets 11 requests (OpenCode's own 10 retries) over about 85 s, then the
turn ends `failed`; the session holds no error type, the `session.execution.failed` event does.

- `e2e`: `retries.test.ts` on every node: the fake model answers 11 times 500, then a reply; the agent shows
  `error` with `provider.internal` (as OpenCode names a 500), `[autocode] retry 1` reaches the model with "Your last
  turn failed: provider.internal ... Continue where you left off.", and the agent is `idle` again, recovered after
  one retry (`one` about 87 s, `two` about 92 s).
- `web` (the web worker): the Agents page's error state (status `error`, the error and its retries under it, the
  times in a tooltip) and Retry; Help (Agents, Settings, Troubleshooting, the commands, the retry prompt). Red
  `20261105T000934Z` (7 of 121 unit), `20261105T001234Z`, `20261105T001519Z`; green `20261105T001748Z` (28 browser
  checks: "error state:", the page fit, links, the layout loops). Screenshots in both themes.

**Complete CI** on the final code, run `20261105T002100Z`: `unit` 115, `api` 214, `plugin` 28, `one` 24, `two` 30,
`restart` 4, `install` 3, `web` 57, `web-unit` 121 (cached), `agents` 36 of 36 (each model 6 of 6; $0.89).

**After 0b3: the active tab** (the owner, 2026-11-04 20:1x PT): `padding-top: 10px` and `border-bottom: 2px solid
var(--panel)`, z-index 2 kept. A check of the active tab's padding, bottom border and its color, z-index, and the
other tabs': red `20261105T042759Z`, green `20261105T042825Z` (15: the new check, tab corners, header, Title Case,
page fit, the 1024 frame scroll, frame padding, first item, Help). Screenshots at 3x in both themes. Build 27 on
machine-a and machine-b.
- The highlighted row without a background (the owner, 20:3x PT: "rm bg color from hilighted tr"): only the inset
  glow. The host-link check now requires the row's and cells' backgrounds to be another row's: red
  `20261105T043739Z`, green `20261105T043803Z` (9: `link:`, cell padding, room above tables, first item, page fit,
  the fixture, the error state). Close-ups in both themes. Build 28 on machine-a and machine-b.

**After 0b3: the History tab** (the owner, 2026-11-04 20:4x PT: "add history tab to web ui"; filters "Agent + kind,
paging"). API, tests first: `match` (an agent pattern), `kind` with a prefix (`wake.*`), `before` (paging), `GET
/v1/history/kinds`: 4 red, then `history.test.ts` 10, unit and API 333. Web (the web worker): the History tab after
Wakes (Agent filter, Kind list with groups and counts, both in the address; Time, Kind, Agent and Host links,
Session, Data folded at 200 characters and whole as JSON on a click; Older; the refresh merges the newest page);
Help 5.6. Red `20261105T051501Z` (14 of 133 unit), `20261105T052233Z` (the toolbar on one row); green
`20261105T052251Z` (133 unit, 40 browser: "History:", page fit, the 1024 frame scroll, links, the fixture, the error
state, Help, id cells and the layout loops). Screenshots in both themes.


**Before the 0b4 tag** (the owner's "commit/tag/push", 2026-11-04 21:3x PT; the tag `v0.1.0-0b4` by the owner's
choice). Complete CI, run `20261105T053426Z`: `unit` 115, `api` 218, `plugin` 28, `one` 24, `two` 30, `restart` 4,
`install` 3 all pass; `web` 62 of 63: the tab-corner check still counted 7 tabs (the History tab makes 8; it now
counts the tabs there are), rerun `20261105T055025Z` 63 of 63; `agents` 33 of 36 ($0.91): Kimi K3 3 of 6. Kimi's
provider was slow that night (its scenarios took 340–760 s where others took 20–80 s); two setup turns did not end
within the harness's 8 minutes, with every Autocode call right up to there. Its job scenario showed a harness race:
the 20 s job fired the wake while the setup turn still ran, and the harness looked for Autocode's prompt only from
the end of that turn; it now looks from the fire. Kimi alone again, `20261105T055132Z` 4 of 6 (a slow setup turn, and
the job race before the fix), `20261105T060640Z` 5 of 6 (a slow setup turn), and reminder, loop and polling once
more, `20261105T061801Z`: 3 of 3 ($0.08). Kimi spend tonight $0.59 beyond the full run.

## Tier 0c (2026-11-05)

**Why.** The plan's tier 0c, Coordination: named locks and semaphores shared by agents on every machine (the owner's
go, 2026-11-04: "when done self compact and implement 0c").

**What was added and how it is tested.** Migration 7 (`locks`, `lock_entries`); `locks.ts` (creation and capacity,
try, the line in arrival order, the ttl from the grant, renew, release, expiry, grants as places free, removal of
empty locks, unregister); routes `POST /v1/locks/{name}/acquire|renew|release` (the owner's release names the agent)
and `GET /v1/locks`; notices as messages from `autocode`, shown in a prompt as Autocode's own text with their subject
in the header; `wait` inside the call (no notice when granted there); `/v1/me` `locks`; `autocode_lock`, the status
line, the guide's `locks` topic; `autocode locks`, `autocode locks release`.

- `unit`: `locks.test.ts` (15: the class on an in-memory store with a fake clock), `lock-tool.test.ts` (9: the
  tool's description, acquire granted, queued, try and the errors, a wait asked again past 240 s, granted in the
  call, renew, release, list, status, the guide's part).
- `api`: `locks.test.ts` (15: the routes and their codes; history; the grant's prompt; a semaphore's; expiry with
  its holder told and the next granted; a notice with a message; held while paused; a wait granted in the call or
  not; `max_tool_wait`; the owner's release told; `/v1/me`; unregister; two stress tests: 12 agents on a semaphore
  of 3 with random timing, three rounds, never more than 3 holders and granted in arrival order, and waits racing
  releases); `cli-0b.test.ts` (`autocode locks`, the pattern, `--json`, the owner's release, refused in an agent's
  shell).
- `e2e`: `locks.test.ts` on every node (three agents, the first on the first machine): a mutex in arrival order with
  the grant as a notice; a semaphore of 2 with a wait granted inside the tool call and the owner's release told;
  a 5 s hold that expires, its holder told and the next granted; unregister frees it. `one` 27, `two` 33, run
  `20261105T192419Z`.

**Red first.** The 30 unit and API lock tests failed before the code (`Cannot find module`, 0 of 15 API), then passed;
the stress tests three runs in a row. `lock-tool.test.ts` and the CLI test failed, then passed. Unit and API 372, CLI
30.

- `web` (the web worker): the Locks tab after Messages (a Lock filter in the address; Lock, Capacity as Mutex or N
  places, Holders with the agent link, until when and Release after a confirm, Line in order; the empty page);
  `autocode` shown as a plain word on Messages (lock notices come from it); Help 3.5 (locks for agents) and 5.5 (the
  page), the commands. Red `20261105T193214Z` (16 of 146 unit); green `20261105T194409Z` (146 unit, 45 browser:
  "Locks:", the page fit, the 1024 frame scroll, links, the fixture, the error state, History, Help, id cells, the
  9 tabs' corners and the layout loops), `20261105T194555Z` (the "Locks:" checks on a fresh server). Screenshots in
  both themes. Not run red in the browser (the red run stops at the unit tests).


**The review** (an adversarial reviewer subagent, read only, 2026-11-05; the first separate review since 0b2): no way
past a capacity or out of arrival order; three bugs and seven risks fixed, test first (13 tests red, then green):
- a plugin `wait` asked again without end: the server now answers `max_wait` (`max_tool_wait`) and the plugin stops
  there; `seconds` is required;
- a grant to a wait whose caller left (the tool call stopped: OpenCode's `context.signal`, now passed on) was told
  to nobody: it comes as a notice; the owner's own wait no longer holds back the agent's notice;
- the owner could act for an unregistered or reserved ID, whose failed notice cut off the next one's and answered
  500: only registered agents; one notice failing does not stop the others or the waits;
- a hold past its ttl counted as held until the tick (renew, re-acquire ahead of the queue): it is freed before any
  change to its lock;
- entries of agents gone after a crash are swept at the start; notices waiting for an unregistered agent are
  dropped; the owner taking an agent out of a line tells it (`out of the queue`); one in the queue acquiring again takes
  the new ttl, `try` from it is refused; lock expiry and delivery have their own error handling; waits end at stop;
  the tool's texts (another `max` is refused; unregister releases locks; the clock call failing does not turn a
  grant into an error; a wait that ends out of line says so); the CLI's refusal names the tool for the conversation.
- Not changed: a ttl counts from the grant also while the notice waits (the guide and howto say so); notices are
  written right after their transaction, not inside it (a crash between loses one notice; the sweep at the start
  covers the entries).
Unit and API 391; the lock API tests 22, three runs in a row.

**Complete CI** on the final code (with the review's fixes), run `20261105T211059Z`: `unit` 150, `api` 241, `plugin`
28, `one` 27, `two` 33, `restart` 4, `install` 3, `web` 67, `web-unit` 146 (cached), `agents` 36 of 36 (each model 6 of
6; $1.08). Build 30 on machine-a and machine-b (schema 7; schema-6 backups `autocode-schema6-20261105.db` on each).

**After the 0c CI: Remove, "queue" and "Type"** (the owner, 2026-11-05 13:4x–13:5x PT: a button to take an agent out
of a lock's queue; "rename to queue"; "rename Capacity col to Type"). Server, plugin, CLI, tests and docs: "line"
became "queue" (the notice `lock "NAME": out of the queue`, the tool's texts, the guide, the CLI's `QUEUE` column);
unit and API 391. Web (the web worker): Remove per waiter with a confirm and its notice, the Queue and Type headers,
Help: red `20261106T055142Z` (4 of 148 unit), `20261106T055807Z` (5 of 148), browser red `20261106T055847Z` (3 checks
naming the old words); green `20261106T060054Z` (148 unit, 31 browser). Then `one` 27, `two` 33, `web` 68, run
`20261106T060521Z`. Screenshots in both themes. Build 31 on machine-a and machine-b.

**A read message is not announced** (the owner, 2026-11-05 22:1x PT: on machine-b, `team:importer` read a reply
with the tool at 22:57:41 during a turn; when the owner interrupted it at 23:02:35, the reply was injected at
23:02:36). Delivery now leaves a waiting message out once the agent has read it (`message.skipped`, "already read").
And (the owner, 22:2x PT) the owner's views never mark a message read: pinned for `GET /v1/messages`,
`/v1/messages/{id}`, the agent's `list`, and the CLI's `messages` and `messages read` as the owner. Tests first:
`messages.test.ts` (a read during a turn, with a wake and an unread one, a lock notice read with the tool; the
owner's and the agent's views) 3 red then green; `cli-0b.test.ts`; the guide (red, then green). Unit and API 396;
`one` 27, `two` 33, run `20261106T071213Z`. The web UI calls only the owner's routes.

**Session tokens kept and expired** (the owner, 2026-11-05 23:3x PT: "yes" to cleaning up a session's older tokens;
then "Reuse + expire unused", since a running job keeps the token it started with). The plugin keeps each session's
token in OpenCode's plugin storage (`ctx.storage`, keyed by server URL and session) and uses it again after a reload,
replacing it once when the server refuses it; a deleted session's is removed. The server notes each session token's
last use (migration 8, `tokens.used_at`, at most one write a minute) and maintenance revokes those unused for 30 days.
Tests first: `tokens.test.ts` (a token unused 30 days revoked, one in use kept, owner tokens untouched) and
`plugin-inprocess.test.ts` (a reload reuses the stored token: still one token; a revoked stored one is replaced: two),
both red then green. Unit and API 398; `plugin` 28, `one` 27, `two` 33, `restart` 4, run `20261106T073347Z`.

**Before the 0c tag** (the owner's "commit and tag v0.1.0-0c, push", 2026-11-05 23:4x PT). Complete CI on the final
code, run `20261106T074328Z`: `unit` 150, `api` 248, `plugin` 28, `one` 27, `two` 33, `restart` 4, `install` 3, `web`
68, `web-unit` 148 (cached), `agents` 36 of 36 (each model 6 of 6; $1.05). Build 33 on both machines is this code.

## Tier 0d (2026-11-07)

**Why.** The plan's tier 0d, Owner in the Loop, with the owner's 2026-11-07 additions: another agent can answer
questions, permission prompts and approvals (`agent:<id>`, `autocode_message answer|escalate`), the first answer
counts, only the owner allows a permission always, and approvals have `ask` and `wait` only.

**Spike** (the published interfaces, then live in e2e): permissions through `ctx.permission` (list, reply) and their
events; the question tool's forms through OpenCode's local API (`GET /api/session/{id}/form`, `POST
.../form/{id}/reply`, `DELETE .../form/{id}?message=`, as `@opencode/client` 2.2.0 calls them), since the plugin
context has no forms; the form's fields `q0..qN`; a reply continues the turn. Checks 3 and 4 pass.

- `unit`: `plugin-asks.test.ts` (10: a form and a permission as events, a form that is not the question tool's,
  carrying out answers, bad decisions; `autocode_message answer|escalate`; `autocode_approval ask|wait`; the guide's
  `asks` part); `settings.test.ts` (the `mode` kind).
- `api`: `asks.test.ts` (24: ask, auto, a session that is no agent's, settled in the TUI, reported again; a
  permission once/always/reject and approve; `agent:<id>` with its notice and answer, the owner first, only the one
  sent to, a delegated permission's `always` refused, escalate as a note, its own ask and an unregistered agent to
  the owner, `job:` to the owner until 0f, the mode values; `waiting` and wakes held, a deleted session, `/v1/me`;
  approvals with options and a wait, expiry, approve and `agent:<id>`, bad input; the inbox lists every kind) red
  (22 of 24), then green; `cli-0b.test.ts` (the inbox's asks with TO; `answer` for a question and a permission; a
  late answer refused).
- `e2e`: `asks.test.ts` on every node (the question tool answered by the owner, reaching the turn; a permission
  prompt from the session's own `shell: ask` rule, once by the owner, then by `approve`; a question sent to another
  agent and answered by it with the tool; an approval asked, approved with an option, told by a notice): first run
  failed (the plugin context has no forms), then green. `one` 31, `two` 37, `plugin` 28, run `20261108T014928Z`.
- `agents`: two new scenarios, `answerer` (a second session of the model asks with the question tool, sent to the
  agent, which answers from its notes) and `approval` (a risky step asked as an approval, done only once approved):
  glm-5.3 and haiku-5.5 4 of 4 ($0.03) on a filtered run.
- A lock stress test (simplification 4's) raced when both holders left before an acquire (the lock came back with
  capacity 1): the test now gives `max` each time; 30 runs green.

## Tier 0e (2026-11-07)

**Why.** The plan's tier 0e, Reliability, with the owner's 2026-11-07 simplifications: one cap (`daily_usd`, with
`cap_warn` configurable), and only the machine's background OpenCode service restarted.

- `api`: `reliability.test.ts` (12: steps' costs per agent and day in the server's zone, a session that is no
  agent's, bad cost events; the `cap_warn` notice once, the pause after the turn past the cap and its alert, lifted
  by a higher cap and a new day while an owner's pause stays, `cap_warn` set; compaction past `compact_at` before
  the next injection, `off`, `/v1/me/compact` after the turn; a turn cut while OpenCode was away resumed, an idle
  one not; expiry after `expire_after`) and `loader.test.ts` (the background service gone: started with
  `@opencode/client`'s `ensure`, then the folder loaded; another kind of OpenCode: one alert) red, then green.
- `unit`: `plugin-costs.test.ts` (a step's cost event, its context and the model's window; `autocode_me compact`;
  status's spend; the guide's `costs` part).
- `e2e`: `costs.test.ts` (with the fake model's usage: the steps' cost, the cap's pause and its lifting; a
  compaction by OpenCode before a wake); first run failed (a session without its own model: the plugin now asks
  OpenCode's default model), then green. `restart`: a turn cut by restarting OpenCode under it, then resumed.
- The Docker CI but the agents suite, run `20261108T022723Z`: `unit` 161, `api` 281, `plugin` 28, `one` 33, `two` 39,
  `restart` 5, `install` 3, `web` 77, `web-unit` 160. Build 35 on both machines (schema 10; schema-8 backups).

## Tier 0f (2026-11-07)

**Why.** The plan's tier 0f, Spawned Agents, with the owner's 2026-11-07 simplifications: a fixed run ID
`<job>:<start minute>` and a failed run's session kept until the owner deletes it.

**Spike** (check 7, published interfaces only): the plugin context has `ctx.session.create` (location, model,
variant, agent), `ctx.session.remove` and `ctx.session.context`; the first prompt's ID must be OpenCode's `msg_...`
form (found in e2e; `promptId` is shared now).

- `api`: `jobs.test.ts` (15: set, list, delete, what agents see; the checks of a job; the owner's run spawned,
  registered under the run's ID and prompted with the starter's text; one run at a time (refused, skipped); a
  scheduled run; finish with the result in the owner's inbox, the agent gone, the session removed; the last reply as
  the result; an agent's run with the result as its notice; the time limit (interrupted, an alert, the session kept,
  then deleted by the owner); `run_usd`; a spawn that fails; `job:<name>` asks answered by a run, and the owner's
  while the job is busy; the prompt ID) red (12 of 13), then green; `cli-0b.test.ts` (`autocode job
  set|list|run|runs|delete`, a busy run refused, usage errors).
- `unit`: `plugin-jobs.test.ts` (6: the spawn's session input, the last reply, `autocode_me jobs|run|finish`, the
  guide's `jobs` part).
- `e2e`: `jobs.test.ts` in `two` (an agent on one machine starts a run on the other; the run's session finishes
  with the tool; its result comes to the starter as a notice; the session is removed): failed first (the host's
  machine name; then the prompt ID), then green, run `20261108T025104Z`.

## Adversarial Review of 0d to 0f (2026-11-07)

**Why.** A read-only adversarial review of tiers 0d, 0e and 0f and the simplifications before them found 42 points:
bugs, risks, spec deviations, misleading texts and stale comments. Each behaviour fix got a test first (red, then
green). Migration 12 holds the fixes' columns, and deletes the settings the simplifications removed.

- **Asks** (`asks.test.ts` "review of 0d", 8; `plugin-asks.test.ts` "review of 0d", 5): a settled form reported again
  opens no second ask (the `ref` stays; the plugin skips forms not `pending`); a turn's end closes its open questions
  and permissions; the plugin's `asks.pending` after each hello closes the ones OpenCode no longer has; the owner
  closes an ask (`POST /v1/asks/{id}/close`); an answer the plugin could not carry out (no local API, a reply OpenCode
  refused) opens the ask again with a note and an alert; a Subagent's form or request is answered in its own session
  (`form_session`); answer keys are the form's own; a `job:` ask whose job cannot start a run goes to the owner; the
  approval wait loop stops when the server answered early; a permission list's `{data}` is unwrapped; the answering
  agent's texts (the option before the note; an approval's answer says the asker is told).
- **Costs** (`reliability.test.ts` "review of 0e", 9; `plugin-costs.test.ts`): no second compaction until an
  injection went out (the compaction's own step no longer counts as the context); `compact_at` at least 10,000; a
  `turn.ended` right after a hello undoes the cut (no false resume after a deploy); the owner's pause and Stop All
  replace a cap's; the owner's resume of a capped agent holds for the day (one alert); a step sent twice counts once
  (its message ID); a repeated turn event at the same time applies once; stored removed settings no longer block a
  change; a deleted session's agent stays `offline` with its locks freed (the spec now says so); expiry skips agents
  with an open ask or the owner's pause; the plugin chains a session's steps and reports its turn's end after them;
  a cap's pause says how it ends in `autocode_me status`.
- **Jobs** (`jobs.test.ts` "review of 0f", 14; `plugin-jobs.test.ts`, 2): a run with a wake, a lock wait or a prompt
  in flight does not end at its reply; the hello names the host's run sessions (a restarted plugin forgot them); a
  run whose turns fail and are not retried fails; a run's cost counts all its days; a running run's session cannot
  be deleted, a removal goes to the session's own host; a run never takes an ID another live session holds (no
  force), and does not unregister it; `owner` in a destination list reaches the inbox; the whole result stays in
  the run (the message is cut, and says where); with `delete_session` the session goes when the run's last turn ends;
  a scheduled run refused in the same minute is recorded as skipped; how a run started has its own column (an agent
  named `schedule` is no schedule); `every` keeps its anchor; the failure alert names `autocode job delete-session`;
  an offline host's run waits for it (the folder loaded again) up to the time limit, a spawn sent again when its
  instruction expired, and a late spawn's session removed; the last reply is the newest message with text.
- **CLI** (`cli-0b.test.ts`): `--keep-session` is a switch; `autocode job delete-session RUN`; the agent-shell guard
  names the setup commands it allows.
- **Docs and comments**: the spec's lock actions, the scripts' commands, the job routes, `cap_warn` once a day (no
  `run_usd` warning), the cap's pause, the restart's rule, deleted sessions; stale comments in `asks.ts`, `agents.ts`,
  `hosts.ts`, `delivery.ts`, `costs.ts`, `messages.ts`, `store.ts`, `tools.ts` and one test name.
- Unit and API 502; the Docker CI but the agents suite, run `20261108T051614Z` (`unit` 174, `plugin` 28, `one` 34,
  `two` 40, `restart` 5, `install` 3, `web` 81) and `api` 328 (`20261108T052230Z`, after one CLI test timed out
  under load: it now has 30 s).
- The complete CI `20261108T052404Z`: every suite green but `agents` (36 of 48). Two causes. (1) `owner`, all six
  models: they now ask the owner through `autocode_approval` (an ask), and the scenario answers what the inbox lists
  through `POST /v1/inbox/{id}/answer`, which knew only messages (404 `no_item`). The inbox's answer and close routes
  now take the asks they list too (`asks.test.ts`, "an ask is answered and closed through the inbox's own routes
  too", red then green), and an approval's text answer may put punctuation after its word ("Yes, you may ...").
  (2) `kimi-k3`, six scenarios: the model stopped after a tool call and never ended its turn (8 minute limit); its
  `register` took 144 s against 9 to 26 s in the runs before. The provider stalled; no Autocode cause found.
- The second complete CI `20261108T055549Z`: `unit` 174, `api` 329, `plugin` 28, `one` 34, `two` 40, `restart` 5,
  `install` 3, `web` 81 (`web-unit` 175), `agents` 44 of 48 ($1.14): `opus-5.5`, `sol-6.1`, `glm-5.3`, `haiku-5.5`
  and `luna-6` 8 of 8 (`owner` passes for all six now); `kimi-k3` 4 of 8 (`reminder`, `job`, `loop` timed out
  waiting for a turn that never ended; `answerer`'s asker never called the question tool). Outside Autocode,
  `opencode run` with `kimi-k3` took 122 s for a one-word reply, then 4 s: the provider stalls, as in the run before.
- The owner's pick (2026-11-07), `agents` with `AGENT_MODELS=opus-5.5,sol-6.1,sonnet-5.5`, run `20261108T063701Z`:
  24 of 24 in 64 s ($1.33): `opus-5.5` 8 of 8 ($0.41), `sol-6.1` 8 of 8 ($0.38), `sonnet-5.5` 8 of 8 ($0.54).
  `sonnet-5.5` (`nvidia-ih/aws/anthropic/bedrock-claude-sonnet-5-5`, variant high) joined `ci/agents/models.json`.

## The Owner's Round of 2026-11-07 Evening

- **An approval's text once in the Inbox** (`inbox-page.spec.ts`, the approval and Show Closed tests; `smoke.spec.ts`
  "Inbox: an approval approved with an option"; red, then green): the page's title for an approval names the agent
  only ("Approval for team:lead"), the text shows once under it with its lines, a closed approval keeps its text.
  The server's title stays as it was for the CLI's `inbox` table and `autocode_me status`.
- **Form titles in the label colour** (`smoke.spec.ts`, the collapsed forms test): `details.panel > summary` is
  `var(--fg-label)` (dark `rgb(174, 183, 192)`).
- Web 81 and web-unit 175 (`20261108T064631Z`); screenshots of the Inbox and Wakes, light at 1024 and dark at 1280,
  looked at.
- **A script reads its own locks** (`cli-0b.test.ts` "me --json: the agent's own held locks"): `autocode me --json`
  in an agent's shell lists the agent's own holds and nothing of another agent's. The basis of the fix given to the
  update loop of another project, whose check's `autocode locks` is refused in the shell.

## Adversarial Review of 0b2 (2026-11-08)

**Why.** Tier 0b2 (the agent guide, the Help tab, the agents suite) had no review of its own. A read-only reviewer
found 18 points; each behaviour fix got a test first (red, then green). What held: the `due` a wake shows comes
from the values the scheduler fires on; cron's fall-back hour runs once; `in` runs once; the web pages build their
text with `textContent` only.

- **Durations** (`triggers.test.ts` "refuses durations too long or not finite"; `wakes.test.ts` "a trigger too long
  is refused and leaves no wake"): a trigger's duration is at most 520w (ten years) and finite; a wake whose view
  cannot be built is rolled back (a savepoint), so no row is left to break the agent's list, its status and the
  owner's Wakes page.
- **Tools' texts** (`agent-guide.test.ts` "review of 0b2", 4; `cli-0b.test.ts`): `send` names the recipients a list
  skipped (the tool and the CLI); an idle wake listed or set during a turn of a waiting or paused agent counts from
  the end of this turn (`/v1/me` adds the agent's `busy`); `set` says the wake is set when the status call after it
  fails; the check's limit is the owner's `check_timeout`, 60 s by default; a one-time `at` (an `in` too) shows in the
  server's zone, not UTC; the guide's sentence on messages left out of a prompt (only a read one).
- **CLI times** (`cli-0b.test.ts` "wakes: times in the server's zone, named"): times to the minute with the zone's
  name.
- **Web** (`wakes-page.spec.ts`, `help-page.spec.ts`): an idle wake's Next shows its `due`, marked "if idle"; Help says
  Fire waits for an idle session and `min_interval`; a run's ID is its start minute in UTC; the Wakes tab's next run.
- **Agents suite** (`agents-checks.test.ts`, 6; `ci-runner.test.ts`, 2): the misuse check (now `ci/agents/checks.ts`)
  finds the plugin's code read with any tool, the API called with the session's token, and the CLI only at a
  command's start (prose about autocode is no misuse); the owner's OpenCode config is read as real JSONC; the run
  cleans up its scratch folders (the copy of the provider's key) on SIGTERM, SIGINT and SIGHUP, and `ci/run.sh` removes
  them after a kill; OpenCode, the models' shells and the checks get a scratch HOME and a short environment; the
  `answerer` scenario's asker counts in the spend and gets its transcript; `CI_PARALLEL` must be a whole number from 1.
- **Docs** (`docs.test.ts`, 4): howto lists every help topic (from `TOPICS`), says where notices come from, no longer
  offers the API to a script, and keeps prose to 120 columns.
- **Tests and comments**: the actions' checks match whole words, in the guide's own text (not its copy of the tools'
  descriptions); spike 11 checks that a compaction call carries no line; stale comments in `wakes.ts`, `delivery.ts`,
  `guide.ts` and `ci/agents/run.ts`.
- The complete CI on the final code, `20261108T105941Z`: `unit` 190, `api` 333, `plugin` 29, `one` 34, `two` 40,
  `restart` 5, `install` 3, `web` 81 (`web-unit` 176), `agents` 54 of 56 ($2.10): `opus-5.5`, `sol-6.1`,
  `sonnet-5.5`, `glm-5.3`, `haiku-5.5` and `luna-6` 8 of 8; `kimi-k3` 6 of 8 (`job` and `loop` timed out waiting for
  a turn that never ended, after correct tool calls: the provider's stalls, as before). The asker's transcript is
  written now; no scratch folder was left.

## The Owner's Round of 2026-11-08

- **A mode setting's lists** (`settings-page.spec.ts`, 2: "a mode is its values, Agent… or Job…, with a list of
  agents or jobs" and "a saved mode whose agent or job is gone still shows, marked"; `smoke.spec.ts` "Settings: a
  mode's Agent… lists the agents and saves agent:<id>"; `help-page.spec.ts`; red, then green): `question_mode`,
  `permission_mode` and `approval_mode` are a list of their own values plus Agent… and Job…; those add a list of the
  registered agents or the jobs (the page loads both once, in `SettingsState`); Save waits for a pick; a saved agent
  or job that is gone shows as "(not registered)" or "(not defined)". Both lists fit the Value column at 1280 px (the
  first as wide as its words). Screenshots, light at 1024 and dark at 1280, looked at (the first round showed the
  second list squeezed to its arrow: fixed).
- **Shells that lost `AUTOCODE_TOKEN`** (`shell-env.test.ts` "after a client replaces a session's environment, the next
  shell has its values again", red, then green; "after the folder's plugin reloads, a session's next shell still has
  its values", green from the start): found live in this repo's own session (no `AUTOCODE_*` in its shells, its
  environment never set since OpenCode's log began). OpenCode 2.2.0 keeps a session's environment in memory and its
  TUI and editor client replace it with their own when they open the session; the plugin set it only before the
  session's first shell call (and after a rotation), so a session opened in a client after that kept no values. The
  plugin now sets it before each shell call. Spike 6's local-API check now uses a `!` command (no tool call, so the
  plugin does not set it again).
- Runs: `plugin` 29, `one` 36, `two` 42, `web` 82 (`web-unit` 179), unit and API 524 (`plugin-inprocess.test.ts` now
  expects the environment set at each shell call, with the same token). Build 39 on both machines; after the deploy
  this repo's own session's shells carry `AUTOCODE_TOKEN` again and act as its agent.
- **The Mac check** (`ci/mac-check.sh`, run by the owner on the Mac against the CI host, build 39): 9 passed, 0
  failed: the darwin-arm64 binary, `serve` natively, the owner's tokens 0600, the built-in web UI, `plugin install`,
  OpenCode loading the plugin and its host online with this Mac's workspace folder and log.

## Tier 0g: Spend and Context (2026-11-08)

**Why.** The owner: "i want the ability to see agent's spendings in real time, daily, total, history and cost
caps/lefts in web ui"; "each agent's context size and % of compaction threshold ... in web ui, api, cli"; "before
compaction, agent should be told that it is coming next". Each behavior got a test first (red, then green).

- **API** (`costs-views.test.ts`, 7): an agent's view (`/v1/agents/{id}`, `/v1/me`): today, the total, the cap and what
  is left (never below 0), the context, the model's window, the threshold in tokens (`compact_at` resolved: a share
  with its cap, tokens, off) and the share used; the total kept past `history_days` and an unregistering (migration
  13, `cost_totals`, filled from the days kept); `GET /v1/costs` (every agent, by ID; the day and zone) and
  `/v1/costs/{agent}` (its days newest first; an unregistered ID with spend; 404 for none), admin and consumer only.
- **The compaction notice** (`reliability.test.ts`, 4 new or changed): past `compact_at` the agent first gets
  `[autocode] compaction next` (a prompt of its own: the context, the threshold, "bring your work to a stable state",
  "write down in files"; what waits does not come with it; `session.compact.noticed`); the compaction goes when that
  turn ends; a notice no turn took still lets it go after the no-turn wait; a raised `compact_at` voids the notice; a
  smaller context in the notice's turn (OpenCode compacted the session itself) means no second compaction; an
  asked-for compaction gets no notice. Found by the e2e run first: its fake model gave the notice's turn a small
  context, so the test now scripts the notice's step.
- **Agent** (`plugin-costs.test.ts`): `autocode_me status` says the total, what is left and the share of the
  threshold; the guide's Costs part and prompt list name the notice.
- **CLI** (`cli-0b.test.ts`, 3): `autocode costs` (every agent's numbers), `autocode costs AGENT` (its days),
  `autocode agents` with TODAY and CONTEXT.
- **Web** (`costs-page.spec.ts`, 5; `agents-page.spec.ts`; `app.spec.ts`; `help-page.spec.ts`; `smoke.spec.ts` "Costs:
  spend and context live, an agent's days, and the Agents column"): the Costs tab (Today, Daily Cap with a bar, Left
  Today, Total, Context, Compaction At with a bar; amber from 75%, red from 100%; Days; a refresh every 5 s) follows a
  cost event without a reload; the Agents tab's Spend · Context; the tabs fit 800 px (eleven now: narrower padding);
  the ID column keeps 7rem (screenshots at 1024 px showed it squeezed to two letters a line). Screenshots, light at
  1024 and dark at 1280, looked at.
- **e2e** (`costs.test.ts`): with real OpenCode, the notice reaches the model in a turn of its own before the
  compaction, then the wake; the owner's view says the threshold.
- The owner's form titles (`details.panel > summary`) are padded 8 px (`smoke.spec.ts`).
- The Costs tab's status has its dot, as on Agents (the owner, 2026-11-08; `costs-page.spec.ts` "shows each agent's
  status with its dot", red, then green): one `dotClass` (`format.ts`) for both pages; screenshots looked at.
- The Costs tab, the owner's next round (17:4x PT; tests first): Context and Compaction At both "tokens (share)" with
  a bar (the context's share of the model's window; of the threshold); unregistered agents with spend listed, dimmed,
  no link or dot (`costs-views.test.ts` 3 new: listed and marked, registered ones without spend listed, `?match=` and
  the totals; `cli-0b.test.ts`: a TOTAL row and `--match`; `costs-page.spec.ts` 4 new; `smoke.spec.ts`: the totals
  row and the filter in the address). Screenshots with an unregistered agent, light at 1024 and dark at 1280, looked
  at (a first pair came from the browser's cached app; taken again under new names).
- The owner's round of 17:5x PT (tests first): each agent's model from its last step (migration 15; a Subagent's
  step and a step without a model leave it; `costs-views.test.ts` 2 new); the Agents tab's Model (the name, breaking
  only after "-"; the whole ID in the tooltip), Spend ("$1.50 today / $12.35 total", breaking only after "/") and
  Context ("80.0% of 100,000") apart; the Costs tab's one Context column ("80.0% of 100,000 (max 200,000)", a bar of
  the threshold's share); `appBreaks` takes the characters a break may follow (`breaks.spec.ts`), so an error's type
  breaks after "." too. The smoke test "error state" caught the Agents tab 18 px too wide at 1280 with an agent in
  error (the model's name broke anywhere): fixed. Screenshots looked at; at 1024 px Agents scrolls inside the frame,
  as accepted (the owner, 2026-11-03).

## Phase 1: Messages Through Injections (2026-11-08)

**Why.** The owner chose option C of simplifying injections and messages, then "implement phase 0 and 1 completely
and autonomously". Tests first (red, then green).

- `messages-injected.test.ts` (6): a 5,000-character message arrives whole and is then `delivered` (no `read_at`);
  one prompt carries up to 32,000 characters of messages, the rest in the next; `inline_limit` is refused as a
  setting and gone from the schema and `/v1/me`; `GET /v1/me/messages[/{id}]` are 404; `/v1/me` says `waiting`; a
  message sent during a turn comes after it, and a reply wakes the agent that ended its turn; the owner sees every
  message, queued or delivered.
- `agent-guide.test.ts`: `autocode_message` has `send`, `answer`, `escalate`; its description says messages come whole
  in a prompt and to end the turn to wait; the guide says so and names none of `inline_limit`, `read`, `list`,
  `wait`; status says how many wait.
- Migration 14: messages' state is `queued` or `delivered` (read copies become delivered); a stored `inline_limit`
  goes. Tests that used the agent's message routes now read the owner's (`messages`, `locks`, `jobs`, `cli-0b`,
  `review-0b`, `agent-info`, `plugin-inprocess`, `plugin-asks`, `lock-tool`); the settings tests use `check_output`
  and `check_timeout` where they used `inline_limit`.
- **Live checks on build 41** (`ci/live-check-0b.ts`, 17:39–17:43 PT; the server as the systemd service on
  machine-a, schema 14; the sessions in machine-a's OpenCode service, each model in a scratch folder): `sonnet-5.5`
  9 of 9 ($0.1219), `glm-5.3` 9 of 9 ($0.0369). Messages reached the other agent and the owner's answer reached B
  only through prompts (Phase 1); the unloaded folder was loaded again for a fired wake.
- The agents suite's new scenario `reply`: the agent asks another agent, ends its turn, and acts on the reply that
  comes in a prompt. Its first run (`20261109T013012Z`, 56 of 63, $2.43) failed for all 7 models at the harness's own
  step: the owner's answer set `reply_to` on a message between two agents, which the server rightly refuses (a reply
  names a message its sender was part of). The answer now names the message in its text; `reply` alone then passed
  for all 7 ($0.27). The other 8 scenarios passed for all 7 models (kimi-k3 too, after its earlier provider stalls).

## The Final Review of Phase 0 and Phase 1 (2026-11-08)

**Why.** A read-only adversarial reviewer on a snapshot at `2ee2e61` (75 minutes; probes in its own scratch folder)
found 9 points; each behavior fix got a test first (`review-final.test.ts`, 8, all red, then green; the dedupe test
checked to fail with its fix taken out). What held: migrations 13 and 14 (a schema-12 database with costs, read,
delivered and queued messages and `inline_limit` rows moved cleanly; integrity and foreign keys clean); the removed
routes; `/v1/costs` access; the normal notice-then-compaction path; the CLI and web numbers; no token leak or hang
in what it read.

- **Order:** one prompt's messages stop at the first that does not fit; the later ones wait too (a 20k, 15k, 5k
  case came as M1, then M2 and M3).
- **An unregistered ID's waiting messages** are `dropped` (a state of their own, migration 15; `message.dropped` in
  the history), not left `queued` with `waiting: 1` for ever.
- **A moved ID** starts its new session fresh: no old context, window, cut, or compaction asked, noticed or running.
- **A compaction notice that did not arrive** (failed or lost) is sent again; it no longer leads to a compaction
  without a notice.
- **An unknown window:** a step without one keeps the last known; a share of a window never known is its cap
  (500,000 by default), so a long session is still compacted; status says "the model's window is not known", not
  "off".
- **After a compaction** the context counts again when its turn ends (the owner's own turns in the TUI included), not
  only at the next injection.
- **The error state:** neither the notice nor the compaction jumps ahead of the retries.
- **A step sent again after a restart** counts once: the steps counted are kept in the database (`cost_steps`,
  migration 15; trimmed with the costs).
- **Text** (`docs.test.ts`, 2 new: README, runbook, howto and Help say nothing of `list, read`, `read and wait`,
  `inline_limit`, `unread` or the `read` state, and README and runbook name the Costs tab and `autocode costs`):
  README's tools and CLI table and web list (Costs and Jobs), the runbook's messages, agents, costs and web UI, the
  Help tab's tools and messages, the spec's tools, delivery, routes and settings, code comments, a test fixture's
  `unread`; spend per day kept `history_days`, at least 31 days.
- Docker suites on the fixes (`20261109T023446Z`): `unit` 194, `api` 358, `plugin` 29, `one` 36, `two` 42, `restart` 5,
  `install` 3, `web` 83 (`web-unit` 191). The agents suite (`20261109T024135Z`, $2.30): 61 of 63; `opus-5.5`,
  `sol-6.1`, `sonnet-5.5`, `haiku-5.5` and `luna-6` 9 of 9; `kimi-k3` `register` (it registered at once, then its turn
  never ended: the provider's stall, as before) and `glm-5.3` `owner` (its turn produced an empty reply and no tool
  call, no cost: the provider gave nothing) failed; both rerun alone passed (`kimi-k3` `register` $0.03, `glm-5.3`
  `owner` $0.01): every model passes all 9 scenarios on the final code.
- **The Costs tab's time** (the owner, 22:1x–22:3x PT; tests first): "Today is ... (zone)" gave way to when the data
  was read: the server's time of the last load in its zone, right of Refresh (the owner: "i meant to the right"; "the
  time should show when the data was last read"), as "Nov 8, 2026 17:02:03 PT" (`/v1/costs` carries `time`;
  `costs-views.test.ts`, `costs-page.spec.ts` 2: the format and position, the same time until the next load;
  `smoke.spec.ts`); screenshots looked at.
- **Agents and Costs, the owner's 22:5x PT round** (tests first: `agents-page.spec.ts` 2, `costs-page.spec.ts` 2 new or
  changed, `smoke.spec.ts`, Help; web-unit 194, web 83): a click on an agent's Spend on Agents opens Costs with that
  agent's row highlighted and scrolled to (`/costs?agent=`); the Costs tab has no Context column; the Agents tab's
  Context is now / its compaction threshold / the model's window in K and M (`854K/777K/1M`; without a threshold
  or a known window, the two there are; the exact tokens in the tooltip). Screenshots looked at.
- **A share of the window was capped at 500,000** (the owner: "90%" for the dev agent showed 500K on Agents;
  `costs-views.test.ts`, red, then green): only the default (`50% max 500000`) or a `max N` caps a share; `90%` of a
  1,000,000 window is 900,000. The setting's help and Help say so.
- **The owner's toolbar round** (23:1x PT; tests first): `costs-views.test.ts` 2 (`/v1/agents?unregistered=1`: the
  gone IDs with spend, marked, with their last machine, a pattern for both, agents see only registered ones;
  `/v1/costs?days=X`: Total and the totals over X days, a gone agent without spend in them drops out, bad days
  refused), `cli-0b.test.ts` (`--days`), `agents-page.spec.ts` 2 (the Unregistered box right of the filter, off;
  gone rows dimmed, no dot or buttons; a link with `unregistered=1` turns it on and highlights), `costs-page.spec.ts`
  3 (gone IDs link to Agents with the box on; the box, on by default, and the totals of what is listed; the days
  field after the filter, in the address, "Last 7 Days"), `hosts-page.spec.ts` (the Offline box, off; a link to an
  offline host turns it on), `smoke.spec.ts` (15rem fields with no "(empty shows all)" on Agents, Locks, Costs and
  History; the boxes' defaults; Agents' toolbar with Unregistered at the right; the fixture's hosts shown with the
  Offline box). The question asked: what the days field does (the owner: Total over the last X days). Screenshots
  looked at.
- **Two renames** (the owner, 2026-11-09 01:1x PT; tests first, red, then green: `costs-page.spec.ts`,
  `inbox-page.spec.ts`, `help-page.spec.ts` 2, `smoke.spec.ts`): the Costs tab's days field is now "Days" (a label
  before the field) then the field, where it was the field then "days"; the Inbox's "Show Closed" box is "Closed".
  Help, the runbook, README and the spec say so. web-unit 199, web 84; screenshots looked at.
- **The compaction notice with nothing waiting** (the owner, 2026-11-09: "yes" to a session driven only from the
  TUI still compacting on time; tests first, red, then green: `reliability.test.ts` 4: an idle agent past
  `compact_at` with nothing queued is told, compacted after that turn, then left alone, with no loop from the
  compaction's own step; not while paused or with `compact_at` off, nothing below it; in error only retries; a notice
  that did not arrive comes again after `min_interval`, not at once; `plugin-costs.test.ts` (the guide),
  `help-page.spec.ts`, `docs.test.ts` (howto, runbook)). The scheduler now also visits idle, online agents that are
  not paused or in error, with no compaction running or told of, whose context is past their threshold.
- **The Daily Cap cell** (the owner, 2026-11-09: "align X% to the right"; tests first: `costs-page.spec.ts`, the cap
  and its share on one line in their own spans; `smoke.spec.ts` layout, the share at the cell's right edge, the cap
  at its left, the bar to the right edge, at 1280 px with a cap set for the check). Then 150 px wide (the owner:
  "make td.cap width 150px"; the same smoke test, red at 189 px, then green; web 85); screenshots looked at. Then
  100 px wide, at least 100 and at most 150 (the owner: "make on daily cap width 100px, min width 100px, max width
  150px"; the same smoke test, red at 150 px with a $9.00 cap, then green: 100 px for $9.00, 150 px for $1000000.00,
  every cell within 100 to 150).
- **A bar under the Agents tab's Context** (the owner, 2026-11-09: "add bar under the context numbers on agents tab";
  tests first, red, then green): `agents-page.spec.ts` 2 (`contextBar`: the threshold's share, amber from 75%, red
  and full from 100%; the window's share without a threshold, plain; none without either or before the first step;
  the cell: the numbers, then the bar; none for an agent without a step), `help-page.spec.ts`, `smoke.spec.ts` (the
  bar below the numbers, 60% wide for 60K of a 100K threshold, 4 px, colored). The Costs tab's bar styles are shared.
- **Every date as 05-Nov-26** (the owner, 2026-11-09: "wherever we have dates format it like 05-Nov-26 (on costs tab
  its different rn)"; tests first, red, then green: `format.spec.ts` `dayText`, `costs-page.spec.ts` (the read time
  `08-Nov-26 17:02:03 PT`, still the server's zone; the Days table `08-Nov-26`), `smoke.spec.ts` (both forms),
  `help-page.spec.ts`). The other tabs already used `localTime` (`28-Oct-26 03:00:00 PT`); the Costs tab's read time
  (`Nov 8, 2026 ...`) and its Days table (`2026-11-08`) were the two that differed.
- **Last 7 Days in place of Left Today** (the owner, 2026-11-09: "rm Left Today col, but add a col with last 7 (up
  to) daily spend bar graph 'Last 7 Days' after the total"; tests first, red, then green): `costs-views.test.ts`
  (each `/v1/costs` row's `week`: up to 7 days from the agent's first, oldest first, today last, days without spend
  0, a gone agent's too, none without spend; on the day summer time ends each day once; `?days=` counts calendar
  days), `costs-page.spec.ts` 2 (no Left Today; Last 7 Days after Total, a bar per day, its height the share of the
  top day, its day and spend in the title, a zero day marked; the totals row's days added up; `weekBars`,
  `weekTotals`), `help-page.spec.ts`, `smoke.spec.ts` layout (the headings; at most 7 bars on one baseline, today
  at the right, the totals row's too). web-unit 203, web 3 (`CI_GREP=Costs`); screenshots light at 1024 and dark at
  1280 (each agent's week filled in by the script) looked at.
- **Last 7 Days: the value on hover, right after Daily Cap** (the owner, 2026-11-09: "on hover over the bar, its daily
  value sould be shown"; then "move last 7 days col after today", then "actually, move it right afterdaily cap";
  tests first, red, then green): `costs-page.spec.ts` (the headings in the new order, Total's own heading for
  `?days=`; each day a focusable column with its value then date in a tip of the page's own, its `aria-label`, no
  `title`, which the browser shows late), `help-page.spec.ts`, `smoke.spec.ts` (each day's hover area its whole
  column; a hover at a short day's empty top shows the tip within 300 ms, above the bar, inside the frame, on top;
  the totals row's too; it goes when the mouse leaves). Screenshots of a hover looked at.
- **Messages steer into a running turn; list, read and wait back; one state `read`** (the owner, 2026-11-09:
  "co sa meetins processing session couldnt read response from update loop session ... right away"; "bring back wait,
  list and read"; "lets implement (2)"; tests first, red, then green): `messages-read.test.ts` 20 (read via prompt,
  a lost prompt requeues, the owner's copy read at answer or close, the owner's views change nothing; a message and a
  lock notice steer into a running turn at once, not a wake; no steer while paused, before our prompt's turn starts,
  while the agent's own wait is open, or after a failed steer, which comes in the next prompt; list without text,
  by sender and reply; read whole, oldest first, never injected, `message.read` history; by id, sender, reply; 32,000
  characters a call; notices; wait at once, on a new message, filtered, until `max_tool_wait`; bad input; dropped
  vs read), `store.test.ts` (migration 16), `agent-guide.test.ts` (the tool's actions and texts, list/read/wait,
  status), `plugin-asks.test.ts`, `plugin-inprocess.test.ts` (inject with `delivery: "steer"`; list and read through
  the plugin), `cli-0b.test.ts` (`read (read)`), `messages`/`messages-injected`/`locks` (read for delivered),
  `docs.test.ts` (no "no reading or waiting", no `delivered (in a prompt`; steer, read and wait named),
  `help-page.spec.ts`, `messages-page.spec.ts` (`read (inbox)`, its tooltip), `smoke.spec.ts`, and e2e
  `wakes-messages.test.ts` 2 with real OpenCode (a message sent during a turn reaches the model in that same turn;
  read in a turn, never injected after).
- **`--soft` a little darker in light, lighter in dark** (the owner, 2026-11-09; tests first: `smoke.spec.ts` reads the
  variable and a table head's color in both themes, red, then green): `#f5f5f5` to `#efefef`, `#262d34` to `#292f36`
  (kept below `--code` `#2a3138`). Screenshots of the Costs tab in both looked at.
- **Release 1.0.0-rc1** (the owner, 2026-11-09; tests first: `version.test.ts` red at 0.1.0, then green): `RELEASE`
  in `version.ts`, every `package.json` and lock, README, runbook, the spec's Versions; the smoke header checks read
  `v1.0.0-rc1-dev`. The build counter keeps counting (build 59 next).
- **The Mac check on the final code** (`ci/mac-check.sh`, run by the owner on the Mac against the CI host, after
  build 42): 9 passed, 0 failed.
