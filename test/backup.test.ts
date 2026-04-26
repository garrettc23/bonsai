/**
 * Nightly volume backup — mocked S3 client + injected tar stream so we
 * never spawn `tar` or hit the network.
 *
 * Pins:
 *   - backupConfigured() returns true iff all four env vars are non-empty.
 *   - runNightlyBackup() invokes the upload with the right key/bucket and
 *     records to SQLite on success.
 *   - pruneOldBackups() deletes only objects > 30 days old (parameterized
 *     "now" via dependency injection).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbForTest, getDb } from "../src/lib/db.ts";
import {
  backupConfigured,
  getLastSuccessfulBackup,
  pruneOldBackups,
  runNightlyBackup,
  utcDateKey,
} from "../src/lib/backup.ts";

const TEST_DIR = join(tmpdir(), `bonsai-backup-${process.pid}-${Date.now()}`);
const TEST_DB = join(TEST_DIR, "bonsai.db");

const ENV_KEYS = [
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ACCESS_KEY_ID",
  "BACKUP_S3_SECRET_ACCESS_KEY",
] as const;

function setBackupEnv() {
  process.env.BACKUP_S3_ENDPOINT = "https://s3.test.example.com";
  process.env.BACKUP_S3_BUCKET = "bonsai-backups";
  process.env.BACKUP_S3_ACCESS_KEY_ID = "AKIA_TEST";
  process.env.BACKUP_S3_SECRET_ACCESS_KEY = "secret_test";
}

function clearBackupEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeAll(() => {
  process.env.BONSAI_DB_PATH = TEST_DB;
  process.env.BONSAI_DATA_DIR = TEST_DIR;
});

afterAll(() => {
  delete process.env.BONSAI_DB_PATH;
  delete process.env.BONSAI_DATA_DIR;
  clearBackupEnv();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  _resetDbForTest();
  getDb();
  clearBackupEnv();
});

describe("backupConfigured", () => {
  test("false when any env var is missing", () => {
    expect(backupConfigured()).toBe(false);
    process.env.BACKUP_S3_ENDPOINT = "x";
    process.env.BACKUP_S3_BUCKET = "x";
    process.env.BACKUP_S3_ACCESS_KEY_ID = "x";
    expect(backupConfigured()).toBe(false);
  });

  test("true when all four are non-empty", () => {
    setBackupEnv();
    expect(backupConfigured()).toBe(true);
  });

  test("blank strings count as missing", () => {
    setBackupEnv();
    process.env.BACKUP_S3_ENDPOINT = "   ";
    expect(backupConfigured()).toBe(false);
  });
});

describe("utcDateKey", () => {
  test("formats as YYYY-MM-DD in UTC regardless of local TZ", () => {
    expect(utcDateKey(new Date("2026-04-26T23:59:59Z"))).toBe("2026-04-26");
    expect(utcDateKey(new Date("2026-04-27T00:00:01Z"))).toBe("2026-04-27");
  });
});

describe("runNightlyBackup", () => {
  test("uploads with the right key + records to SQLite on success", async () => {
    setBackupEnv();
    const uploads: { bucket: string; key: string; contentType: string; body: Buffer }[] = [];
    const fakeClient = {} as unknown as import("@aws-sdk/client-s3").S3Client;

    const fakeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
        controller.close();
      },
    });

    const fixedNow = new Date("2026-04-26T12:00:00Z");
    const result = await runNightlyBackup({
      client: fakeClient,
      streamFactory: () => fakeStream,
      upload: async (_client, params) => {
        // Drain the body so the byte counter sees the full payload.
        const chunks: Buffer[] = [];
        for await (const chunk of params.body) chunks.push(chunk as Buffer);
        uploads.push({
          bucket: params.bucket,
          key: params.key,
          contentType: params.contentType,
          body: Buffer.concat(chunks),
        });
      },
      now: () => fixedNow,
      srcDir: TEST_DIR,
    });

    expect(result.key).toBe("bonsai-backups/2026-04-26.tar.gz");
    expect(result.bytes).toBe(5);
    expect(result.took_ms).toBeGreaterThanOrEqual(0);

    expect(uploads.length).toBe(1);
    expect(uploads[0].bucket).toBe("bonsai-backups");
    expect(uploads[0].key).toBe("bonsai-backups/2026-04-26.tar.gz");
    expect(uploads[0].contentType).toBe("application/gzip");
    expect(uploads[0].body.length).toBe(5);

    const last = getLastSuccessfulBackup();
    expect(last?.utc_date).toBe("2026-04-26");
    expect(last?.bytes).toBe(5);
  });
});

describe("pruneOldBackups", () => {
  test("deletes objects with date prefix older than 30 days, keeps newer ones", async () => {
    setBackupEnv();
    const fixedNow = new Date("2026-04-26T00:00:00Z");
    const listed = [
      // > 30 days old → delete
      { Key: "bonsai-backups/2026-03-26.tar.gz" },
      { Key: "bonsai-backups/2026-03-25.tar.gz" },
      { Key: "bonsai-backups/2025-12-01.tar.gz" },
      // exactly 30 days old → keep (cutoff is strict <)
      { Key: "bonsai-backups/2026-03-27.tar.gz" },
      // newer → keep
      { Key: "bonsai-backups/2026-04-26.tar.gz" },
      { Key: "bonsai-backups/2026-04-15.tar.gz" },
      // wrong shape → ignore
      { Key: "bonsai-backups/manifest.json" },
    ];
    const deleteCalls: { Key: string }[][] = [];
    const fakeClient = {
      send: async (cmd: { constructor: { name: string }; input?: { Delete?: { Objects?: { Key: string }[] } } }) => {
        if (cmd.constructor.name === "ListObjectsV2Command") {
          return { Contents: listed };
        }
        if (cmd.constructor.name === "DeleteObjectsCommand") {
          deleteCalls.push(cmd.input?.Delete?.Objects ?? []);
          return {};
        }
        throw new Error("unexpected command: " + cmd.constructor.name);
      },
    } as unknown as import("@aws-sdk/client-s3").S3Client;

    const result = await pruneOldBackups({ client: fakeClient, now: () => fixedNow });
    expect(result.deleted).toBe(3);
    expect(deleteCalls.length).toBe(1);
    const keys = deleteCalls[0].map((o) => o.Key).sort();
    expect(keys).toEqual([
      "bonsai-backups/2025-12-01.tar.gz",
      "bonsai-backups/2026-03-25.tar.gz",
      "bonsai-backups/2026-03-26.tar.gz",
    ]);
  });

  test("no-op when nothing to delete", async () => {
    setBackupEnv();
    const fakeClient = {
      send: async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === "ListObjectsV2Command") return { Contents: [] };
        throw new Error("should not delete");
      },
    } as unknown as import("@aws-sdk/client-s3").S3Client;

    const result = await pruneOldBackups({ client: fakeClient, now: () => new Date("2026-04-26T00:00:00Z") });
    expect(result.deleted).toBe(0);
  });

  test("returns { deleted: 0 } when not configured (don't crash)", async () => {
    clearBackupEnv();
    const result = await pruneOldBackups();
    expect(result.deleted).toBe(0);
  });
});
