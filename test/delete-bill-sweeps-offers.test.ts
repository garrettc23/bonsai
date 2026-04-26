/**
 * delete-bill cleanup: when a bill is deleted, every offer-hunt file
 * belonging to its run is unlinked too. Otherwise the Comparison view
 * keeps showing offers for a bill that no longer exists.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteBillByRunId, type DeleteBillDeps, type PendingRunForDelete } from "../src/lib/delete-bill.ts";
import type { UserPaths } from "../src/lib/user-paths.ts";

function setupTestPaths(): {
  paths: UserPaths;
  base: string;
  cleanup: () => void;
} {
  const base = join(tmpdir(), `bonsai-delete-${Date.now()}-${Math.random()}`);
  mkdirSync(base, { recursive: true });
  const paths: UserPaths = {
    baseDir: base,
    pendingDir: join(base, "pending"),
    threadsDir: join(base, "threads"),
    offersDir: join(base, "offers"),
    callsDir: join(base, "calls"),
    uploadsDir: join(base, "uploads"),
    reportsDir: join(base, "reports"),
    reportPath: (name: string) => join(base, "reports", `report-${name}.json`),
    appealPath: (name: string) => join(base, "reports", `appeal-${name}.md`),
  };
  for (const d of [paths.pendingDir, paths.threadsDir, paths.offersDir, paths.callsDir, paths.uploadsDir, paths.reportsDir]) {
    mkdirSync(d, { recursive: true });
  }
  return {
    paths,
    base,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describe("deleteBillByRunId offer-hunt sweep", () => {
  test("unlinks files whose run_id appears in the JSON body", () => {
    const { paths, cleanup } = setupTestPaths();
    try {
      const runId = "run_target";
      const otherId = "run_keep";
      writeFileSync(
        join(paths.offersDir, "1234-foo.json"),
        JSON.stringify({ run_id: runId, baseline: { label: "x" }, offers: [] }),
      );
      writeFileSync(
        join(paths.offersDir, "5678-bar.json"),
        JSON.stringify({ run_id: otherId, baseline: { label: "y" }, offers: [] }),
      );

      const store = new Map<string, PendingRunForDelete>();
      store.set(runId, { run_id: runId, fixture_name: "bill-target" });
      const deps: DeleteBillDeps = {
        loadPending: (id) => store.get(id) ?? null,
        savePending: (run) => store.set(run.run_id, run),
        pendingPath: (id) => join(paths.pendingDir, `${id}.json`),
        uploadDir: () => paths.uploadsDir,
        paths,
      };
      writeFileSync(join(paths.pendingDir, `${runId}.json`), "{}"); // so unlink doesn't no-op

      deleteBillByRunId(runId, deps);

      const remaining = readdirSync(paths.offersDir).sort();
      expect(remaining).toEqual(["5678-bar.json"]);
      cleanup();
    } catch (err) {
      cleanup();
      throw err;
    }
  });

  test("unlinks files whose run_id appears in the filename even with no readable JSON", () => {
    const { paths, cleanup } = setupTestPaths();
    try {
      const runId = "run_inFname";
      writeFileSync(join(paths.offersDir, `1234-${runId}-foo.json`), "not even json{{{");
      writeFileSync(
        join(paths.offersDir, "5678-other.json"),
        JSON.stringify({ run_id: "different", baseline: { label: "y" }, offers: [] }),
      );

      const store = new Map<string, PendingRunForDelete>();
      store.set(runId, { run_id: runId, fixture_name: "bill-fname" });
      const deps: DeleteBillDeps = {
        loadPending: (id) => store.get(id) ?? null,
        savePending: (run) => store.set(run.run_id, run),
        pendingPath: (id) => join(paths.pendingDir, `${id}.json`),
        uploadDir: () => paths.uploadsDir,
        paths,
      };
      writeFileSync(join(paths.pendingDir, `${runId}.json`), "{}");

      deleteBillByRunId(runId, deps);

      const remaining = readdirSync(paths.offersDir).sort();
      expect(remaining).toEqual(["5678-other.json"]);
      cleanup();
    } catch (err) {
      cleanup();
      throw err;
    }
  });

  test("leaves offer files for unrelated runs alone", () => {
    const { paths, cleanup } = setupTestPaths();
    try {
      writeFileSync(
        join(paths.offersDir, "1234-keep.json"),
        JSON.stringify({ run_id: "run_keep", baseline: { label: "x" }, offers: [] }),
      );

      const store = new Map<string, PendingRunForDelete>();
      store.set("run_target", { run_id: "run_target", fixture_name: "bill-target" });
      const deps: DeleteBillDeps = {
        loadPending: (id) => store.get(id) ?? null,
        savePending: (run) => store.set(run.run_id, run),
        pendingPath: (id) => join(paths.pendingDir, `${id}.json`),
        uploadDir: () => paths.uploadsDir,
        paths,
      };
      writeFileSync(join(paths.pendingDir, `run_target.json`), "{}");

      deleteBillByRunId("run_target", deps);

      expect(existsSync(join(paths.offersDir, "1234-keep.json"))).toBe(true);
      cleanup();
    } catch (err) {
      cleanup();
      throw err;
    }
  });
});
