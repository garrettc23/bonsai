/**
 * GET /api/public-config returns the operator's public branding env vars
 * (support email + public domain) so the SPA + landing + error pages can
 * render the right "Contact" surface without a hardcoded address.
 *
 * Imports the real handler — server.ts itself can't be imported under
 * test (it calls Bun.serve at module scope), so the handler lives in
 * its own module.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handlePublicConfig, readPublicConfig } from "../src/lib/public-config.ts";

const ENV_KEYS = ["BONSAI_SUPPORT_EMAIL", "BONSAI_PUBLIC_DOMAIN"] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("/api/public-config", () => {
  test("returns nulls when both env vars are unset", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const res = handlePublicConfig();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ support_email: null, public_domain: null });
  });

  test("returns trimmed values when set", async () => {
    process.env.BONSAI_SUPPORT_EMAIL = "  support@example.com  ";
    process.env.BONSAI_PUBLIC_DOMAIN = " bonsai.example.com ";
    const res = handlePublicConfig();
    expect(await res.json()).toEqual({
      support_email: "support@example.com",
      public_domain: "bonsai.example.com",
    });
  });

  test("blank strings collapse to null (don't render an empty mailto)", () => {
    process.env.BONSAI_SUPPORT_EMAIL = "   ";
    process.env.BONSAI_PUBLIC_DOMAIN = "";
    expect(readPublicConfig()).toEqual({ support_email: null, public_domain: null });
  });
});
