/**
 * voice-spend tracker — direct unit tests.
 *
 * The cost-control tests cover the dial gate that consults this store; this
 * file exercises the store on its own so cross-day accumulation, no-op
 * behavior on bad inputs, and the budget env override are pinned.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTest, getDb } from "../src/lib/db.ts";
import {
  DEFAULT_DAILY_BUDGET_USD,
  addSpend,
  getDailyBudgetUsd,
  getTodaySpendUsd,
} from "../src/lib/voice-spend.ts";

const TEST_DIR = join(tmpdir(), `bonsai-voice-spend-${process.pid}-${Date.now()}`);
const TEST_DB = join(TEST_DIR, "bonsai.db");

beforeAll(() => {
  process.env.BONSAI_DB_PATH = TEST_DB;
  process.env.BONSAI_DATA_DIR = TEST_DIR;
});

afterAll(() => {
  delete process.env.BONSAI_DB_PATH;
  delete process.env.BONSAI_DATA_DIR;
  delete process.env.BONSAI_VOICE_DAILY_BUDGET_USD;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  _resetDbForTest();
  delete process.env.BONSAI_VOICE_DAILY_BUDGET_USD;
  getDb();
});

describe("voice-spend", () => {
  test("getTodaySpendUsd is 0 before any addSpend", () => {
    expect(getTodaySpendUsd()).toBe(0);
  });

  test("addSpend accumulates within the same UTC day", () => {
    const day = new Date("2026-04-25T12:00:00Z");
    addSpend(0.5, day);
    addSpend(1.25, day);
    expect(getTodaySpendUsd(day)).toBeCloseTo(1.75, 4);
  });

  test("addSpend keeps separate buckets per UTC day", () => {
    const day1 = new Date("2026-04-25T23:00:00Z");
    const day2 = new Date("2026-04-26T01:00:00Z");
    addSpend(2.0, day1);
    addSpend(0.4, day2);
    expect(getTodaySpendUsd(day1)).toBeCloseTo(2.0, 4);
    expect(getTodaySpendUsd(day2)).toBeCloseTo(0.4, 4);
  });

  test("addSpend ignores zero and negative inputs", () => {
    addSpend(1.0);
    addSpend(0);
    addSpend(-3.5);
    addSpend(Number.NaN);
    expect(getTodaySpendUsd()).toBeCloseTo(1.0, 4);
  });

  test("getDailyBudgetUsd defaults to 50 when env unset", () => {
    expect(getDailyBudgetUsd()).toBe(DEFAULT_DAILY_BUDGET_USD);
  });

  test("getDailyBudgetUsd reads BONSAI_VOICE_DAILY_BUDGET_USD when valid", () => {
    process.env.BONSAI_VOICE_DAILY_BUDGET_USD = "12.5";
    expect(getDailyBudgetUsd()).toBe(12.5);
  });

  test("getDailyBudgetUsd falls back to default on invalid env", () => {
    process.env.BONSAI_VOICE_DAILY_BUDGET_USD = "not-a-number";
    expect(getDailyBudgetUsd()).toBe(DEFAULT_DAILY_BUDGET_USD);
    process.env.BONSAI_VOICE_DAILY_BUDGET_USD = "-5";
    expect(getDailyBudgetUsd()).toBe(DEFAULT_DAILY_BUDGET_USD);
  });
});
