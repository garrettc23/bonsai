/**
 * Tiny .env loader — import FIRST in every entry script.
 *
 * Bun auto-loads .env in most shells, but not in all sandboxed environments,
 * so we do it explicitly. No dotenv dependency needed.
 *
 *   import "./env.ts"; // side-effect import, must come before anything
 *   else that reads process.env.*
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", ".env");

if (existsSync(ENV_PATH)) {
  const raw = readFileSync(ENV_PATH, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Set the value if the env var is unset OR empty. An empty-string env
    // var shouldn't mask a real .env value.
    const current = process.env[key];
    if (current == null || current === "") {
      process.env[key] = value;
    }
  }
}

/**
 * Fail fast on entry-point boot if a required env var is missing.
 *
 * Called explicitly from each entry point (server.ts, run-bonsai.ts,
 * scripts/day*.ts) — NOT from this file's import side-effect, so tests
 * that import modules transitively don't need keys set.
 */
export function validateRequiredEnv(): void {
  const missing: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    missing.push(
      "ANTHROPIC_API_KEY — sign up at https://console.anthropic.com and add the key to .env (Opus 4.7 requires a paid plan)",
    );
  }
  if (!process.env.BONSAI_PUBLIC_DOMAIN?.trim()) {
    missing.push(
      "BONSAI_PUBLIC_DOMAIN — set to your deployed domain, e.g. bonsai.example.com",
    );
  }
  if (missing.length === 0) return;
  console.error("\nBonsai cannot start — missing required environment variables:\n");
  for (const m of missing) console.error("  - " + m);
  console.error("\nCopy .env.example to .env and fill in the required keys, then try again.\n");
  process.exit(1);
}
