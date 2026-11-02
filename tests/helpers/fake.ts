/*
 * Scripts the fake model server and reads what it was sent. One namespace per
 * OpenCode machine.
 */
import type { RecordedRequest, Step } from "../../ci/fake-model/server.ts"
import { fakeModelUrl } from "./env.ts"
import { fetchJson } from "./wait.ts"

export class FakeModel {
  constructor(readonly ns: string) {}

  script(steps: Step[], append = false) {
    return fetchJson(`${fakeModelUrl}/${this.ns}/_script`, {
      method: "POST",
      body: JSON.stringify({ steps, append }),
    })
  }

  async requests(): Promise<RecordedRequest[]> {
    return (await fetchJson(`${fakeModelUrl}/${this.ns}/_requests`)).requests
  }

  reset() {
    return fetchJson(`${fakeModelUrl}/${this.ns}/_reset`, { method: "POST" })
  }
}

// The text of the tool results a session's model requests carried, newest last.
export function toolResults(
  requests: RecordedRequest[],
  session: string,
): string[] {
  const out: string[] = []
  const last = requests
    .filter((r) => r.session === session && r.kind === "primary")
    .at(-1)
  for (const m of (last?.messages ?? []) as any[]) {
    if (m?.role !== "tool") continue
    out.push(
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
  }
  return out
}
