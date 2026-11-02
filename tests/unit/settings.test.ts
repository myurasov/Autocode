/*
 * Settings: the built-in defaults, each key's checks and normalized form, the
 * listen value, and how an agent's values resolve (its own, then the first
 * matching rule, then the server's, then the built-in default).
 */
import { describe, expect, test } from "bun:test"
import {
  builtinDefaults,
  normalizeLayers,
  normalizeSetting,
  parseListen,
  resolveSettings,
  SETTINGS,
  type SettingsLayers,
} from "@autocode/shared"

describe("settings", () => {
  test("the built-in defaults are the spec's", () => {
    const d = builtinDefaults()
    expect(d.min_interval).toBe("1m")
    expect(d.inline_limit).toBe(1024)
    expect(d.question_mode).toBe("ask")
    expect(d.auto_answer_text).toBe(
      "Act according to your best judgement " +
        "and safe practices to achieve my goals.",
    )
    expect(d.permission_mode).toBe("ask")
    expect(d.approval_mode).toBe("ask")
    expect(d.compact_at).toBe("50% max 500000")
    expect(d.check_timeout).toBe("60s")
    expect(d.check_output).toBe(2000)
    expect(d.max_tool_wait).toBe("5m")
    expect(d.tools).toBe("all")
    expect(d.daily_usd).toBe("off")
    expect(d.total_usd).toBe("off")
    expect(d.cap_warn).toBe("90%")
    expect(d.retry).toBe("1m 2m 4m 8m 16m 30m max 10")
    expect(d.expire_after).toBe("14d")
    expect(d.history_days).toBe(30)
    expect(d.keep_failed).toBe("7d")
    expect(d.restart_opencode).toBe(true)
    expect(typeof d.timezone).toBe("string")
    expect(d.listen).toBe("localhost,tailscale:4848")
  })

  test("values are checked and normalized per key", () => {
    expect(normalizeSetting("min_interval", "90s")).toBe("1m30s")
    expect(normalizeSetting("inline_limit", "2048")).toBe(2048)
    expect(normalizeSetting("question_mode", "auto")).toBe("auto")
    expect(normalizeSetting("daily_usd", 12.5)).toBe(12.5)
    expect(normalizeSetting("daily_usd", "off")).toBe("off")
    expect(normalizeSetting("cap_warn", "80%")).toBe("80%")
    expect(normalizeSetting("compact_at", "off")).toBe("off")
    expect(normalizeSetting("compact_at", "200000")).toBe(200000)
    expect(normalizeSetting("compact_at", "40%")).toBe("40%")
    expect(normalizeSetting("restart_opencode", "false")).toBe(false)
    expect(normalizeSetting("timezone", "America/Los_Angeles")).toBe(
      "America/Los_Angeles",
    )
    expect(normalizeSetting("retry", "1m 5m max 3")).toBe("1m 5m max 3")
  })

  test("bad values and unknown keys are refused with the key in the message", () => {
    expect(() => normalizeSetting("min_interval", "soon")).toThrow(
      /min_interval/,
    )
    expect(() => normalizeSetting("question_mode", "maybe")).toThrow(
      /question_mode/,
    )
    expect(() => normalizeSetting("inline_limit", -1)).toThrow(/inline_limit/)
    expect(() => normalizeSetting("daily_usd", -3)).toThrow(/daily_usd/)
    expect(() => normalizeSetting("cap_warn", "150%")).toThrow(/cap_warn/)
    expect(() => normalizeSetting("timezone", "Mars/Olympus")).toThrow(
      /timezone/,
    )
    expect(() => normalizeSetting("no_such_key", 1)).toThrow(/no_such_key/)
  })

  test("keys named like Object.prototype members are unknown settings, not a crash", () => {
    for (const key of [
      "constructor",
      "toString",
      "hasOwnProperty",
      "__proto__",
      "valueOf",
    ])
      expect(() => normalizeSetting(key, 1)).toThrow(/no such setting/)
  })

  test("a dollar amount needs digits: '$' alone or an empty text is refused, not taken as $0", () => {
    expect(normalizeSetting("daily_usd", "$12.50")).toBe(12.5)
    expect(normalizeSetting("daily_usd", "3")).toBe(3)
    for (const bad of ["$", "", " ", "$$1", "1e3", "0x10", "12,50"])
      expect(() => normalizeSetting("daily_usd", bad)).toThrow(/daily_usd/)
  })

  test("listen takes names and IPv4 addresses with a port; anything that can never be bound is refused", () => {
    expect(normalizeSetting("listen", "localhost,tailscale:4848")).toBe(
      "localhost,tailscale:4848",
    )
    expect(normalizeSetting("listen", "0.0.0.0:4848")).toBe("0.0.0.0:4848")
    expect(normalizeSetting("listen", "127.0.0.1:4848,100.64.0.1:4849")).toBe(
      "127.0.0.1:4848,100.64.0.1:4849",
    )
    expect(normalizeSetting("listen", "myspark3.lan:4848")).toBe(
      "myspark3.lan:4848",
    )
    for (const bad of [
      "my host:4848",
      "localhost",
      "localhost:0",
      "localhost:70000",
      "a,,b:4848",
      "-x:4848",
      "a/b:1",
    ])
      expect(() => normalizeSetting("listen", bad)).toThrow(/listen/)
  })

  test("parseListen gives every name its port: a shared one at the end, or its own", () => {
    expect(parseListen("localhost,tailscale:4848")).toEqual([
      { host: "localhost", port: 4848 },
      { host: "tailscale", port: 4848 },
    ])
    expect(parseListen("127.0.0.1:0,0.0.0.0:4849")).toEqual([
      { host: "127.0.0.1", port: 0 },
      { host: "0.0.0.0", port: 4849 },
    ])
    expect(parseListen("a,b:1,c:2")).toEqual([
      { host: "a", port: 1 },
      { host: "b", port: 1 },
      { host: "c", port: 2 },
    ])
    expect(() => parseListen("localhost")).toThrow(/port/)
  })

  test("an agent whose valid ID is __proto__ keeps its own values, and rules ignore prototype keys", () => {
    const agents = JSON.parse('{"__proto__": {"min_interval": "5m"}}')
    const layers = normalizeLayers({ server: {}, rules: [], agents })
    expect(Object.keys(layers.agents)).toEqual(["__proto__"])
    expect(resolveSettings(layers, "__proto__").values.min_interval).toBe("5m")
    expect(resolveSettings(layers, "other").values.min_interval).toBe("1m")
    expect(() =>
      normalizeLayers({
        server: {},
        rules: [{ match: "a:*", settings: { valueOf: 1 } }],
        agents: {},
      }),
    ).toThrow(/no such setting/)
  })

  test("server-wide keys cannot be set for a pattern or an agent", () => {
    for (const key of [
      "history_days",
      "keep_failed",
      "restart_opencode",
      "timezone",
      "listen",
    ])
      expect(SETTINGS[key]?.scope).toBe("server")
    expect(SETTINGS.min_interval?.scope).toBe("agent")
  })

  test("an agent's value wins over the first matching rule, which wins over the server default", () => {
    const layers: SettingsLayers = {
      server: { min_interval: "2m", inline_limit: 500 },
      rules: [
        {
          match: "kaggle:*",
          settings: { min_interval: "5m", question_mode: "auto" },
        },
        {
          match: "kaggle:lead",
          settings: { min_interval: "10m", check_output: 10 },
        },
        { match: "*:reviewer", settings: { inline_limit: 99 } },
      ],
      agents: { "kaggle:lead": { question_mode: "ask" } },
    }
    const lead = resolveSettings(layers, "kaggle:lead")
    expect(lead.values.min_interval).toBe("5m")
    expect(lead.sources.min_interval).toBe("rule 1 (kaggle:*)")
    expect(lead.values.check_output).toBe(2000)
    expect(lead.values.question_mode).toBe("ask")
    expect(lead.sources.question_mode).toBe("agent")
    expect(lead.values.inline_limit).toBe(500)
    expect(lead.sources.inline_limit).toBe("server")
    expect(lead.values.approval_mode).toBe("ask")
    expect(lead.sources.approval_mode).toBe("default")

    const reviewer = resolveSettings(layers, "x:reviewer")
    expect(reviewer.values.inline_limit).toBe(99)
    expect(reviewer.values.min_interval).toBe("2m")
  })

  test("server-wide keys resolve from the server layer only", () => {
    const r = resolveSettings(
      { server: { history_days: 7 }, rules: [], agents: {} },
      "a",
    )
    expect(r.values.history_days).toBe(7)
  })
})
