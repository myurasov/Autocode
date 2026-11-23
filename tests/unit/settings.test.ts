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
    // Phase 1: no inline_limit (messages come whole)
    expect(d).not.toHaveProperty("inline_limit")
    expect(d.question_mode).toBe("ask")
    expect(d.auto_answer_text).toBe(
      "Act according to your best judgement " +
        "and safe practices to achieve my goals.",
    )
    expect(d.permission_mode).toBe("ask")
    expect(d.approval_mode).toBe("ask")
    // jobs set by agents: an approval of the owner first (the owner,
    // 2026-11-09, rc2)
    expect(d.job_mode).toBe("ask")
    // periodic wakes set by agents: at once, as before (1.1.0-rc5); the
    // value is called allow since 1.1.0-rc6
    expect(d.wake_mode).toBe("allow")
    expect(d.compact_at).toBe("50% max 500000")
    expect(d.check_timeout).toBe("60s")
    expect(d.check_output).toBe(2000)
    expect(d.max_tool_wait).toBe("5m")
    expect(d.daily_usd).toBe("off")
    expect(d.cap_warn).toBe("90%")
    // tier 0b3 (the owner, 2026-11-04): every minute, no limit
    expect(d.retry_interval).toBe("1m")
    expect(d.retry_attempts).toBe(0)
    expect("retry" in d).toBe(false)
    expect(d.expire_after).toBe("14d")
    expect(d.history_days).toBe(30)
    expect(typeof d.timezone).toBe("string")
    // the owner, 2026-11-07: no tools setting, one cap (daily_usd), jobs
    // without keep_failed, and no restart setting
    for (const gone of [
      "tools",
      "total_usd",
      "keep_failed",
      "restart_opencode",
    ])
      expect(gone in d, gone).toBe(false)
    expect(d.listen).toBe("localhost,tailscale:4848")
  })

  test("values are checked and normalized per key", () => {
    expect(normalizeSetting("min_interval", "90s")).toBe("1m30s")
    expect(normalizeSetting("check_output", "2048")).toBe(2048)
    expect(normalizeSetting("question_mode", "auto_answer")).toBe("auto_answer")
    expect(normalizeSetting("daily_usd", 12.5)).toBe(12.5)
    expect(normalizeSetting("daily_usd", "off")).toBe("off")
    expect(normalizeSetting("cap_warn", "80%")).toBe("80%")
    expect(normalizeSetting("compact_at", "off")).toBe("off")
    expect(normalizeSetting("compact_at", "200000")).toBe(200000)
    expect(normalizeSetting("compact_at", "40%")).toBe("40%")
    expect(normalizeSetting("timezone", "America/Los_Angeles")).toBe(
      "America/Los_Angeles",
    )
    expect(normalizeSetting("retry_interval", "90s")).toBe("1m30s")
    expect(normalizeSetting("retry_attempts", "5")).toBe(5)
    expect(normalizeSetting("retry_attempts", 0)).toBe(0)
  })

  test("bad values and unknown keys are refused with the key in the message", () => {
    expect(() => normalizeSetting("min_interval", "soon")).toThrow(
      /min_interval/,
    )
    expect(() => normalizeSetting("question_mode", "maybe")).toThrow(
      /question_mode/,
    )
    expect(() => normalizeSetting("check_output", -1)).toThrow(/check_output/)
    expect(() => normalizeSetting("retry_attempts", -1)).toThrow(
      /retry_attempts/,
    )
    expect(() => normalizeSetting("retry_interval", "soon")).toThrow(
      /retry_interval/,
    )
    expect(() => normalizeSetting("retry", "1m max 3")).toThrow(/retry/)
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
    expect(normalizeSetting("listen", "machine-a.lan:4848")).toBe(
      "machine-a.lan:4848",
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
    for (const key of ["history_days", "timezone", "listen"])
      expect(SETTINGS[key]?.scope).toBe("server")
    expect(SETTINGS.min_interval?.scope).toBe("agent")
  })

  test("an agent's value wins over the first matching rule, which wins over the server default", () => {
    const layers: SettingsLayers = {
      server: { min_interval: "2m", check_timeout: "30s" },
      rules: [
        {
          match: "kaggle:*",
          settings: { min_interval: "5m", question_mode: "auto_answer" },
        },
        {
          match: "kaggle:lead",
          settings: { min_interval: "10m", check_output: 10 },
        },
        { match: "*:reviewer", settings: { check_timeout: "99s" } },
      ],
      agents: { "kaggle:lead": { question_mode: "ask" } },
    }
    const lead = resolveSettings(layers, "kaggle:lead")
    expect(lead.values.min_interval).toBe("5m")
    expect(lead.sources.min_interval).toBe("rule 1 (kaggle:*)")
    expect(lead.values.check_output).toBe(2000)
    expect(lead.values.question_mode).toBe("ask")
    expect(lead.sources.question_mode).toBe("agent")
    expect(lead.values.check_timeout).toBe("30s")
    expect(lead.sources.check_timeout).toBe("server")
    expect(lead.values.approval_mode).toBe("ask")
    expect(lead.sources.approval_mode).toBe("default")

    const reviewer = resolveSettings(layers, "x:reviewer")
    expect(reviewer.values.check_timeout).toBe("99s")
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

// The owner, 2026-11-09 (rc2): job_mode, per agent and pattern: ask (an
// approval of the owner), allow (at once) or deny (agents cannot set jobs).
test("job_mode takes ask, allow or deny, and nothing else", () => {
  for (const v of ["ask", "allow", "deny"])
    expect(normalizeSetting("job_mode", v)).toBe(v)
  for (const v of ["agent:team:lead", "job:mail", "auto_answer", ""])
    expect(() => normalizeSetting("job_mode", v), v).toThrow(
      "expected one of ask, allow, deny",
    )
  expect(SETTINGS.job_mode?.scope).toBe("agent")
  expect(SETTINGS.job_mode?.help).toBe(
    "jobs an agent sets: an approval of the owner first (ask), set at once " +
      "(allow), or refused (deny)",
  )
})

// 1.1.0-rc5 (asked for by a project): wake_mode, per agent and pattern,
// for the periodic wakes an agent sets: allow (at once, the default), ask
// (an approval of the owner) or deny.
test("wake_mode takes ask, allow or deny, and nothing else", () => {
  for (const v of ["ask", "allow", "deny"])
    expect(normalizeSetting("wake_mode", v)).toBe(v)
  for (const v of ["agent:team:lead", "job:mail", "auto_answer", ""])
    expect(() => normalizeSetting("wake_mode", v), v).toThrow(
      "expected one of ask, allow, deny",
    )
  expect(SETTINGS.wake_mode?.scope).toBe("agent")
  expect(SETTINGS.wake_mode?.help).toBe(
    "periodic wakes an agent sets (every, cron, idle): set at once, " +
      "with nobody asked (allow), an approval of the owner first " +
      "(ask), or refused (deny)",
  )
})

/*
 * 1.1.0-rc6 (the owner, 2026-11-22, after a table of the five mode
 * settings: "lets rename: "approve" to "allow" "auto" to "auto_answer"
 * "off" to "deny""; agents had read approve as "needs approval"). An old
 * name is refused, with the new one: no value has two names.
 */
describe("the mode values' names since 1.1.0-rc6", () => {
  test("each mode setting takes its new values", () => {
    const takes: Record<string, string[]> = {
      question_mode: ["ask", "auto_answer", "agent:team:lead", "job:mail"],
      permission_mode: ["ask", "allow", "agent:team:lead", "job:mail"],
      approval_mode: ["ask", "allow", "agent:team:lead", "job:mail"],
      job_mode: ["ask", "allow", "deny"],
      wake_mode: ["ask", "allow", "deny"],
    }
    for (const [key, values] of Object.entries(takes)) {
      for (const v of values) expect(normalizeSetting(key, v), key).toBe(v)
      expect(SETTINGS[key]?.values, key).toEqual(
        values.filter((v) => !v.includes(":")),
      )
    }
    expect(SETTINGS.question_mode?.help).toBe(
      "questions go to the owner (ask), are answered at once " +
        "(auto_answer), or go to agent:<id> or job:<name>",
    )
    expect(SETTINGS.auto_answer_text?.help).toBe(
      "the answer given under question_mode auto_answer",
    )
    expect(SETTINGS.permission_mode?.help).toBe(
      "permission prompts go to the owner (ask), are allowed once " +
        "(allow), or go to agent:<id> or job:<name>",
    )
    expect(SETTINGS.approval_mode?.help).toBe(
      "approvals go to the owner (ask), are approved at once (allow), or " +
        "go to agent:<id> or job:<name>",
    )
  })

  test("an old name is refused, and the message names the new one", () => {
    const old: [string, string, string][] = [
      ["question_mode", "auto", "auto_answer"],
      ["permission_mode", "approve", "allow"],
      ["approval_mode", "approve", "allow"],
      ["job_mode", "approve", "allow"],
      ["job_mode", "off", "deny"],
      ["wake_mode", "approve", "allow"],
      ["wake_mode", "off", "deny"],
    ]
    for (const [key, was, now] of old) {
      let message = ""
      try {
        normalizeSetting(key, was)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message, `${key} ${was}`).toStartWith(
        `${key}: "${was}" is now "${now}" (renamed in 1.1.0-rc6); expected `,
      )
      // with spaces around it too
      expect(() => normalizeSetting(key, ` ${was} `)).toThrow(
        `"${was}" is now "${now}"`,
      )
    }
    // a value that was never one of a setting's gets the plain message
    expect(() => normalizeSetting("question_mode", "approve")).toThrow(
      "question_mode: expected ask, auto_answer, agent:<id> or job:<name>",
    )
    expect(() => normalizeSetting("permission_mode", "off")).toThrow(
      "permission_mode: expected ask, allow, agent:<id> or job:<name>",
    )
    expect(() => normalizeSetting("job_mode", "auto")).toThrow(
      "job_mode: expected one of ask, allow, deny",
    )
  })

  test("off stays the word of the settings where it means not in use", () => {
    expect(normalizeSetting("compact_at", "off")).toBe("off")
    expect(normalizeSetting("daily_usd", "off")).toBe("off")
    expect(normalizeSetting("filter_recovery", "off")).toBe("off")
  })
})

// 1.1.0-rc5 (asked for by a project): 0 means never, as for a host's
// record and a report; the help says so.
test("expire_after takes 0 for never, and its help says so", () => {
  expect(normalizeSetting("expire_after", "0")).toBe(
    normalizeSetting("host_expire_after", "0"),
  )
  expect(SETTINGS.expire_after?.help).toBe(
    "unregister an agent this long after its session's last turn " +
      "(0: never)",
  )
})
