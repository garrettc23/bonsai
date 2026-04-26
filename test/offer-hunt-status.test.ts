/**
 * Pure-function tests for the offer-hunt status projector. The Comparison
 * tab's hunt-pulse polls /api/offer-hunt/status/:run_id and trusts this
 * shape — if the projector goes wrong, the pulse either never clears or
 * never lights up.
 *
 * Run: bun test test/offer-hunt-status.test.ts
 */
import { describe, expect, test } from "bun:test";
import { projectOfferHuntStatus } from "../src/lib/offer-hunt-status.ts";

describe("projectOfferHuntStatus", () => {
  test("returns done-with-zeros when no hunt has started", () => {
    expect(projectOfferHuntStatus(null)).toEqual({
      in_flight: false,
      baselines_total: 0,
      baselines_done: 0,
      started_at: null,
      ended_at: null,
    });
    expect(projectOfferHuntStatus(undefined)).toEqual({
      in_flight: false,
      baselines_total: 0,
      baselines_done: 0,
      started_at: null,
      ended_at: null,
    });
  });

  test("in_flight=true while status is in_flight", () => {
    const out = projectOfferHuntStatus({
      baselines_total: 2,
      baselines_done: 0,
      started_at: 1700000000,
      status: "in_flight",
    });
    expect(out.in_flight).toBe(true);
    expect(out.baselines_total).toBe(2);
    expect(out.baselines_done).toBe(0);
    expect(out.started_at).toBe(1700000000);
    expect(out.ended_at).toBe(null);
  });

  test("in_flight=false once status flips to done, with ended_at populated", () => {
    const out = projectOfferHuntStatus({
      baselines_total: 2,
      baselines_done: 2,
      started_at: 1700000000,
      ended_at: 1700000060,
      status: "done",
    });
    expect(out.in_flight).toBe(false);
    expect(out.baselines_done).toBe(2);
    expect(out.ended_at).toBe(1700000060);
  });

  test("done with zero baselines is a valid no-op terminal state", () => {
    // No derivable baseline path: runOfferHuntsForRun records this so the
    // UI can immediately stop pulsing.
    const out = projectOfferHuntStatus({
      baselines_total: 0,
      baselines_done: 0,
      started_at: 1700000000,
      ended_at: 1700000000,
      status: "done",
    });
    expect(out.in_flight).toBe(false);
    expect(out.baselines_total).toBe(0);
  });

  test("partial progress mid-hunt", () => {
    const out = projectOfferHuntStatus({
      baselines_total: 3,
      baselines_done: 1,
      started_at: 1700000000,
      status: "in_flight",
    });
    expect(out.in_flight).toBe(true);
    expect(out.baselines_done).toBe(1);
    expect(out.baselines_total).toBe(3);
  });
});
