/*
 * The agent guide (spec, Agent Tools): what Autocode is and exactly how it
 * works for an agent, written for this plugin's server from
 * autocode.consumer.agent.md and the tools' own definitions. It is the
 * `autocode` skill, and `autocode_me action=help` returns it whole or one
 * part (a topic). Also the one line a registered session gets in each model
 * call.
 */

import guideSource from "../../autocode.consumer.agent.md" with { type: "text" }

export const SKILL_ID = "autocode"

export const SKILL_DESCRIPTION =
  "Autocode: what it is and how to use it. Registering this session as an " +
  "agent, wakes (prompts injected later, on a schedule or when idle), " +
  "messages between agents and the owner, locks shared by agents, and " +
  "prompts that start with [autocode]."

export interface GuideFacts {
  serverId?: string
  url: string
  shellValues: boolean
  tools: { name: string; description: string }[]
}

// The guide's parts, in order; `help` takes one of them as its topic.
export const TOPICS = [
  "overview",
  "delivery",
  "wakes",
  "checks",
  "recipes",
  "messages",
  "owner",
  "locks",
  "asks",
  "costs",
  "jobs",
  "prompts",
  "scripts",
  "trouble",
] as const

type Topic = (typeof TOPICS)[number]

/*
 * The guide's text: autocode.consumer.agent.md at the repository's root (the
 * owner, 2026-11-09: the source of the skill agents get), embedded in the
 * plugin's bundle. Its marks: "topic: NAME" starts a part; "if shell values",
 * "if no shell values", "else" and "end" keep what fits this server's shells;
 * {{server}} and {{tools}} are filled in.
 */
export function parseGuide(text: string): Record<Topic, string> {
  // the file's own header comment (not a topic's mark) goes
  const body = text.replace(/^<!--(?! topic:)[\s\S]*?-->\s*/, "")
  const parts: Partial<Record<Topic, string>> = {}
  const marks = [...body.matchAll(/^<!-- topic: ([a-z]+) -->\n/gm)]
  marks.forEach((m, i) => {
    const name = m[1] as Topic
    if (!(TOPICS as readonly string[]).includes(name))
      throw new Error(`the guide has an unknown topic ${name}`)
    const from = m.index! + m[0].length
    const to = i + 1 < marks.length ? marks[i + 1]!.index! : body.length
    parts[name] = body.slice(from, to).replace(/^\n+|\n+$/g, "")
  })
  for (const t of TOPICS)
    if (parts[t] === undefined) throw new Error(`the guide has no topic ${t}`)
  return parts as Record<Topic, string>
}

const PARTS = parseGuide(guideSource)

// One part, for this server: its shell values' text kept, the rest filled in.
function render(part: string, f: GuideFacts): string {
  const server = f.serverId ? `\`${f.serverId}\` at ${f.url}` : f.url
  return part
    .replace(
      /<!-- if shell values -->\n([\s\S]*?)<!-- else -->\n([\s\S]*?)<!-- end -->\n/g,
      (_, yes: string, no: string) => (f.shellValues ? yes : no),
    )
    .replace(/<!-- if no shell values -->([\s\S]*?)<!-- end -->/g, (_, no) =>
      f.shellValues ? "" : no,
    )
    .replace("{{server}}", server)
    .replace(
      "{{tools}}",
      f.tools.map((t) => `- \`${t.name}\`: ${t.description}`).join("\n"),
    )
}

function sections(f: GuideFacts): Record<Topic, string[]> {
  const out = {} as Record<Topic, string[]>
  for (const t of TOPICS) out[t] = render(PARTS[t], f).split("\n")
  return out
}

export function guideText(f: GuideFacts): string {
  const parts = sections(f)
  return `${TOPICS.map((t) => parts[t].join("\n")).join("\n\n")}\n`
}

// The guide whole (no topic, or "all"), or one of its parts.
export function helpText(f: GuideFacts, topic?: string): string {
  if (!topic || topic === "all") return guideText(f)
  if ((TOPICS as readonly string[]).includes(topic))
    return `${sections(f)[topic as Topic].join("\n")}\n`
  return (
    `Unknown topic ${JSON.stringify(topic)}. ` +
    `Topics: ${TOPICS.join(", ")}, all.`
  )
}

export function agentLine(agent: string, serverId?: string): string {
  return (
    `This session is Autocode agent \`${agent}\`` +
    (serverId ? ` on server \`${serverId}\`` : "") +
    ". Use the `autocode_*` tools (not the `autocode` CLI); " +
    "`autocode_me action=help` or the `autocode` skill explains exactly " +
    "how wakes and messages work. Write to the owner briefly: only what " +
    "they need, the point first, in plain words."
  )
}
