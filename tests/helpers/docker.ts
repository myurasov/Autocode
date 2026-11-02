/*
 * Docker CLI for tests, limited to the containers and networks of this suite's
 * own Compose project.
 */

export const project = process.env.COMPOSE_PROJECT ?? ""

export function containerName(service: string): string {
  return `${project}-${service}-1`
}

// Options that take the next argument as their value (long options are passed
// as --name=value).
const VALUE_OPTIONS = new Set([
  "-u",
  "-e",
  "-w",
  "-t",
  "-s",
  "-n",
  "--user",
  "--env",
  "--workdir",
  "--time",
  "--timeout",
  "--signal",
  "--tail",
  "--since",
])

/*
 * The containers and networks a docker command acts on: every operand, except
 * that exec's operands after the container are its command, and cp's are paths,
 * with a container only in "container:path".
 */
function targets(args: string[]): string[] {
  // docker network <connect|disconnect> [options] <network> <container>
  if (args[0] === "network")
    return args.slice(2).filter((a) => !a.startsWith("-"))
  const operands: string[] = []
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] ?? ""
    if (VALUE_OPTIONS.has(arg)) {
      i++
      continue
    }
    if (arg.startsWith("-")) continue
    if (args[0] === "exec") return [arg]
    operands.push(arg)
  }
  if (args[0] === "cp")
    return operands
      .filter((a) => a.includes(":"))
      .map((a) => a.slice(0, a.indexOf(":")))
  return operands
}

function guard(args: string[]) {
  checkDockerArgs(args, project)
}

// Refuses any docker command outside the allowed verbs, or aimed at something
// not in this Compose project.
export function checkDockerArgs(args: string[], project: string) {
  if (!project.startsWith("autocode-ci-"))
    throw new Error(`refusing docker: unexpected project "${project}"`)
  const allowed = new Set([
    "exec",
    "stop",
    "start",
    "restart",
    "kill",
    "inspect",
    "network",
    "logs",
    "cp",
    "pause",
    "unpause",
  ])
  if (!allowed.has(args[0] ?? "")) throw new Error(`refusing docker ${args[0]}`)
  if (
    args[0] === "network" &&
    !["connect", "disconnect"].includes(args[1] ?? "")
  )
    throw new Error(`refusing docker network ${args[1]}`)
  const names = targets(args)
  if (!names.length)
    throw new Error(`refusing docker ${args.join(" ")}: no container named`)
  for (const name of names) {
    if (!name.startsWith(`${project}-`) && !name.startsWith(`${project}_`))
      throw new Error(
        `refusing docker ${args[0]} on ${name}: not part of ${project}`,
      )
  }
}

export async function docker(
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  guard(args)
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code, stdout, stderr }
}

export async function dockerExec(
  service: string,
  command: string[],
  timeoutMs = 60_000,
  user?: string,
) {
  const args = ["exec"]
  if (user) args.push("-u", user)
  args.push(containerName(service), ...command)
  return docker(args, timeoutMs)
}
