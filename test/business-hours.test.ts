/**
 * Working-hours math contract.
 *
 * "Working hours" = Mon–Fri, 09:00–17:00 in the caller's timezone. 24
 * working hours ≈ 3 business days (8 hours × 3). Weekends and after-hours
 * windows do not accumulate.
 */
import { describe, expect, test } from "bun:test";
import { workingHoursElapsed } from "../src/lib/business-hours.ts";

const TZ = "America/Los_Angeles";
const NY = "America/New_York";

describe("workingHoursElapsed", () => {
  test("returns 0 when end <= start", () => {
    const t = new Date("2026-04-20T17:00:00Z");
    expect(workingHoursElapsed(t, t, TZ)).toBe(0);
    expect(workingHoursElapsed(new Date(t.getTime() + 1000), t, TZ)).toBe(0);
  });

  test("Monday 09:00 → Monday 17:00 (LA) = 8 working hours", () => {
    // 09:00 PT = 16:00 UTC, 17:00 PT = 00:00 UTC next day.
    const start = new Date("2026-04-20T16:00:00Z");
    const end = new Date("2026-04-21T00:00:00Z");
    const elapsed = workingHoursElapsed(start, end, TZ);
    expect(elapsed).toBeCloseTo(8, 1);
  });

  test("Friday 16:00 → Monday 10:00 (LA) skips weekend", () => {
    // Fri 16:00 PT = 23:00 UTC. Mon 10:00 PT = 17:00 UTC.
    // Working hours: Fri 16-17 (1h) + Mon 09-10 (1h) = 2h.
    const fri16 = new Date("2026-04-17T23:00:00Z");
    const mon10 = new Date("2026-04-20T17:00:00Z");
    const elapsed = workingHoursElapsed(fri16, mon10, TZ);
    expect(elapsed).toBeCloseTo(2, 1);
  });

  test("after-hours stretch (Mon 18:00 → Tue 08:00) accumulates 0", () => {
    // 18:00 PT Mon = 01:00 UTC Tue; 08:00 PT Tue = 15:00 UTC Tue.
    const t1 = new Date("2026-04-21T01:00:00Z");
    const t2 = new Date("2026-04-21T15:00:00Z");
    const elapsed = workingHoursElapsed(t1, t2, TZ);
    expect(elapsed).toBeCloseTo(0, 1);
  });

  test("Mon 09:00 → Wed 09:00 (LA) = 16 working hours (3 weekdays minus the trailing morning)", () => {
    // Mon 09:00 PT = 16:00 UTC; Wed 09:00 PT = 16:00 UTC two days later.
    const monStart = new Date("2026-04-20T16:00:00Z");
    const wedStart = new Date("2026-04-22T16:00:00Z");
    const elapsed = workingHoursElapsed(monStart, wedStart, TZ);
    // Mon 09-17 (8h) + Tue 09-17 (8h) = 16h.
    expect(elapsed).toBeCloseTo(16, 1);
  });

  test("New York timezone handled independently", () => {
    // Mon 09:00 ET = 13:00 UTC; same wall-time end of day = 17:00 ET.
    const start = new Date("2026-04-20T13:00:00Z");
    const end = new Date("2026-04-20T21:00:00Z");
    expect(workingHoursElapsed(start, end, NY)).toBeCloseTo(8, 1);
  });

  test("crosses 24wh exactly on Thursday morning of a Mon-start", () => {
    // Mon 09:00 PT + 3 full 8h days = Thu 09:00 PT.
    const monStart = new Date("2026-04-20T16:00:00Z");
    const thuStart = new Date("2026-04-23T16:00:00Z");
    const elapsed = workingHoursElapsed(monStart, thuStart, TZ);
    expect(elapsed).toBeCloseTo(24, 1);
  });
});
