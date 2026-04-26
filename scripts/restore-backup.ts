#!/usr/bin/env bun
/**
 * Manual restore helper. Downloads a single nightly backup tarball from S3
 * and validates it looks like a Bonsai data dir (`bonsai.db` + `users/`
 * entries present). Never auto-extracts — restoring wipes live data, so
 * the operator runs the final `tar -xzf` themselves.
 *
 * Usage:
 *   bun run scripts/restore-backup.ts latest
 *   bun run scripts/restore-backup.ts 2026-04-26
 *
 * Requires the four BACKUP_S3_* env vars (see .env.example).
 */
import "../src/env.ts";
import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { backupConfig, makeS3Client } from "../src/lib/backup.ts";
import { dataRoot } from "../src/lib/user-paths.ts";

const BACKUP_PREFIX = "bonsai-backups/";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: bun run scripts/restore-backup.ts <YYYY-MM-DD | latest>");
    process.exit(1);
  }
  const cfg = backupConfig();
  if (!cfg) {
    console.error(
      "BACKUP_S3_* env vars not set. Need BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY.",
    );
    process.exit(1);
  }
  const client = makeS3Client(cfg);

  let key: string;
  if (arg === "latest") {
    const list = await client.send(
      new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: BACKUP_PREFIX }),
    );
    const candidates = (list.Contents ?? [])
      .map((o) => o.Key ?? "")
      .filter((k) => /^bonsai-backups\/\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(k))
      .sort();
    if (candidates.length === 0) {
      console.error(`No backups found under s3://${cfg.bucket}/${BACKUP_PREFIX}`);
      process.exit(1);
    }
    key = candidates[candidates.length - 1];
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      console.error(`Bad date "${arg}" — expected YYYY-MM-DD or "latest"`);
      process.exit(1);
    }
    key = `${BACKUP_PREFIX}${arg}.tar.gz`;
  }

  const restoreDir = join(dataRoot(), "..", "restore");
  mkdirSync(restoreDir, { recursive: true });
  const localPath = join(restoreDir, key.split("/").pop()!);

  console.log(`Downloading s3://${cfg.bucket}/${key} → ${localPath}`);
  const got = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  if (!got.Body) {
    console.error("Empty body from S3 GetObject");
    process.exit(1);
  }
  const body = got.Body as unknown as Readable;
  await pipeline(body, createWriteStream(localPath));

  console.log("Validating tar contents...");
  const entries: string[] = await new Promise((resolve, reject) => {
    const proc = spawn("tar", ["-tzf", localPath]);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`tar -tzf exited ${code}: ${err}`));
      else resolve(out.split("\n").filter(Boolean));
    });
  });

  const hasDb = entries.some((e) => e.includes("bonsai.db"));
  const hasUsers = entries.some((e) => e.startsWith("./users/") || e === "./users/" || e.startsWith("users/"));
  if (!hasDb) {
    console.error("VALIDATION FAILED: tar does not contain bonsai.db");
    process.exit(1);
  }
  if (!hasUsers) {
    console.error("VALIDATION FAILED: tar does not contain a users/ directory");
    process.exit(1);
  }

  const target = process.env.BONSAI_DATA_DIR?.trim() || "/app/data";
  console.log(`OK — ${entries.length} entries, includes bonsai.db + users/.`);
  console.log("");
  console.log("Manual restore (DESTRUCTIVE — wipes the target dir):");
  console.log(`  rm -rf ${target}/*`);
  console.log(`  tar -xzf ${localPath} -C ${target}`);
  console.log("");
  console.log("Skipped automatically — restore wipes live data and should be a deliberate human action.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
