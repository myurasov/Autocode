/*
 * The tests' docker helper may only touch its own Compose project's containers
 * and network.
 */
import { describe, expect, test } from "bun:test"
import { checkDockerArgs } from "../helpers/docker.ts"

const p = "autocode-ci-two"

describe("docker guard", () => {
  test("commands on the project's own containers and network pass", () => {
    for (const args of [
      ["stop", "--time=2", "autocode-ci-two-node-b-1"],
      [
        "exec",
        "-u",
        "ac",
        "-e",
        "A=1",
        "-w",
        "/home/ac",
        "autocode-ci-two-host-1",
        "autocode",
        "install",
      ],
      [
        "network",
        "disconnect",
        "autocode-ci-two_default",
        "autocode-ci-two-node-a-1",
      ],
      [
        "network",
        "connect",
        "--alias=node-a",
        "autocode-ci-two_default",
        "autocode-ci-two-node-a-1",
      ],
      ["cp", "autocode-ci-two-server-1:/root/.autocode", "/out"],
    ])
      expect(() => checkDockerArgs(args, p)).not.toThrow()
  })

  test("other containers, other networks, other verbs and other projects are refused", () => {
    for (const args of [
      ["stop", "aisee-qwen3-6-35b-a3b"],
      ["exec", "-u", "autocode-ci-two-node-a-1", "aisee-api", "sh"],
      ["network", "disconnect", "bridge", "autocode-ci-two-node-a-1"],
      ["network", "rm", "autocode-ci-two_default"],
      ["rm", "-f", "autocode-ci-two-node-a-1"],
      ["run", "ubuntu"],
      ["stop"],
    ])
      expect(() => checkDockerArgs(args, p)).toThrow()
    expect(() => checkDockerArgs(["stop", "autocode-ci-x-1"], "")).toThrow()
  })

  test("every container a command names is checked, not only the first", () => {
    for (const args of [
      ["stop", "autocode-ci-two-node-a-1", "aisee-api"],
      ["kill", "autocode-ci-two-node-a-1", "aisee-api"],
      ["restart", "--time=2", "autocode-ci-two-server-1", "aisee-api"],
      ["restart", "-t", "2", "autocode-ci-two-server-1", "aisee-api"],
      ["pause", "autocode-ci-two-node-a-1", "aisee-api"],
      ["start", "autocode-ci-two-node-a-1", "aisee-api"],
      ["cp", "/out/x", "aisee-api:/tmp/x"],
      ["cp", "autocode-ci-two-server-1:/a", "aisee-api:/b"],
    ])
      expect(() => checkDockerArgs(args, p)).toThrow()
    expect(() =>
      checkDockerArgs(
        [
          "stop",
          "-t",
          "2",
          "autocode-ci-two-node-a-1",
          "autocode-ci-two-node-b-1",
        ],
        p,
      ),
    ).not.toThrow()
  })
})
