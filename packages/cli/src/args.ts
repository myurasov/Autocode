/*
 * A small argument parser: positional words, --flag value, --flag=value and
 * boolean switches.
 */

const SWITCHES = new Set(["json", "force", "help"])

export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message)
  }
}

export interface Parsed {
  words: string[]
  flags: Record<string, string>
  switches: Set<string>
}

export function parseArgs(argv: string[]): Parsed {
  const words: string[] = []
  const flags: Record<string, string> = {}
  const switches = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ""
    if (!arg.startsWith("--")) {
      words.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    const name = arg.slice(2, eq > 0 ? eq : undefined)
    if (eq > 0) flags[name] = arg.slice(eq + 1)
    else if (SWITCHES.has(name)) switches.add(name)
    else {
      const value = argv[i + 1]
      if (value === undefined) throw new CliError(`--${name} needs a value`, 2)
      flags[name] = value
      i++
    }
  }
  return { words, flags, switches }
}
