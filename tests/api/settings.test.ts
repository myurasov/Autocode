/*
 * The settings API: reading the defaults, rules, agents' values and schema;
 * changes that apply whole or not at all, by the admin token only, recorded in
 * the history; and each agent's resolved values with where each comes from.
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  call,
  hello,
  sessionToken,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

const running: TestServer[] = []
afterEach(async () => {
  for (const t of running.splice(0)) await t.stop()
})

async function start() {
  const t = await testServer()
  running.push(t)
  return t
}

describe("settings API", () => {
  test("GET shows the effective defaults, the rules, the agents' values and the schema", async () => {
    const t = await start()
    const res = await call(t.url, t.admin, "GET", "/v1/settings")
    expect(res.status).toBe(200)
    expect(res.body.defaults.min_interval).toBe("1m")
    expect(res.body.server).toEqual({})
    expect(res.body.rules).toEqual([])
    expect(res.body.agents).toEqual({})
    expect(res.body.schema.min_interval).toMatchObject({
      scope: "agent",
      default: "1m",
    })
    expect((await call(t.url, t.consumer, "GET", "/v1/settings")).status).toBe(
      200,
    )
  })

  test("PATCH sets server values, replaces the rules and sets or clears agents' values", async () => {
    const t = await start()
    const res = await call(t.url, t.admin, "PATCH", "/v1/settings", {
      server: { min_interval: "90s", check_output: 2048 },
      rules: [{ match: "kaggle:*", settings: { question_mode: "auto" } }],
      agents: { "kaggle:lead": { min_interval: "5m" } },
    })
    expect(res.status).toBe(200)
    expect(res.body.server).toEqual({
      min_interval: "1m30s",
      check_output: 2048,
    })
    expect(res.body.defaults.min_interval).toBe("1m30s")
    expect(res.body.rules).toEqual([
      { match: "kaggle:*", settings: { question_mode: "auto" } },
    ])
    expect(res.body.agents).toEqual({ "kaggle:lead": { min_interval: "5m" } })
    const cleared = await call(t.url, t.admin, "PATCH", "/v1/settings", {
      server: { min_interval: null },
      agents: { "kaggle:lead": null },
    })
    expect(cleared.body.server).toEqual({ check_output: 2048 })
    expect(cleared.body.agents).toEqual({})
    expect(cleared.body.rules.length).toBe(1)
  })

  test("a bad value refuses the whole change and names the key", async () => {
    const t = await start()
    const res = await call(t.url, t.admin, "PATCH", "/v1/settings", {
      server: { min_interval: "2m", question_mode: "sometimes" },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain("question_mode")
    expect(
      (await call(t.url, t.admin, "GET", "/v1/settings")).body.server,
    ).toEqual({})
    const scoped = await call(t.url, t.admin, "PATCH", "/v1/settings", {
      agents: { "a:b": { history_days: 3 } },
    })
    expect(scoped.status).toBe(400)
    const badMatch = await call(t.url, t.admin, "PATCH", "/v1/settings", {
      rules: [{ match: "a b", settings: {} }],
    })
    expect(badMatch.status).toBe(400)
    const badAgent = await call(t.url, t.admin, "PATCH", "/v1/settings", {
      agents: { "a b": { min_interval: "1m" } },
    })
    expect(badAgent.status).toBe(400)
  })

  test("keys named like Object.prototype members are refused as unknown (400), never a 500 or a silent drop", async () => {
    const t = await start()
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      const res = await call(t.url, t.admin, "PATCH", "/v1/settings", {
        server: { [key]: 1 },
      })
      expect(`${key} ${res.status}`).toBe(`${key} 400`)
    }
    const rule = await call(t.url, t.admin, "PATCH", "/v1/settings", {
      rules: [{ match: "a:*", settings: { valueOf: 1 } }],
    })
    expect(rule.status).toBe(400)
    expect(
      (await call(t.url, t.admin, "GET", "/v1/settings")).body.rules,
    ).toEqual([])
  })

  test("an agent whose valid ID is __proto__ keeps the values the owner gives it", async () => {
    const t = await start()
    // JSON.parse makes __proto__ an own key, as any HTTP client's body would
    const body = JSON.parse('{"agents":{"__proto__":{"min_interval":"5m"}}}')
    expect(
      (await call(t.url, t.admin, "PATCH", "/v1/settings", body)).status,
    ).toBe(200)
    const resolved = await call(
      t.url,
      t.admin,
      "GET",
      "/v1/settings?agent=__proto__",
    )
    expect(resolved.body.values.min_interval).toBe("5m")
    expect(resolved.body.sources.min_interval).toBe("agent")
    const view = await call(t.url, t.admin, "GET", "/v1/settings")
    expect(Object.keys(view.body.agents)).toEqual(["__proto__"])
  })

  test("an agent's resolved settings say where each value comes from", async () => {
    const t = await start()
    await call(t.url, t.admin, "PATCH", "/v1/settings", {
      server: { check_output: 100 },
      rules: [{ match: "kaggle:*", settings: { min_interval: "5m" } }],
      agents: { "kaggle:lead": { question_mode: "auto" } },
    })
    const res = await call(
      t.url,
      t.admin,
      "GET",
      "/v1/settings?agent=kaggle:lead",
    )
    expect(res.body.agent).toBe("kaggle:lead")
    expect(res.body.values).toMatchObject({
      check_output: 100,
      min_interval: "5m",
      question_mode: "auto",
      approval_mode: "ask",
    })
    expect(res.body.sources).toMatchObject({
      check_output: "server",
      min_interval: "rule 1 (kaggle:*)",
      question_mode: "agent",
      approval_mode: "default",
    })
  })

  test("only the admin token may change settings; changes are recorded in the history", async () => {
    const t = await start()
    await hello(t, "m:1")
    const token = await sessionToken(t, "m:1", "ses_1")
    expect(
      (await call(t.url, t.consumer, "PATCH", "/v1/settings", { server: {} }))
        .status,
    ).toBe(403)
    expect((await call(t.url, token, "GET", "/v1/settings")).status).toBe(403)
    await call(t.url, t.admin, "PATCH", "/v1/settings", {
      server: { min_interval: "2m" },
    })
    const entry = (
      await call(t.url, t.admin, "GET", "/v1/history?kind=settings.changed")
    ).body.history[0]
    expect(entry.data).toMatchObject({ server: { min_interval: "2m" } })
  })
})
