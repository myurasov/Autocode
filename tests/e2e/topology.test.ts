/*
 * The Compose topology itself: the server answers, and each machine runs
 * OpenCode under its own host name and reaches the server by name.
 */
import { expect, test } from "bun:test"
import { dockerExec } from "../helpers/docker.ts"
import { autocodeUrl, nodes } from "../helpers/env.ts"
import { OpenCode } from "../helpers/opencode.ts"
import { fetchJson } from "../helpers/wait.ts"

test("the server answers", async () => {
  const info = await fetchJson(`${autocodeUrl}/v1/info`)
  expect(info.id).toBe("ci-server")
})

test.each(nodes)(
  "machine %s runs OpenCode under its own host name " +
    "and reaches the server by name",
  async (node) => {
    const info = await new OpenCode(node).info()
    expect(info.hostname).toBe(node)
    const res = await dockerExec(node, [
      "curl",
      "-fsS",
      "--max-time",
      "5",
      "http://server:4848/v1/info",
    ])
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout).id).toBe("ci-server")
  },
)
