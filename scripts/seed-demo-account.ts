#!/usr/bin/env bun
/**
 * Manual demo-account seeder. Thin wrapper over `seedDemoAccount()` in
 * src/lib/seed-demo.ts (which is where the data + logic live so the server
 * can also seed at boot — see SEED_DEMO_ACCOUNT in src/server.ts).
 *
 * Forces a full reseed (wipes + rewrites this one account's artifacts).
 *
 * Locally:  BONSAI_DATA_DIR=$(mktemp -d) bun run scripts/seed-demo-account.ts
 * In prod, prefer the env-var path (set SEED_DEMO_ACCOUNT=1 and redeploy) — but
 * this also works in-container: railway ssh -- bun run /app/scripts/seed-demo-account.ts
 */
import { seedDemoAccount, DEMO_EMAIL, DEMO_PASSWORD } from "../src/lib/seed-demo.ts";

console.log(`[seed] data root: ${process.env.BONSAI_DATA_DIR?.trim() || "<repo>/out"}`);

seedDemoAccount({ force: true })
  .then((r) => {
    console.log(`\n[seed] ${r.seeded ? "seeded" : "skipped (already present)"} — user ${r.userId}`);
    console.log(`[seed] sign in with Google (${DEMO_EMAIL}) or email ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  })
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  });
