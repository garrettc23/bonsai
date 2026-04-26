/**
 * Idempotent delete tests. Covers two scenarios:
 *   1. Pending record + report file present → unlinks both, deleted=true.
 *   2. Pending record missing (orphaned, race, double-click) → returns
 *      deleted=false instead of throwing. The frontend's optimistic UI
 *      has already removed the row; the server must not paint an error
 *      toast over a successful client-side delete.
 *
 * Targets src/lib/delete-bill.ts directly so the test stays hermetic
 * (importing src/server.ts boots Bun.serve and fails fast on missing
 * ANTHROPIC_API_KEY).
 *
 * Run: bun test test/delete-bill-completed.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteBillByRunId, type PendingRunForDelete } from "../src/lib/delete-bill.ts";
import { ensureUserDirs, userPaths } from "../src/lib/user-paths.ts";

const TEST_DATA_DIR = join(tmpdir(), `bonsai-delete-test-${process.pid}-${Date.now()}`);
const TEST_USER_ID = "usr_deletetest";

function nuke(): void {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}

beforeAll(() => {
  process.env.BONSAI_DATA_DIR = TEST_DATA_DIR;
  nuke();
});

afterAll(() => {
  nuke();
  delete process.env.BONSAI_DATA_DIR;
});

beforeEach(() => { nuke(); });
afterEach(() => { nuke(); });

function buildDeps(record: PendingRunForDelete | null) {
  const paths = userPaths(TEST_USER_ID);
  ensureUserDirs(paths);
  let pending = record;
  return {
    paths,
    deps: {
      paths,
      uploadDir: () => paths.uploadsDir,
      pendingPath: (runId: string) => join(paths.pendingDir, `${runId}.json`),
      loadPending: () => pending,
      savePending: (next: PendingRunForDelete) => { pending = next; },
    },
    getPending: () => pending,
  };
}

describe("deleteBillByRunId", () => {
  test("idempotent: deleted=false when pending record is missing", () => {
    const { deps } = buildDeps(null);
    const result = deleteBillByRunId("neverpersisted", deps);
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(false);
    expect(result.run_id).toBe("neverpersisted");
  });

  test("happy path: unlinks pending file, report, and appeal", () => {
    const runId = "run_abc123";
    const fixtureName = "memorial-hospital-2026-04";
    const record: PendingRunForDelete = {
      run_id: runId,
      fixture_name: fixtureName,
      status: "completed",
      bill_paths: [],
    };
    const { deps, paths } = buildDeps(record);

    const pendingFile = deps.pendingPath(runId);
    const reportFile = paths.reportPath(fixtureName);
    const appealFile = paths.appealPath(fixtureName);

    writeFileSync(pendingFile, JSON.stringify(record));
    mkdirSync(paths.reportsDir, { recursive: true });
    writeFileSync(reportFile, JSON.stringify({ summary: { outcome: "resolved" } }));
    writeFileSync(appealFile, "# Appeal letter");

    expect(existsSync(pendingFile)).toBe(true);
    expect(existsSync(reportFile)).toBe(true);
    expect(existsSync(appealFile)).toBe(true);

    const result = deleteBillByRunId(runId, deps);
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(true);
    expect(result.run_id).toBe(runId);

    expect(existsSync(pendingFile)).toBe(false);
    expect(existsSync(reportFile)).toBe(false);
    expect(existsSync(appealFile)).toBe(false);
  });

  test("flips status to cancelled before unlinking (so workers bail)", () => {
    const runId = "run_xyz789";
    const fixtureName = "city-clinic-2026-03";
    const record: PendingRunForDelete = {
      run_id: runId,
      fixture_name: fixtureName,
      status: "negotiating",
      bill_paths: [],
    };
    const { deps, getPending } = buildDeps(record);

    deleteBillByRunId(runId, deps);

    const final = getPending();
    expect(final?.status).toBe("cancelled");
    expect(final?.error).toBe("Deleted by user");
  });

  test("only unlinks bill_paths inside the user's uploads dir (no escape)", () => {
    const runId = "run_safe1";
    const fixtureName = "safe";
    const { paths, deps } = buildDeps({
      run_id: runId,
      fixture_name: fixtureName,
      status: "completed",
      bill_paths: [],
    });
    mkdirSync(paths.uploadsDir, { recursive: true });

    const inside = join(paths.uploadsDir, "uploaded.pdf");
    writeFileSync(inside, "PDF");
    const outside = join(TEST_DATA_DIR, "..", `escape-${process.pid}.txt`);
    writeFileSync(outside, "should NOT be deleted");

    const record = {
      run_id: runId,
      fixture_name: fixtureName,
      status: "completed",
      bill_paths: [inside, outside],
    } satisfies PendingRunForDelete;
    writeFileSync(deps.pendingPath(runId), JSON.stringify(record));
    deps.savePending(record);

    deleteBillByRunId(runId, deps);

    expect(existsSync(inside)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    rmSync(outside, { force: true });
  });
});
