/*
 * Playwright settings for the browser smoke test of the web UI: Chromium, one
 * test at a time, no retries.
 */

import { defineConfig, devices } from "@playwright/test"

// BASE_URL is the Autocode server that serves the UI; OUT_DIR (optional) keeps
// traces and screenshots of failures; CI_GREP (optional) runs only the tests
// whose names match it (a regular expression).
const out = process.env.OUT_DIR ?? "test-results"
const only = process.env.CI_GREP

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  globalTimeout: 300_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  ...(only ? { grep: new RegExp(only) } : {}),
  reporter: [["list"]],
  outputDir: `${out}/web-smoke`,
  use: {
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:4848",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
