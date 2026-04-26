/**
 * Nightly volume backup — tarball of `BONSAI_DATA_DIR` to any S3-compatible
 * object store (Backblaze B2, Cloudflare R2, AWS S3, MinIO). Recovery from
 * a single disk fault on Railway depends on this; the volume itself isn't
 * snapshotted by default.
 *
 * Gated on four env vars: BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET,
 * BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY. If any is unset
 * the scheduler logs "[backup] disabled" and the server keeps running.
 *
 * Object key shape: `bonsai-backups/YYYY-MM-DD.tar.gz`. Idempotent within a
 * UTC day — re-running overwrites. Retention: anything older than 30 days
 * gets pruned by the same job.
 *
 * Streams `tar -czf -` directly to S3 via @aws-sdk/lib-storage's `Upload`,
 * which handles multipart for unknown-length streams. We never write the
 * tarball to local disk — Railway's `/app/data` volume is exactly the
 * thing we're backing up, so dumping a copy there would be circular.
 */
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import { dataRoot } from "./user-paths.ts";
import { getDb } from "./db.ts";

export interface BackupResult {
  key: string;
  bytes: number;
  took_ms: number;
}

export interface BackupConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const BACKUP_PREFIX = "bonsai-backups/";
const RETENTION_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function backupConfig(): BackupConfig | null {
  const endpoint = process.env.BACKUP_S3_ENDPOINT?.trim();
  const bucket = process.env.BACKUP_S3_BUCKET?.trim();
  const accessKeyId = process.env.BACKUP_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.BACKUP_S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

export function backupConfigured(): boolean {
  return backupConfig() !== null;
}

/** UTC-date string `YYYY-MM-DD` for `now`. Always read in UTC so two calls
 * straddling local midnight don't write to two different keys. */
export function utcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function makeS3Client(cfg: BackupConfig): S3Client {
  // forcePathStyle is required for B2 / MinIO and harmless on R2 + AWS.
  // region "auto" works for B2 / R2; AWS users can override via the
  // endpoint URL, which already encodes the region.
  return new S3Client({
    endpoint: cfg.endpoint,
    region: "auto",
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

/**
 * Spawn `tar` over the data directory, streaming gzipped output. Excludes
 * any nested `backups/` subdirectory so the tar doesn't grow unbounded if
 * an operator ever lands a backup file inside the volume itself.
 *
 * Exposed as a separate factory so tests can substitute a fake stream
 * without spawning a real process.
 */
export function spawnTarStream(srcDir: string): ReadableStream<Uint8Array> {
  const proc = Bun.spawn(["tar", "-czf", "-", "--exclude=./backups", "."], {
    cwd: srcDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  // Surface tar's stderr so a failure (e.g. permission denied) lands in
  // server logs alongside the [backup] FAILED line — without it the upload
  // silently produces an empty/short tar.
  void (async () => {
    try {
      const text = await new Response(proc.stderr).text();
      if (text.trim()) console.error("[backup] tar stderr:", text);
    } catch { /* ignore */ }
  })();
  return proc.stdout;
}

export interface UploadParams {
  bucket: string;
  key: string;
  body: Readable;
  contentType: string;
}

/** Default uploader — multipart-aware via @aws-sdk/lib-storage. Pulled out
 * as a function rather than inlined so tests can swap it for a stub that
 * doesn't need a real S3Client (lib-storage reaches into client.config
 * internals that a hand-rolled fake S3Client wouldn't have). */
async function defaultUpload(client: S3Client, params: UploadParams): Promise<void> {
  const upload = new Upload({
    client,
    params: {
      Bucket: params.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    },
  });
  await upload.done();
}

interface RunBackupDeps {
  client?: S3Client;
  streamFactory?: (srcDir: string) => ReadableStream<Uint8Array>;
  upload?: (client: S3Client, params: UploadParams) => Promise<void>;
  now?: () => Date;
  srcDir?: string;
}

export async function runNightlyBackup(deps: RunBackupDeps = {}): Promise<BackupResult> {
  const cfg = backupConfig();
  if (!cfg) throw new Error("[backup] runNightlyBackup called without BACKUP_S3_* env vars");
  const now = deps.now ? deps.now() : new Date();
  const date = utcDateKey(now);
  const key = `${BACKUP_PREFIX}${date}.tar.gz`;
  const srcDir = deps.srcDir ?? dataRoot();
  const client = deps.client ?? makeS3Client(cfg);
  const upload = deps.upload ?? defaultUpload;
  const start = Date.now();

  const tarStream = (deps.streamFactory ?? spawnTarStream)(srcDir);

  // Count bytes through a passthrough so we can log a real size on success
  // without buffering the whole tar in memory.
  let bytes = 0;
  const counted = tarStream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );

  // Bun's web ReadableStream → Node Readable so the AWS SDK accepts it.
  const body = Readable.fromWeb(counted as unknown as import("node:stream/web").ReadableStream);

  await upload(client, { bucket: cfg.bucket, key, body, contentType: "application/gzip" });
  const took_ms = Date.now() - start;
  recordBackupRun(date, bytes);
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  console.log(`[backup] uploaded ${key} ${mb}MB in ${took_ms}ms`);
  return { key, bytes, took_ms };
}

interface PruneDeps {
  client?: S3Client;
  now?: () => Date;
}

export async function pruneOldBackups(deps: PruneDeps = {}): Promise<{ deleted: number }> {
  const cfg = backupConfig();
  if (!cfg) return { deleted: 0 };
  const client = deps.client ?? makeS3Client(cfg);
  const now = deps.now ? deps.now() : new Date();
  const cutoffMs = now.getTime() - RETENTION_DAYS * ONE_DAY_MS;

  const list = await client.send(
    new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: BACKUP_PREFIX }),
  );
  const toDelete: { Key: string }[] = [];
  for (const obj of list.Contents ?? []) {
    if (!obj.Key) continue;
    const m = obj.Key.match(/^bonsai-backups\/(\d{4}-\d{2}-\d{2})\.tar\.gz$/);
    if (!m) continue;
    const objMs = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isFinite(objMs) && objMs < cutoffMs) {
      toDelete.push({ Key: obj.Key });
    }
  }
  if (toDelete.length === 0) return { deleted: 0 };
  await client.send(
    new DeleteObjectsCommand({
      Bucket: cfg.bucket,
      Delete: { Objects: toDelete },
    }),
  );
  console.log(`[backup] pruned ${toDelete.length} backups older than ${RETENTION_DAYS} days`);
  return { deleted: toDelete.length };
}

export function recordBackupRun(utc_date: string, bytes: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO backup_runs (utc_date, succeeded_at, bytes) VALUES (?, ?, ?)
     ON CONFLICT(utc_date) DO UPDATE SET succeeded_at = excluded.succeeded_at, bytes = excluded.bytes`,
  ).run(utc_date, Date.now(), bytes);
}

export function getLastSuccessfulBackup(): { utc_date: string; succeeded_at: number; bytes: number } | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT utc_date, succeeded_at, bytes FROM backup_runs ORDER BY succeeded_at DESC LIMIT 1`,
    )
    .get() as { utc_date: string; succeeded_at: number; bytes: number } | undefined;
  return row ?? null;
}
