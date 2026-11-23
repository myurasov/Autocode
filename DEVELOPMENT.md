# Developing Autocode <!-- omit in toc -->

This file is for people who build Autocode from source, run its tests or change it. To install and use Autocode, see
[`README.md`](README.md) and [`reference.md`](reference.md).

- [What You Need](#what-you-need)
- [Build](#build)
- [Versions and the Build Number](#versions-and-the-build-number)
- [Run From Source](#run-from-source)
- [Tests](#tests)
- [The Scripts in ci/](#the-scripts-in-ci)
- [Layout](#layout)
- [Code Style](#code-style)

## What You Need

| Tool | For what |
|---|---|
| Linux, ARM64 or x86-64 | the full build and the test suites |
| git | getting the source |
| [Bun](https://bun.sh) | everything: Autocode is one TypeScript codebase on Bun. The build image uses Bun 1.4.3 |
| Docker, with Compose | building the web UI, and the test suites that run in containers |
| `flock` and `timeout` | used by the scripts in `ci/`. Every common Linux has them |

A Mac can cross-check the macOS binary with `ci/mac-check.sh`. The full build and the suites need Linux.

## Build

```sh
git clone https://github.com/myurasov/Autocode
cd Autocode
ci/dist.sh
```

The result is `dist/autocode`: one binary with the server, the CLI, the plugin and the web UI inside, for the CPU of
the machine that built it. The last line says which build it is, like `build 1: v1.1.0-rc6-build1`.

`ci/dist.sh` does five things:

1. Installs the packages: `bun install --frozen-lockfile`.
2. Builds the web UI in Docker, with `ci/images/web/Dockerfile`. The image runs the web UI's unit tests first; a
   failing test stops the build.
3. Copies the built web UI to `web/dist/`.
4. Takes the next build number (see [Versions and the Build Number](#versions-and-the-build-number)).
5. Compiles the binary with `bun cli/build.ts`, and checks that it reports that build's version.

Binaries for other machines:

| Command | Builds |
|---|---|
| `ci/dist.sh` | `dist/autocode`, for this machine |
| `AUTOCODE_TARGETS=all ci/dist.sh` | also `dist/autocode-linux-arm64`, `dist/autocode-linux-x64` and `dist/autocode-darwin-arm64` |
| `AUTOCODE_TARGETS=darwin-arm64 ci/dist.sh` | also only the one named; a comma list names several |

**Without Docker** you can still compile a binary:

```sh
bun install
bun cli/build.ts
```

It has no web UI inside, unless `web/dist/web/browser` exists from an earlier build. The server, the CLI and the
plugin work. Its version ends in `-dev`.

## Versions and the Build Number

A version has two parts: the release and the build.

- **The release** is `RELEASE` in `shared/src/version.ts`, and `version` in `package.json`.
- **A numbered build** says `v<release>-build<n>`, like `v1.1.0-rc6-build57`. Only `ci/dist.sh` makes numbered builds.
- **Any other build** says `v<release>-dev`: `bun cli/build.ts` by hand, and the binaries that the test suites
  build.

`autocode version` prints a binary's version, and `autocode info` the server's.

**The build number** is a counter in a file on the machine that builds: `~/.autocode-dev/build-number`.

- `ci/dist.sh` adds one to it for each build, through `ci/build-number.sh`. A lock beside the file keeps two builds
  from getting the same number.
- The file is not in the repository. On a fresh clone, on a machine that has never built Autocode, there is no
  file: the first build is number 1, and the file is made then.
- The number tells apart the builds of one machine. It keeps counting across releases.
- `AUTOCODE_BUILD_FILE` names another file. To continue the numbering of another machine, write its last number
  into the file.

## Run From Source

```sh
bun install
bun cli/build.ts --generate
bun cli/src/main.ts serve --listen 127.0.0.1:4848 --data /tmp/autocode-dev
```

- `bun cli/build.ts --generate` writes `cli/src/generated/`: the plugin bundle and the list of web UI files that
  the CLI's source imports. Run it once after a clone, and again after a change to the plugin.
- `--data` keeps the development data out of `~/.autocode/`, where a real install lives. Never point a development
  server at a real install's folder.
- `--web-dir web/dist/web/browser` serves a web UI build from that folder, instead of one inside the binary.
- `--poll-wait S` and `--offline-after S` shorten the plugin's request for work and the time after which a silent
  host counts as offline. Tests use them.

## Tests

The fast checks need no Docker:

```sh
bun install
bun run typecheck
bun run lint
bun test tests/unit tests/api
```

- `bun run typecheck` generates `cli/src/generated/`, then runs the TypeScript compiler.
- `bun run lint` runs Biome.

The suites that need containers run through `ci/run.sh`:

```sh
ci/run.sh unit api plugin one two restart power install web
```

Name the suites you want. **`ci/run.sh` without a name runs all of them, and that includes `agents`, which calls
real models and costs about $1 a run.** No other suite spends money: in them, real OpenCode runs against a scripted
fake model server, `ci/fake-model/`.

| Suite | Tests in | What it checks |
|---|---|---|
| `unit` | `tests/unit` | type checks, lint, and pure logic: IDs, patterns, durations, settings, the store, parts of the plugin, the docs |
| `api` | `tests/api` | every route of the server in one process, with a fake clock; the plugin's connection; the CLI as a process |
| `plugin` | `tests/plugin` | the plugin inside real OpenCode |
| `one` | `tests/e2e` | end to end, with one OpenCode machine |
| `two` | `tests/e2e` | the same across two machines, plus a lost machine, a returning one and a network cut |
| `restart` | `tests/restart` | the server restarted on its data; an OpenCode machine restarted |
| `power` | `tests/power` | a machine that runs both the server and OpenCode loses power and boots again: real systemd, the installed service, OpenCode's background service |
| `install` | `tests/install` | `autocode install` and `uninstall` as a systemd user service, and a reboot |
| `web` | `tests/web`, `web/src` | the web UI's unit tests, and browser checks against a real server |
| `agents` | `ci/agents` | real models must use Autocode correctly from plain requests. It runs on the machine itself, not in Docker, with your own OpenCode provider settings, apart from your sessions. The models are listed in `ci/agents/models.json` |

How `ci/run.sh` runs them:

- Each suite is its own Compose project, on its own network, removed when it ends.
- Suites run side by side, four at a time.
- Output goes to `__out/ci/<run>/<suite>/`: the test output of every suite, and the service logs and the server's
  database of a failed one. The output of the web UI's unit tests is in `__out/ci/<run>/web-image.log`.

| Variable | Meaning | Default |
|---|---|---|
| `OPENCODE_VERSION` | the OpenCode version the suites run against | `2.3.0` |
| `CI_PARALLEL` | how many suites run at a time | `4` |
| `CI_GREP` | the `web` suite: only the browser tests whose names match | all |
| `CI_KEEP=1` | leave the Compose projects up after the run, for debugging | removed |
| `AUTOCODE_TARGETS` | extra binaries to build, as for `ci/dist.sh` | none |
| `AGENT_MODELS`, `AGENT_SCENARIOS` | the `agents` suite: comma lists of the models and scenarios to run | all |

`tests/unit/docs.test.ts` checks the documentation against the code: the help topics, pinned wording, and the
120-column limit of prose lines.

## The Scripts in ci/

| Script | Does |
|---|---|
| `ci/dist.sh` | a numbered build with the web UI (see [Build](#build)) |
| `ci/build-number.sh FILE` | adds one to the number in `FILE` and prints it |
| `ci/run.sh [SUITE...]` | runs the test suites (see [Tests](#tests)) |
| `ci/dev.sh` | copies the source to a second machine, or to a scratch folder on this one, and runs commands there |
| `ci/mac-check.sh [BINARY]` | on a Mac: checks the macOS binary, its paths, and `autocode plugin install` into a throwaway config. Everything runs under `__out/mac/` |
| `ci/live-server.sh start\|stop\|restart\|status` | runs the server of an install in tmux instead of systemd |
| `ci/live-check.ts`, `ci/live-check-0b.ts` | manual checks with real models against a running server. They are not part of any suite; each file's header says how to run it |

**`ci/dev.sh`** is for working on one machine while building and testing on another:

```sh
AUTOCODE_CI_HOST=machine-b ci/dev.sh run 'bun test tests/unit'
```

- `AUTOCODE_CI_HOST` is an ssh host, or `local` for a scratch copy on this machine.
- The copy lives in `~/.autocode-dev/ci` there. `AUTOCODE_CI_DIR` names another folder; `AUTOCODE_CI_SSH` another
  ssh command.
- Its commands: `sync` copies the source; `run 'COMMAND'` copies, then runs the command in the copy; `lock` runs
  `bun install` there and brings `bun.lock` back; `fmt` formats with Biome there and brings the changed files back;
  `pull-out` brings back `__out/ci/`, the output of test runs.

**`ci/live-server.sh`** uses `~/.autocode/bin/autocode` and the data in `~/.autocode/`, or the folder that
`AUTOCODE_HOME` names. Its log is `logs/serve.log` in that folder. `LIVE_LISTEN` sets the address
(`127.0.0.1:4848`), `LIVE_ID` the server ID (the host name).

**`~/.autocode-dev/`** is where the scripts keep their own files: the build counter, and the scratch copy of
`ci/dev.sh`. A real install lives in `~/.autocode/`. The build and the test suites never write there.

## Layout

| Path | What |
|---|---|
| `shared/` | IDs, patterns, durations, triggers, settings, the version |
| `server/` | the server: the database, the scheduler, delivery, asks, locks, jobs, costs, the API |
| `plugin/` | the OpenCode plugin and the agents' tools |
| `cli/` | the `autocode` command: the CLI, `serve`, `install`, `plugin install`, and the build of the binary |
| `web/` | the web UI, in Angular. It has its own `package.json` and is built with npm, in Docker |
| `tests/` | the tests: `unit`, `api`, `plugin`, `e2e`, `restart`, `install`, `web`, and `helpers` |
| `ci/` | the build and test scripts, the Compose files, the images, the fake model server, the `agents` suite |
| `autocode.consumer.agent.md` | the agents' guide. The plugin embeds it as the `autocode` skill and as `autocode_me action=help` |
| `autocode.admin.agent.md` | for an agent that works on this repository, or installs Autocode |
| `README.md`, `reference.md` | the documentation for people |

Kept out of git: `node_modules/`, `dist/`, `cli/src/generated/`, and every folder whose name starts with `__`, such
as `__out/`.

## Code Style

- **Formatting and lint:** Biome. `bun run lint` checks.
- **Line length:** code lines within 80 columns; prose lines of Markdown within 120.
- **Header comment:** every file starts with a comment that says what the file does.
- **Tests first:** write a failing test, then the code that makes it pass. A bug fix starts with a test that shows
  the bug.
- **Documentation with the change:** a change updates, in the same commit, what describes it: `reference.md`,
  `README.md`, the agents' guide, the Help page (`web/src/app/help/help-page.html`), the usage text of the CLI
  (`cli/src/main.ts`) and the tools' descriptions (`plugin/src/tools.ts`).
- **Headings** in documents and labels in the web UI are in Title Case.
