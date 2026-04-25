/**
 * Integration tests for the integrations subsystem in user-settings.ts.
 *
 * Covers the new IntegrationsConfig surface added with the Connect-accounts
 * modal: getIntegrationsConfig, setIntegrationsConfig (with its
 * undefined-vs-empty-string semantics), and applyIntegrationsToEnv (which
 * pushes stored values into process.env so running services pick them up
 * without a server restart).
 *
 * The module computes SETTINGS_PATH from `import.meta.url` at load time, so
 * we can't redirect it via env vars. Instead we save and restore the real
 * `out/user-settings.json` around each test, plus snapshot/restore the
 * subset of process.env keys we mutate.
 *
 * Run: bun test test/user-settings.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyIntegrationsToEnv,
  getIntegrationsConfig,
  setIntegrationsConfig,
} from "../src/lib/user-settings.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SETTINGS_DIR = join(ROOT, "out");
const SETTINGS_PATH = join(SETTINGS_DIR, "user-settings.json");

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "RESEND_FROM_EMAIL",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_AGENT_ID",
  "ELEVENLABS_WEBHOOK_BASE",
] as const;

let originalFile: string | null = null;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function snapshotEnv(): void {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
}
function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}
function writeSettings(obj: unknown): void {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2));
}
function clearSettings(): void {
  if (existsSync(SETTINGS_PATH)) unlinkSync(SETTINGS_PATH);
}

beforeAll(() => {
  if (existsSync(SETTINGS_PATH)) {
    originalFile = readFileSync(SETTINGS_PATH, "utf-8");
  }
  snapshotEnv();
});

afterAll(() => {
  // Restore the user's real settings + env so the dev workspace is unchanged.
  if (originalFile !== null) writeSettings(JSON.parse(originalFile));
  else clearSettings();
  restoreEnv();
});

beforeEach(() => {
  clearSettings();
  clearEnv();
});

afterEach(() => {
  clearSettings();
  clearEnv();
});

describe("getIntegrationsConfig", () => {
  test("returns all-null shape on a missing settings file", () => {
    const cfg = getIntegrationsConfig();
    expect(cfg).toEqual({
      anthropic_api_key: null,
      resend_api_key: null,
      resend_from: null,
      elevenlabs_api_key: null,
      elevenlabs_agent_id: null,
      elevenlabs_webhook_base: null,
    });
  });

  test("returns all-null shape when integrations section is absent", () => {
    writeSettings({ profile: { first_name: "X" }, tune: { tone: "firm" } });
    const cfg = getIntegrationsConfig();
    expect(cfg.anthropic_api_key).toBeNull();
    expect(cfg.resend_from).toBeNull();
  });

  test("trims whitespace and treats whitespace-only as null", () => {
    writeSettings({
      integrations: {
        anthropic_api_key: "  sk-ant-abcdef  ",
        resend_from: "   ",
        elevenlabs_agent_id: "agent_xyz",
      },
    });
    const cfg = getIntegrationsConfig();
    expect(cfg.anthropic_api_key).toBe("sk-ant-abcdef");
    expect(cfg.resend_from).toBeNull();
    expect(cfg.elevenlabs_agent_id).toBe("agent_xyz");
  });
});

describe("setIntegrationsConfig — undefined-vs-empty-string semantics", () => {
  test("undefined for a key means 'no change' — preserves existing value", () => {
    writeSettings({
      integrations: { anthropic_api_key: "sk-ant-existing-key", resend_api_key: "re_existing" },
    });
    setIntegrationsConfig({ resend_from: "test@example.com" });
    const cfg = getIntegrationsConfig();
    expect(cfg.anthropic_api_key).toBe("sk-ant-existing-key");
    expect(cfg.resend_api_key).toBe("re_existing");
    expect(cfg.resend_from).toBe("test@example.com");
  });

  test("empty string clears the stored value", () => {
    writeSettings({
      integrations: { anthropic_api_key: "sk-ant-existing", resend_api_key: "re_existing" },
    });
    setIntegrationsConfig({ anthropic_api_key: "" });
    const cfg = getIntegrationsConfig();
    expect(cfg.anthropic_api_key).toBeNull();
    expect(cfg.resend_api_key).toBe("re_existing");
  });

  test("whitespace-only string clears the stored value (treated as empty)", () => {
    writeSettings({ integrations: { anthropic_api_key: "sk-ant-existing" } });
    setIntegrationsConfig({ anthropic_api_key: "   \t  " });
    const cfg = getIntegrationsConfig();
    expect(cfg.anthropic_api_key).toBeNull();
  });

  test("null clears the stored value (treated as empty after coalesce)", () => {
    writeSettings({ integrations: { anthropic_api_key: "sk-ant-existing" } });
    setIntegrationsConfig({ anthropic_api_key: null });
    const cfg = getIntegrationsConfig();
    expect(cfg.anthropic_api_key).toBeNull();
  });

  test("trims values before saving", () => {
    setIntegrationsConfig({ anthropic_api_key: "  sk-ant-with-padding  " });
    const cfg = getIntegrationsConfig();
    expect(cfg.anthropic_api_key).toBe("sk-ant-with-padding");
  });

  test("does not stomp unrelated profile/tune sections", () => {
    writeSettings({
      profile: { first_name: "Garrett", email: "g@example.com", authorized: true },
      tune: { tone: "aggressive", floor_pct: 30 },
    });
    setIntegrationsConfig({ anthropic_api_key: "sk-ant-new" });
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(raw.profile.first_name).toBe("Garrett");
    expect(raw.profile.authorized).toBe(true);
    expect(raw.tune.tone).toBe("aggressive");
    expect(raw.tune.floor_pct).toBe(30);
    expect(raw.integrations.anthropic_api_key).toBe("sk-ant-new");
  });

  test("setting all six keys round-trips correctly", () => {
    setIntegrationsConfig({
      anthropic_api_key: "sk-ant-a",
      resend_api_key: "re_b",
      resend_from: "Bonsai <a@b.com>",
      elevenlabs_api_key: "el_c",
      elevenlabs_agent_id: "agent_d",
      elevenlabs_webhook_base: "https://hooks.example.com",
    });
    const cfg = getIntegrationsConfig();
    expect(cfg).toEqual({
      anthropic_api_key: "sk-ant-a",
      resend_api_key: "re_b",
      resend_from: "Bonsai <a@b.com>",
      elevenlabs_api_key: "el_c",
      elevenlabs_agent_id: "agent_d",
      elevenlabs_webhook_base: "https://hooks.example.com",
    });
  });
});

describe("applyIntegrationsToEnv", () => {
  test("populates process.env from stored integrations", () => {
    writeSettings({
      integrations: {
        anthropic_api_key: "sk-ant-test",
        resend_api_key: "re_test",
        resend_from: "test@bonsai.local",
        elevenlabs_api_key: "el_test",
        elevenlabs_agent_id: "agent_test",
        elevenlabs_webhook_base: "https://hook.test",
      },
    });
    applyIntegrationsToEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(process.env.RESEND_API_KEY).toBe("re_test");
    expect(process.env.RESEND_FROM).toBe("test@bonsai.local");
    // resend_from is also mirrored to RESEND_FROM_EMAIL — two call sites read it.
    expect(process.env.RESEND_FROM_EMAIL).toBe("test@bonsai.local");
    expect(process.env.ELEVENLABS_API_KEY).toBe("el_test");
    expect(process.env.ELEVENLABS_AGENT_ID).toBe("agent_test");
    expect(process.env.ELEVENLABS_WEBHOOK_BASE).toBe("https://hook.test");
  });

  test("does not overwrite existing env when stored value is null", () => {
    // Simulate a fresh clone: .env populated, no stored UI overrides.
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-dotenv";
    writeSettings({ integrations: {} });
    applyIntegrationsToEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-from-dotenv");
  });

  test("stored value wins over pre-existing env value (UI override beats .env)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-dotenv";
    writeSettings({ integrations: { anthropic_api_key: "sk-ant-from-ui" } });
    applyIntegrationsToEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-from-ui");
  });

  test("setIntegrationsConfig calls applyIntegrationsToEnv as a side effect", () => {
    expect(process.env.RESEND_API_KEY).toBeUndefined();
    setIntegrationsConfig({ resend_api_key: "re_immediate" });
    expect(process.env.RESEND_API_KEY).toBe("re_immediate");
  });

  test("clearing a stored value via setIntegrationsConfig does not unset env (only writes when truthy)", () => {
    // Documented behavior: applyIntegrationsToEnv only writes truthy values.
    // Clearing a stored value lets a still-present .env value take effect on
    // the next process restart, but the live process.env is not cleared.
    process.env.RESEND_API_KEY = "re_from_dotenv";
    setIntegrationsConfig({ resend_api_key: "re_ui_override" });
    expect(process.env.RESEND_API_KEY).toBe("re_ui_override");
    setIntegrationsConfig({ resend_api_key: "" });
    // Stored value was cleared, but env was not unset.
    expect(getIntegrationsConfig().resend_api_key).toBeNull();
    expect(process.env.RESEND_API_KEY).toBe("re_ui_override");
  });
});

describe("getIntegrationsConfig — file corruption resilience", () => {
  test("returns all-null shape when settings file is malformed JSON", () => {
    mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, "{not valid json");
    const cfg = getIntegrationsConfig();
    expect(cfg.anthropic_api_key).toBeNull();
    expect(cfg.resend_from).toBeNull();
  });
});
