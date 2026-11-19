#!/usr/bin/env bun
/*
 * The `autocode` command, one binary for the server (`autocode serve`) and the
 * owner's CLI: reads the command line, runs the command, and turns errors into
 * exit codes (1 refused or failed, 2 wrong usage, 3 the server cannot be
 * reached).
 */
import { join } from "node:path"
import { startServer } from "@autocode/server"
import {
  ApiError,
  AutocodeError,
  shownVersion,
  Unreachable,
  VERSION,
} from "@autocode/shared"
import { CliError, type Parsed, parseArgs } from "./args.ts"
import {
  agents,
  costs,
  history,
  hosts,
  info,
  settings,
  token,
} from "./commands.ts"
import { autocodeHome, inAgentShell } from "./connect.ts"
import webFiles from "./generated/web.ts"
import { install, uninstall } from "./install.ts"
import { pluginInstall, pluginUninstall } from "./plugin.ts"
import {
  answer,
  fire,
  inbox,
  job,
  locks,
  me,
  messages,
  pause,
  resumeAll,
  retry,
  send,
  stopAll,
  wake,
  wakes,
} from "./tier0b.ts"

const USAGE = `usage: autocode <command> [flags]

Set Up
  serve [--id ID] [--listen ADDRESSES] [--data DIR]
                             run the server in the foreground
  install [--id ID] [--listen ADDRESSES] [--data DIR]
                             install the server as a systemd user service
                             and start it (Linux); the binary goes to
                             ~/.autocode/bin/autocode
  uninstall                  remove the service; the binary and data stay
  plugin install --url URL --consumer-token-file FILE
      [--admin-token-file FILE] [--server-id ID] [--opencode-config-dir DIR]
                             connect this machine's OpenCode: the plugin,
                             the client config, and the binary copied to
                             ~/.autocode/bin/autocode. --admin-token-file
                             is for the owner's commands on a machine other
                             than the server's. --consumer-token TOKEN and
                             --admin-token TOKEN take a token itself.
  plugin uninstall [--opencode-config-dir DIR]
                             remove the plugin; the client config stays
  version                    this binary's version (also --version, -v)
  help                       this text (also --help, -h)

Look
  info                       the server's ID and version
  hosts                      the OpenCode folders that have connected:
                             online or not, OpenCode's and the plugin's
                             version
  agents [PATTERN]           agents: status, spend today, context
  costs [--match PATTERN] [--days N]
                             every agent's spend, daily cap and context;
                             --days N: the total over the last N days
  costs AGENT                one agent's spend, with its spend per day

Agents
  agents register AGENT --session SESSION [--description TEXT] [--force]
                             give a session an agent ID; --force takes the
                             ID from a session that still exists
  agents rm AGENT            unregister an agent; its history stays
  pause AGENT                send it no new prompts; a running turn goes on
  resume AGENT               resume a paused agent
  retry AGENT                retry an agent in the error state now
  stop-all                   pause every agent and interrupt their turns,
                             and their Subagents
  resume-all                 resume the agents that stop-all paused

Wakes
  wakes [AGENT]              every wake, or one agent's
  wake set AGENT NAME --trigger TRIGGER --text TEXT [--check COMMAND]
                             set or replace a wake
  wake cancel AGENT NAME     remove a wake
  fire AGENT WAKE [--text TEXT]
                             deliver a wake now

Messages and Inbox
  send TO TEXT... [--subject SUBJECT] [--reply-to ID]
                             send a message as the owner; TO: an agent ID,
                             a pattern or a comma list
  messages [--from PATTERN] [--to PATTERN]
                             the newest 200 messages, with their state
  messages read ID           one message, whole
  inbox [--all] [--match PATTERN]
                             the open Inbox items; --all: closed ones too;
                             --match: only those of matching agents
  answer ID TEXT...          answer a message, a question, a permission
                             (once, always, reject) or an approval
  inbox close ID             close a message or an alert; an ask (ask_...)
                             too: its agent stops waiting
  inbox close --all [--match PATTERN]
                             close every open message and alert; asks stay

Locks
  locks [PATTERN]            every lock, with its holders and its queue
  locks release NAME AGENT   end an agent's hold, or its place in the queue

Jobs
  job set NAME --host HOST --model PROVIDER/MODEL --prompt TEXT
      --trigger TRIGGER [--to TO] [--description TEXT] [--variant VARIANT]
      [--agent OPENCODE_AGENT] [--timeout DURATION] [--run-usd DOLLARS]
      [--keep-session]       set or replace a job
  job list                   the jobs, with their next and last runs
  job run NAME [--text TEXT]
                             start a run now
  job runs [NAME]            the runs: who started each, state, cost, result
  job delete NAME            delete a job
  job delete-session RUN     delete the session that a failed run left

Settings and History
  settings                   every setting, the rules, agents' own values
  settings --agent AGENT     the values one agent gets, and from where
  settings set KEY VALUE [--agent AGENT | --match PATTERN]
  settings unset KEY [--agent AGENT | --match PATTERN]
                             set or clear a value: server-wide, for one
                             agent, or for the agents a pattern matches
  history [--agent AGENT] [--kind KIND] [--since TIME] [--until TIME]
      [--limit N]            what happened, newest first: 100 entries, or
                             N (up to 1000)
  hosts rm HOST              remove an offline host's record now; the others
                             go by themselves after host_expire_after

Tokens
  Three forms; give an agent or one flag, never two of them:
  token rotate AGENT         replace an agent's session token; a command
                             it started earlier keeps the old one
  token rotate --admin       replace the admin token; the new one is saved
                             on the server (admin.token), never printed
  token rotate --consumer    replace the consumer token (consumer.token);
                             every session token ends with it; then run
                             plugin install again on every other machine

In an Agent's Shell
  A script that an agent starts acts as that agent. It finds autocode by
  name where hosts says yes under SHELL VALUES. Only these commands work
  there, besides info, serve, install, uninstall and plugin:
  me                         this agent's registration and status
  fire me|AGENT WAKE [--text TEXT]
                             deliver one of this agent's wakes now, or
                             another agent's
  send TO TEXT... [--subject SUBJECT] [--reply-to ID]
                             send a message; TO may also be owner

Flags Everywhere
  --json                     print the data as JSON, not as a table
  --url URL                  the server's address
  --token TOKEN              the token to use
  --server-id ID             refuse a server that has another ID

Environment
  AUTOCODE_URL               the server's address, without --url
  AUTOCODE_TOKEN             the token to use, without --token
  AUTOCODE_SERVER_ID         the server ID to expect, without --server-id
  AUTOCODE_HOME              the Autocode home, in place of ~/.autocode
  AUTOCODE_CONFIG            the client config, in place of client.json
                             in the home
  With no token given: the client config's admin token; on the server's
  own machine its admin.token; else the client config's consumer token.

AGENT is an agent's ID, like kaggle:lead. PATTERN matches IDs with *, like
kaggle:*; several are separated by commas.
Exit codes: 0 done, 1 refused or failed, 2 wrong usage, 3 server unreachable.`

