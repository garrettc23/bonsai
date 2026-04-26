/**
 * Idempotent delete for a per-user bill (audit + report + appeal +
 * uploads). Lifted out of server.ts so the unit test can exercise the
 * logic without booting the whole HTTP server (which fails fast on a
 * missing ANTHROPIC_API_KEY).
 *
 * Server.ts wires this up with the real on-disk helpers; the test
 * provides its own helpers + paths for hermetic execution.
 */
import { existsSync, unlinkSync } from "node:fs";
import type { UserPaths } from "./user-paths.ts";

export interface PendingRunForDelete {
  run_id: string;
  fixture_name: string;
  status?: string;
  error?: string;
  bill_paths?: string[];
  eob_path?: string;
}

export interface DeleteBillDeps<R extends PendingRunForDelete = PendingRunForDelete> {
  loadPending: (runId: string) => R | null;
  savePending: (run: R) => void;
  pendingPath: (runId: string) => string;
  uploadDir: () => string;
  paths: UserPaths;
}

export interface DeleteBillResult {
  ok: true;
  run_id: string;
  deleted: boolean;
}

export function deleteBillByRunId<R extends PendingRunForDelete>(
  runId: string,
  deps: DeleteBillDeps<R>,
): DeleteBillResult {
  const run = deps.loadPending(runId);
  // Idempotent: if the pending record is gone (already deleted, race,
  // never persisted), there's nothing to clean up server-side. The
  // client-side optimistic UI has already removed the row — returning
  // 200 keeps the two views in sync.
  if (!run) return { ok: true, run_id: runId, deleted: false };

  // Flip status so any in-flight worker bails out before writing anything.
  run.status = "cancelled";
  run.error = "Deleted by user";
  deps.savePending(run);

  const tryUnlink = (p: string): void => {
    if (existsSync(p)) {
      try { unlinkSync(p); } catch (err) { console.warn("[delete] unlink failed", p, err); }
    }
  };

  tryUnlink(deps.pendingPath(run.run_id));
  tryUnlink(deps.paths.reportPath(run.fixture_name));
  tryUnlink(deps.paths.appealPath(run.fixture_name));
  // Original uploads — scoped strictly to this run's recorded paths and
  // confined to the user's uploads dir so a malformed run can't unlink
  // arbitrary files.
  const uploadRoot = deps.uploadDir();
  for (const p of run.bill_paths ?? []) {
    if (p.startsWith(uploadRoot)) tryUnlink(p);
  }
  if (run.eob_path && run.eob_path.startsWith(uploadRoot)) tryUnlink(run.eob_path);

  return { ok: true, run_id: run.run_id, deleted: true };
}
