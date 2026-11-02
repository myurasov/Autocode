/*
 * The agent tools. Tier 0a has autocode_me with register, unregister, status
 * and discover; later tiers add actions and tools. Descriptions stay short:
 * OpenCode sends them with every model call.
 */

export interface MeInput {
  action: "register" | "unregister" | "status" | "discover"
  id?: string
  description?: string
  pattern?: string
}

export const ME_TOOL = {
  name: "autocode_me",
  description:
    "Autocode: register this session as an agent, unregister, " +
    "see your status, or discover other agents. " +
    "Actions: register (id, description), unregister, status, " +
    "discover (pattern: IDs with * wildcards, or a comma list).",
  input: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["register", "unregister", "status", "discover"],
      },
      id: {
        type: "string",
        description: "register: your agent ID, like project:role:name",
      },
      description: {
        type: "string",
        description: "register: what you do, in a sentence",
      },
      pattern: {
        type: "string",
        description: "discover: which agents, like kaggle:* (default *)",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
}

export type Call = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<any>

function agentLine(a: any): string {
  const desc = a.description ? `  ${a.description}` : ""
  return `${a.id}  ${a.status}  last active ${a.last_active}${desc}`
}

export async function runMe(input: MeInput, call: Call): Promise<string> {
  switch (input?.action) {
    case "register": {
      if (!input.id)
        return "error: register needs an id, like project:role:name"
      const res = await call("POST", "/v1/agents", {
        id: input.id,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
      })
      return `Registered as ${res.agent.id} (status ${res.agent.status}).`
    }
    case "unregister": {
      const res = await call("DELETE", "/v1/me")
      return `Unregistered ${res.unregistered}.`
    }
    case "status": {
      const res = await call("GET", "/v1/me")
      if (!res.registered)
        return (
          "Not registered. Register with action=register and an id like " +
          "project:role:name."
        )
      const a = res.agent
      return [
        `Registered as ${a.id}${a.description ? `: ${a.description}` : ""}.`,
        `Status ${a.status}; machine ${a.machine}; ` +
          `registered ${a.registered_at}; last active ${a.last_active}.`,
      ].join("\n")
    }
    case "discover": {
      const pattern = input.pattern?.trim() || "*"
      const res = await call(
        "GET",
        `/v1/agents?match=${encodeURIComponent(pattern)}`,
      )
      if (!res.agents.length) return `No agents match ${pattern}.`
      return res.agents.map(agentLine).join("\n")
    }
    default:
      return "error: action must be register, unregister, status or discover"
  }
}
