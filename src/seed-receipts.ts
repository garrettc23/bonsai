/**
 * Cold-start receipts seed.
 *
 * The receipts dashboard on the overview page reads out/report-*.json files
 * and surfaces them as completed bills. On a fresh clone there are no
 * reports, so the dashboard sits empty — bad for demos. This module copies
 * pre-shipped fixtures from `fixtures/seed-receipts/*.json` into
 * `out/report-{name}.json` if the destination doesn't already exist.
 *
 * Idempotent — running it multiple times is a no-op once the files exist,
 * and it never overwrites a real run report.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SEED_DIR = join(ROOT, "fixtures", "seed-receipts");
const OUT_DIR = join(ROOT, "out");

export function seedReceipts(): { copied: string[]; skipped: string[] } {
  const copied: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(SEED_DIR)) return { copied, skipped };
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(SEED_DIR)) {
    if (!f.endsWith(".json")) continue;
    const name = f.replace(/\.json$/, "");
    const target = join(OUT_DIR, `report-${name}.json`);
    if (existsSync(target)) {
      skipped.push(name);
      continue;
    }
    const src = join(SEED_DIR, f);
    writeFileSync(target, readFileSync(src, "utf8"));
    copied.push(name);
  }
  return { copied, skipped };
}
