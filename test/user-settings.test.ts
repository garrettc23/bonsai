/**
 * Integration tests for the integrations subsystem in user-settings.ts.
 *
 * Covers the IntegrationsConfig surface backing the Connect-accounts modal:
 * getIntegrationsConfig, setIntegrationsConfig (with its undefined-vs-empty-
 * string semantics), and applyIntegrationsToEnv (which pushes stored values
 * into process.env so running services pick them up without a server
 * restart).
 *
 * Settings are now per-user, so every call sits inside `withUserContext`
 * with a fake user. The fake user's settings live at
 * `out/users/<test-id>/user-settings.json` — wiped between tests, and the
 * env-var subset we mutate is snapshot/restored around the suite.
 *
 * Run: bun test test/user-settings.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyIntegrationsToEnv,
  getIntegrationsConfig,
  setIntegrationsConfig,
} from "../src/lib/user-settings.ts";
import { withUserContext } from "../src/lib/user-context.ts";
import { userPaths } from "../src/lib/user-paths.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const TEST_USER = { id: "usr_settingstest_aaaaaaaaaaaa", email: "test@bonsai.local", created_at: 0 };
const TEST_PATHS = userPaths(TEST_USER.id);
const SETTINGS_PATH = TEST_PATHS.settingsPath;
const SETTINGS_DIR = TEST_PATHS.baseDir;

function withUser<T>(fn: () => T): T {
  return withUserContext(TEST_USER, fn);
}

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "RESEND_FROM_EMAIL",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_AGENT_ID",
  "ELEVENLABS_WEBHOOK_BASE",
] as const;

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
  if (existsSync(SETTINGS_DIR)) {
    rmSync(SETTINGS_DIR, { recursive: true, force: true });
  }
}

beforeAll(() => {
  snapshotEnv();
});

afterAll(() => {
  clearSettings();
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
    withUser(() => {
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
  });

  test("returns all-null shape when integrations section is absent", () => {
    writeSettings({ profile: { first_name: "X" }, tune: { tone: "firm" } });
    withUser(() => {
      const cfg = getIntegrationsConfig();
      expect(cfg.anthropic_api_key).toBeNull();
      expect(cfg.resend_from).toBeNull();
    });
  });

  test("trims whitespace and treats whitespace-only as null", () => {
    writeSettings({
      integrations: {
        anthropic_api_key: "  sk-ant-abcdef  ",
        resend_from: "   ",
        elevenlabs_agent_id: "agent_xyz",
      },
    });
    withUser(() => {
      const cfg = getIntegrationsConfig();
      expect(cfg.anthropic_api_key).toBe("sk-ant-abcdef");
      expect(cfg.resend_from).toBeNull();
      expect(cfg.elevenlabs_agent_id).toBe("agent_xyz");
    });
  });
});

describe("setIntegrationsConfig — undefined-vs-empty-string semantics", () => {
  test("undefined for a key means 'no change' — preserves existing value", () => {
    writeSettings({
      integrations: { anthropic_api_key: "sk-ant-existing-key", resend_api_key: "re_existing" },
    });
    withUser(() => {
      setIntegrationsConfig({ resend_from: "test@example.com" });
      const cfg = getIntegrationsConfig();
      expect(cfg.anthropic_api_key).toBe("sk-ant-existing-key");
      expect(cfg.resend_api_key).toBe("re_existing");
      expect(cfg.resend_from).toBe("test@example.com");
    });
  });

  test("empty string clears the stored value", () => {
    writeSettings({
      integrations: { anthropic_api_key: "sk-ant-existing", resend_api_key: "re_existing" },
    });
    withUser(() => {
      setIntegrationsConfig({ anthropic_api_key: "" });
      const cfg = getIntegrationsConfig();
      expect(cfg.anthropic_api_key).toBeNull();
      expect(cfg.resend_api_key).toBe("re_existing");
    });
  });

  test("whitespace-only string clears the stored value (treated as empty)", () => {
    writeSettings({ integrations: { anthropic_api_key: "sk-ant-existing" } });
    withUser(() => {
      setIntegrationsConfig({ anthropic_api_key: "   \t  " });
      const cfg = getIntegrationsConfig();
      expect(cfg.anthropic_api_key).toBeNull();
    });
  });

  test("null clears the stored value (treated as empty after coalesce)", () => {
    writeSettings({ integrations: { anthropic_api_key: "sk-ant-existing" } });
    withUser(() => {
      setIntegrationsConfig({ anthropic_api_key: null });
      const cfg = getIntegrationsConfig();
      expect(cfg.anthropic_api_key).toBeNull();
    });
  });

  test("trims values before saving", () => {
    withUser(() => {
      setIntegrationsConfig({ anthropic_api_key: "  sk-ant-with-padding  " });
      const cfg = getIntegrationsConfig();
      expect(cfg.anthropic_api_key).toBe("sk-ant-with-padding");
    });
  });

  test("does not stomp unrelated profile/tune sections", () => {
    writeSettings({
      profile: { first_name: "Garrett", email: "g@example.com", authorized: true },
      tune: { tone: "aggressive", floor_pct: 30 },
    });
    withUser(() => {
      setIntegrationsConfig({ anthropic_api_key: "sk-ant-new" });
    });
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(raw.profile.first_name).toBe("Garrett");
    expect(raw.profile.authorized).toBe(true);
    expect(raw.tune.tone).toBe("aggressive");
    expect(raw.tune.floor_pct).toBe(30);
    expect(raw.integrations.anthropic_api_key).toBe("sk-ant-new");
  });

  test("setting all six keys round-trips correctly", () => {
    withUser(() => {
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
    withUser(() => applyIntegrationsToEnv());
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
    withUser(() => applyIntegrationsToEnv());
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-from-dotenv");
  });

  test("stored value wins over pre-existing env value (UI override beats .env)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-dotenv";
    writeSettings({ integrations: { anthropic_api_key: "sk-ant-from-ui" } });
    withUser(() => applyIntegrationsToEnv());
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-from-ui");
  });

  test("setIntegrationsConfig calls applyIntegrationsToEnv as a side effect", () => {
    expect(process.env.RESEND_API_KEY).toBeUndefined();
    withUser(() => setIntegrationsConfig({ resend_api_key: "re_immediate" }));
    expect(process.env.RESEND_API_KEY).toBe("re_immediate");
  });

  test("clearing a stored value via setIntegrationsConfig does not unset env (only writes when truthy)", () => {
    // Documented behavior: applyIntegrationsToEnv only writes truthy values.
    // Clearing a stored value lets a still-present .env value take effect on
    // the next process restart, but the live process.env is not cleared.
    process.env.RESEND_API_KEY = "re_from_dotenv";
    withUser(() => setIntegrationsConfig({ resend_api_key: "re_ui_override" }));
    expect(process.env.RESEND_API_KEY).toBe("re_ui_override");
    withUser(() => setIntegrationsConfig({ resend_api_key: "" }));
    // Stored value was cleared, but env was not unset.
    expect(withUser(() => getIntegrationsConfig().resend_api_key)).toBeNull();
    expect(process.env.RESEND_API_KEY).toBe("re_ui_override");
  });
});

describe("getIntegrationsConfig — file corruption resilience", () => {
  test("returns all-null shape when settings file is malformed JSON", () => {
    mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, "{not valid json");
    withUser(() => {
      const cfg = getIntegrationsConfig();
      expect(cfg.anthropic_api_key).toBeNull();
      expect(cfg.resend_from).toBeNull();
    });
  });
});