// What a script in an agent's shell may run.
const SHELL_COMMANDS = new Set([
  "me",
  "fire",
  "send",
  "info",
  "serve",
  "install",
  "uninstall",
  "plugin",
])

async function serve(args: Parsed): Promise<number> {
  const f = args.flags
  const server = await startServer({
    web: f["web-dir"]
      ? { dir: f["web-dir"] }
      : Object.keys(webFiles).length
        ? { files: webFiles }
        : undefined,
    dataDir: f.data ?? autocodeHome(),
    id: f.id,
    listen: f.listen ? [f.listen] : undefined,
    pollWait: f["poll-wait"] ? Number(f["poll-wait"]) : undefined,
    offlineAfter: f["offline-after"] ? Number(f["offline-after"]) : undefined,
    presetTokens: {
      admin: process.env.AUTOCODE_ADMIN_TOKEN || undefined,
      consumer: process.env.AUTOCODE_CONSUMER_TOKEN || undefined,
    },
  })
  console.log(
    `autocode ${shownVersion(VERSION)}, server ${server.id}, listening on ` +
      `${server.urls.join(", ") || "(no address yet)"}`,
  )
  const made = server.firstStartTokens
  if (made) {
    const dir = f.data ?? autocodeHome()
    const files = [
      made.admin && join(dir, "admin.token"),
      made.consumer && join(dir, "consumer.token"),
    ]
      .filter(Boolean)
      .join(" and ")
    // Shown once, and only on a terminal: a service's output goes to a log that
    // keeps it.
    if (process.stdout.isTTY) {
      console.log(
        "first start: the owner's new tokens, shown once " +
          `(also saved 0600 in ${files}):`,
      )
      if (made.admin) console.log(`  admin token:    ${made.admin}`)
      if (made.consumer) console.log(`  consumer token: ${made.consumer}`)
    } else
      console.log(
        `first start: the owner's new tokens are saved 0600 in ${files}`,
      )
  }
  const stop = async () => {
    await server.stop()
    process.exit(0)
  }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
  await new Promise(() => {})
  return 0
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    console.log(USAGE)
    return 0
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(shownVersion(VERSION))
    return 0
  }
  const args = parseArgs(rest)
  /*
   * A script in an agent's shell acts as that agent with me, fire and send
   * only (the owner, 2026-11-07); a token passed with --token decides for
   * itself, and the machine's own setup commands stay.
   */
  if (inAgentShell() && !args.flags.token && !SHELL_COMMANDS.has(command))
    throw new CliError(
      "in an agent's shell the CLI has only me, fire and send (and the " +
        "machine's own setup: info, serve, install, uninstall, plugin); in " +
        "the conversation, use the autocode_* tools",
      2,
    )
  switch (command) {
    case "serve":
      return serve(args)
    case "install":
      return install(args)
    case "uninstall":
      return uninstall()
    case "plugin": {
      const [sub] = args.words
      if (sub === "install") return pluginInstall(args)
      if (sub === "uninstall") return pluginUninstall(args)
      throw new CliError("usage: autocode plugin install|uninstall ...", 2)
    }
    case "info":
      return info(args)
    case "agents":
      return agents(args)
    case "hosts":
      return hosts(args)
    case "token":
      return token(args)
    case "settings":
      return settings(args)
    case "history":
      return history(args)
    case "costs":
      return costs(args)
    case "me":
      return me(args)
    case "wakes":
      return wakes(args)
    case "wake":
      return wake(args)
    case "fire":
      return fire(args)
    case "send":
      return send(args)
    case "messages":
      return messages(args)
    case "inbox":
      return inbox(args)
    case "answer":
      return answer(args)
    case "pause":
      return pause(args, false)
    case "resume":
      return pause(args, true)
    case "retry":
      return retry(args)
    case "locks":
      return locks(args)
    case "job":
      return job(args)
    case "stop-all":
      return stopAll(args)
    case "resume-all":
      return resumeAll(args)
    default:
      throw new CliError(`unknown command: ${command}\n\n${USAGE}`, 2)
  }
}

try {
  process.exit(await main(process.argv.slice(2)))
} catch (err) {
  if (err instanceof CliError) {
    console.error(err.message)
    process.exit(err.code)
  }
  if (err instanceof Unreachable) {
    console.error(err.message)
    process.exit(3)
  }
  if (err instanceof ApiError) {
    console.error(`refused (${err.code}): ${err.message}`)
    process.exit(1)
  }
  if (err instanceof AutocodeError) {
    console.error(err.message)
    process.exit(1)
  }
  console.error(String((err as Error)?.stack ?? err))
  process.exit(1)
}
