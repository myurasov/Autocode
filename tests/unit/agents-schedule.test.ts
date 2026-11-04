/*
 * The agents suite's work-hours check (ci/agents/schedule.ts): every 30
 * minutes on weekdays between 09:00 and 17:00 Pacific, from one trigger or
 * several together, and what it refuses.
 */
import { expect, test } from "bun:test"
import { workHours } from "../../ci/agents/schedule.ts"

const LA = "America/Los_Angeles"

test("one cron trigger, or two that together cover the hours", () => {
  expect(workHours([`cron "*/30 9-16 * * 1-5" ${LA}`])).toBeNull()
  expect(workHours([`cron "0,30 9-16 * * mon-fri" ${LA}`])).toBeNull()
  // GLM 5.3's setup (2026-11-03): the half hours to 16:30, then 17:00
  expect(
    workHours([`cron "0,30 9-16 * * 1-5" ${LA}`, `cron "0 17 * * 1-5" ${LA}`]),
  ).toBeNull()
})

test("refuses weekends, other hours, other steps, other zones and fixed steps", () => {
  expect(workHours([`cron "*/30 9-16 * * *" ${LA}`])).toContain("weekends")
  expect(workHours([`cron "*/30 8-16 * * 1-5" ${LA}`])).toContain("8:00")
  expect(workHours([`cron "0 9-16 * * 1-5" ${LA}`])).toContain("times a day")
  // the server's zone (UTC) instead of Pacific
  expect(workHours(['cron "*/30 9-16 * * 1-5" UTC'])).not.toBeNull()
  expect(workHours(["every 30m"])).toContain("not a clock schedule")
})
