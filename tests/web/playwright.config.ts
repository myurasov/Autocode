/*
 * Playwright settings for the browser smoke test of the web UI: Chromium, one
 * test at a time, no retries.
 */

import { defineConfig, devices } from "@playwright/test"

// BASE_URL is the Autocode server that serves the UI; OUT_DIR (optional) keeps
// traces and screenshots of failures.
const out = process.env.OUT_DIR ?? "test-results"

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
