/**
 * Google OAuth helpers + auth.ts additions.
 *
 * Covers the unit surface: config detection, authorize-URL shape, token
 * exchange (mocked), userinfo fetch (mocked), and the user-creation /
 * linking helpers added to auth.ts. Doesn't drive the full HTTP flow —
 * the route handlers inside server.ts are exercised manually before
 * shipping (see /ship's verification step).
 *
 * Run: bun test test/google-oauth.test.ts
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthError,
  createGoogleUser,
  createUser,
  getUserByEmail,
  getUserByGoogleSub,
  linkGoogleSub,
} from "../src/lib/auth.ts";
import { _resetDbForTest } from "../src/lib/db.ts";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchGoogleProfile,
  GoogleOAuthError,
  isGoogleOAuthConfigured,
  newOAuthState,
} from "../src/lib/google-oauth.ts";

const TEST_DB_DIR = join(tmpdir(), `bonsai-google-test-${process.pid}-${Date.now()}`);
const TEST_DB_PATH = join(TEST_DB_DIR, "bonsai.db");

function nukeOut(): void {
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  _resetDbForTest();
  mkdirSync(TEST_DB_DIR, { recursive: true });
}

beforeAll(() => {
  process.env.BONSAI_DB_PATH = TEST_DB_PATH;
  nukeOut();
});

afterAll(() => {
  nukeOut();
  delete process.env.BONSAI_DB_PATH;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

beforeEach(() => {
  nukeOut();
});

afterEach(() => {
  nukeOut();
});

describe("isGoogleOAuthConfigured", () => {
  test("false when neither env var is set", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(isGoogleOAuthConfigured()).toBe(false);
  });

  test("false when only one is set", () => {
    process.env.GOOGLE_CLIENT_ID = "id-only";
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(isGoogleOAuthConfigured()).toBe(false);
  });

  test("true when both are set", () => {
    process.env.GOOGLE_CLIENT_ID = "test-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    expect(isGoogleOAuthConfigured()).toBe(true);
  });
});

describe("buildAuthorizeUrl", () => {
  test("encodes the right params", () => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    const state = "abc123";
    const url = new URL(buildAuthorizeUrl(state, "https://example.com/cb"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/cb");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });

  test("throws not_configured when client id missing", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    expect(() => buildAuthorizeUrl("s", "https://example.com/cb")).toThrow(GoogleOAuthError);
  });
});

describe("newOAuthState", () => {
  test("returns hex of expected length and is unique per call", () => {
    const a = newOAuthState();
    const b = newOAuthState();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(b).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
});

describe("exchangeCodeForToken", () => {
  test("posts form-encoded creds and returns the JSON body", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://oauth2.googleapis.com/token");
      expect(init?.method).toBe("POST");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("code")).toBe("auth-code");
      expect(body.get("client_id")).toBe("test-client-id");
      expect(body.get("client_secret")).toBe("test-secret");
      expect(body.get("redirect_uri")).toBe("http://localhost:3333/api/auth/google/callback");
      expect(body.get("grant_type")).toBe("authorization_code");
      return new Response(
        JSON.stringify({
          access_token: "tok",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile",
          id_token: "id-jwt",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      const out = await exchangeCodeForToken(
        "auth-code",
        "http://localhost:3333/api/auth/google/callback",
      );
      expect(out.access_token).toBe("tok");
      expect(out.id_token).toBe("id-jwt");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("throws token_exchange_failed on non-2xx", async () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"error":"invalid_grant"}', { status: 400 }),
    );
    try {
      await expect(
        exchangeCodeForToken("bad", "http://localhost:3333/api/auth/google/callback"),
      ).rejects.toBeInstanceOf(GoogleOAuthError);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("fetchGoogleProfile", () => {
  test("returns the profile when email is verified", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://www.googleapis.com/oauth2/v3/userinfo");
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer tok");
      return new Response(
        JSON.stringify({
          sub: "google-sub-123",
          email: "alice@gmail.com",
          email_verified: true,
          name: "Alice",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    try {
      const profile = await fetchGoogleProfile("tok");
      expect(profile.sub).toBe("google-sub-123");
      expect(profile.email).toBe("alice@gmail.com");
      expect(profile.email_verified).toBe(true);
      expect(profile.name).toBe("Alice");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("rejects when email_verified is false", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ sub: "x", email: "y@z.com", email_verified: false }),
        { status: 200 },
      ),
    );
    try {
      await expect(fetchGoogleProfile("tok")).rejects.toMatchObject({
        code: "email_not_verified",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("rejects when userinfo response is missing required fields", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sub: "x" }), { status: 200 }),
    );
    try {
      await expect(fetchGoogleProfile("tok")).rejects.toMatchObject({ code: "userinfo_failed" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("rejects when userinfo HTTP call fails", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 401 }),
    );
    try {
      await expect(fetchGoogleProfile("tok")).rejects.toMatchObject({ code: "userinfo_failed" });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("createGoogleUser", () => {
  test("creates a fresh user with verified email, accepted terms, and google_sub", async () => {
    const u = await createGoogleUser("bob@gmail.com", "google-sub-bob");
    expect(u.email).toBe("bob@gmail.com");
    expect(u.email_verified_at).toBeGreaterThan(0);
    expect(u.accepted_terms_at).toBeGreaterThan(0);
    expect(u.google_sub).toBe("google-sub-bob");
  });

  test("normalizes email to lowercase + trim", async () => {
    const u = await createGoogleUser(" Carol@GMAIL.com ", "sub-c");
    expect(u.email).toBe("carol@gmail.com");
  });

  test("rejects when an account with that email already exists", async () => {
    await createUser("dave@gmail.com", "supersecret", { acceptedTerms: true });
    await expect(createGoogleUser("dave@gmail.com", "sub-d")).rejects.toBeInstanceOf(AuthError);
  });

  test("password login fails — Google-only users have an unguessable random hash", async () => {
    const { verifyCredentials } = await import("../src/lib/auth.ts");
    await createGoogleUser("eve@gmail.com", "sub-e");
    await expect(verifyCredentials("eve@gmail.com", "")).rejects.toBeInstanceOf(AuthError);
    await expect(verifyCredentials("eve@gmail.com", "password")).rejects.toBeInstanceOf(AuthError);
  });
});

describe("getUserByGoogleSub", () => {
  test("returns the user matching that sub", async () => {
    const created = await createGoogleUser("frank@gmail.com", "sub-frank");
    const found = getUserByGoogleSub("sub-frank");
    expect(found?.id).toBe(created.id);
  });

  test("returns null when no user matches", () => {
    expect(getUserByGoogleSub("does-not-exist")).toBeNull();
  });
});

describe("linkGoogleSub", () => {
  test("attaches a google_sub to an existing password user", async () => {
    const u = await createUser("greg@gmail.com", "supersecret", { acceptedTerms: true });
    expect(u.google_sub).toBeNull();
    const linked = linkGoogleSub(u.id, "sub-greg");
    expect(linked.google_sub).toBe("sub-greg");
    expect(getUserByGoogleSub("sub-greg")?.id).toBe(u.id);
  });

  test("marks email verified if it wasn't already", async () => {
    const u = await createUser("hank@gmail.com", "supersecret", { acceptedTerms: true });
    expect(u.email_verified_at).toBeNull();
    const linked = linkGoogleSub(u.id, "sub-hank");
    expect(linked.email_verified_at).toBeGreaterThan(0);
  });

  test("preserves existing email_verified_at timestamp", async () => {
    const u = await createGoogleUser("ivy@gmail.com", "sub-ivy");
    const ts = u.email_verified_at!;
    expect(ts).toBeGreaterThan(0);
    // Re-linking shouldn't move the timestamp.
    const linked = linkGoogleSub(u.id, "sub-ivy");
    expect(linked.email_verified_at).toBe(ts);
  });
});

describe("public-config google_oauth_enabled flag", () => {
  test("reflects env var presence", async () => {
    const { readPublicConfig } = await import("../src/lib/public-config.ts");
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(readPublicConfig().google_oauth_enabled).toBe(false);
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    expect(readPublicConfig().google_oauth_enabled).toBe(true);
  });
});
