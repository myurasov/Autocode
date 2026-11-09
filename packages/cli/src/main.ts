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

owner:
  serve [--id ID] [--listen localhost,tailscale:4848] [--data DIR]
                                         run the server
  install [--listen ...] [--id ...]      install the server as a
                                         systemd user service (Linux)
  uninstall                              remove the service (binary, data stay)
  plugin install --url URL --consumer-token T [--server-id ID]
      [--admin-token T] [--opencode-config-dir DIR]
  plugin uninstall [--opencode-config-dir DIR]
  info                                   the server's ID and version
  agents [PATTERN] | agents rm AGENT     list agents (spend today, context
                                         share), or unregister one
  agents register AGENT --session SES [--force]
                                         bind an ID to a session
                                         (--force moves it from a live one)
  hosts                                  the plugin instances (machine, folder)
                                         and whether they are online
  token rotate AGENT                     replace an agent's session token
  settings [--agent ID] | settings set|unset KEY [VALUE]
      [--agent ID | --match PATTERN]
  history [--agent ID] [--kind KIND] [--since TIME] [--limit N]
  costs [AGENT] [--match PATTERN] [--days X]
                                         every agent's spend (today, total;
                                         unregistered ones too, and the
                                         totals), cap, what is left, context
                                         and its compaction threshold; one
                                         agent's days; --days X: the total
                                         over the last X days
  inbox [--all] | inbox close ID         the owner's inbox
  answer ID TEXT...                      answer a message, question, permission
                                         (once|always|reject) or approval
  pause AGENT | resume AGENT             pause or resume an agent's injections
  retry AGENT                            retry an agent in the error state now
  locks [PATTERN] | locks release NAME AGENT
                                         every lock (holders, queue); free one
  job set NAME --host H --model M --prompt P --trigger T [--to TO]
      [--timeout 1h] [--run-usd 2] [--keep-session]
  job list | job run NAME [--text T] | job runs [NAME] | job delete NAME
  job delete-session RUN                 jobs and their runs (spawned agents);
                                         a failed run's kept session
  stop-all | resume-all                  pause every agent and interrupt every
                                         turn; resume what stop-all paused
  wakes [AGENT]                          every wake, or one agent's
  wake set AGENT NAME --trigger T --text TEXT [--check CMD]
  wake cancel AGENT NAME
  messages | messages read ID            every message; one whole
  fire AGENT WAKE [--text TEXT]          deliver a wake now
  send TO TEXT... [--subject S] [--reply-to ID]
                                         TO: an ID, a pattern, a list

scripts in an agent's shell (only these and the setup commands above;
the rest is the tools'):
  me                                     this agent's registration and status
  fire me WAKE [--text TEXT]             deliver one of its wakes now
  send TO TEXT... [--subject S] [--reply-to ID]
                                         TO: an ID, a pattern, a list or owner

flags everywhere: --json, --url URL, --token TOKEN,
                  --server-id ID (refuse a server with another ID)`

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
