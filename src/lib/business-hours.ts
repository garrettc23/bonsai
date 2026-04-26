/**
 * Working-hours math for negotiation idle detection.
 *
 * "Working hours" = Mon–Fri, 09:00–17:00 in the caller's timezone (default
 * America/Los_Angeles). 24 working hours ≈ 3 business days. Walks the
 * elapsed window minute-by-minute so weekend-spanning ranges are handled
 * correctly without wall-clock approximations.
 *
 * Used by `advancePersistentNegotiation` to decide when an outbound email
 * has been idle long enough to escalate to voice.
 */

const DEFAULT_TZ = "America/Los_Angeles";
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 17; // exclusive
const MINUTE_MS = 60 * 1000;

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function makeFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function isBusinessMinute(weekday: number, hour: number): boolean {
  if (weekday < 1 || weekday > 5) return false; // weekend
  return hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR;
}

/**
 * Working hours elapsed between `start` and `end`, evaluated in `tz`.
 * Returns 0 when end <= start. Counts each minute that falls inside the
 * Mon-Fri 9-17 local window; converts to fractional hours. Iteration is
 * minute-by-minute because that's DST-safe and precise; the formatter is
 * hoisted so the hot path is a single formatToParts call per minute.
 */
export function workingHoursElapsed(start: Date, end: Date, tz: string = DEFAULT_TZ): number {
  if (!(start instanceof Date) || !(end instanceof Date)) return 0;
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  if (endMs <= startMs) return 0;

  const fmt = makeFormatter(tz);
  let businessMinutes = 0;
  for (let t = startMs; t < endMs; t += MINUTE_MS) {
    const parts = fmt.formatToParts(new Date(t));
    let wd = "Sun";
    let hourStr = "0";
    for (const p of parts) {
      if (p.type === "weekday") wd = p.value;
      else if (p.type === "hour") hourStr = p.value;
    }
    const rawHour = Number(hourStr);
    const hour = rawHour === 24 ? 0 : rawHour;
    const weekday = WEEKDAY_MAP[wd] ?? 0;
    if (isBusinessMinute(weekday, hour)) businessMinutes += 1;
  }
  return businessMinutes / 60;
}
