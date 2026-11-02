/*
 * ID patterns (discovery, settings rules): * matches any characters, :
 * included, everything else is literal, a comma list matches when any of its
 * items does, and malformed patterns are refused.
 */
import { describe, expect, test } from "bun:test"
import { matchesPattern, parsePattern } from "@autocode/shared"

describe("patterns", () => {
  test("a plain ID matches only itself", () => {
    expect(matchesPattern("kaggle:lead", "kaggle:lead")).toBe(true)
    expect(matchesPattern("kaggle:lead", "kaggle:lead2")).toBe(false)
    expect(matchesPattern("kaggle:lead", "Kaggle:lead")).toBe(false)
  })

  test("* matches any characters, : included", () => {
    expect(matchesPattern("kaggle:*", "kaggle:casmi26:lead")).toBe(true)
    expect(matchesPattern("*:reviewer", "kaggle:casmi26:reviewer")).toBe(true)
    expect(
      matchesPattern("kaggle:casmi26:worker-*", "kaggle:casmi26:worker-12"),
    ).toBe(true)
    expect(
      matchesPattern("kaggle:casmi26:worker-*", "kaggle:casmi26:lead"),
    ).toBe(false)
    expect(matchesPattern("*", "anything")).toBe(true)
    expect(matchesPattern("a*b*c", "aXXbYYc")).toBe(true)
    expect(matchesPattern("a*b*c", "aXXbYY")).toBe(false)
  })

  test("other characters are literal: . does not match any character", () => {
    expect(matchesPattern("a.b", "aXb")).toBe(false)
    expect(matchesPattern("a.b", "a.b")).toBe(true)
  })

  test("a list matches when any of its items matches; spaces around commas are ignored", () => {
    expect(parsePattern("a, b:*,c")).toEqual(["a", "b:*", "c"])
    expect(matchesPattern("a,b:*", "b:x")).toBe(true)
    expect(matchesPattern(["a", "b:*"], "a")).toBe(true)
    expect(matchesPattern("a,b:*", "c")).toBe(false)
  })

  test("empty patterns, empty items and characters outside the ID rules are refused", () => {
    for (const bad of ["", " ", "a,,b", "a b", "a/*", "x".repeat(256)])
      expect(() => parsePattern(bad)).toThrow()
  })
})
