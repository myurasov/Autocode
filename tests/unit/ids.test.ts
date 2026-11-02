/*
 * What makes a valid ID (letters, digits, -, _, . and :, 1 to 255 characters,
 * not only dots, case-sensitive), the reserved IDs owner and autocode, and
 * checkId's errors.
 */
import { describe, expect, test } from "bun:test"
import { checkId, isReservedId, isValidId } from "@autocode/shared"

describe("IDs", () => {
  test("letters, digits, -, _, . and : are allowed", () => {
    for (const id of ["a", "kaggle:casmi26:lead", "A.b_c-d:9", "x".repeat(255)])
      expect(isValidId(id)).toBe(true)
  })

  test("empty, over 255 characters, spaces, wildcards, slashes and other characters are refused", () => {
    for (const id of [
      "",
      "x".repeat(256),
      "a b",
      "a*",
      "a/b",
      "a,b",
      "é",
      "a\nb",
      "a@b",
    ])
      expect(isValidId(id)).toBe(false)
  })

  test("IDs made only of dots are refused: URLs drop . and .. from paths, so they could never be addressed", () => {
    for (const id of [".", "..", "..."]) expect(isValidId(id)).toBe(false)
    expect(() => checkId("..", "agent ID")).toThrow(/only dots/)
    for (const id of ["a.b", ".a", "a..", "..a"])
      expect(isValidId(id)).toBe(true)
  })

  test("IDs are case-sensitive: Lead and lead are both valid, and checkId keeps the case", () => {
    expect(isValidId("Lead")).toBe(true)
    expect(isValidId("lead")).toBe(true)
    expect(checkId("Lead")).toBe("Lead")
  })

  test("checkId returns the ID or throws an error that names what was wrong", () => {
    expect(checkId("kaggle:lead")).toBe("kaggle:lead")
    expect(() => checkId("a b", "agent ID")).toThrow(/agent ID/)
    expect(() => checkId("", "agent ID")).toThrow(/1 to 255/)
  })

  test("owner and autocode are reserved", () => {
    expect(isReservedId("owner")).toBe(true)
    expect(isReservedId("autocode")).toBe(true)
    expect(isReservedId("owner:x")).toBe(false)
  })
})
