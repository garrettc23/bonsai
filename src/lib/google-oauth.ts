/**
 * Google OAuth 2.0 (OpenID Connect) helpers — authorization-code flow with
 * PKCE-style state for CSRF protection. Dependency-free: we exchange the
 * code server-to-server with the client_secret, then call Google's
 * userinfo endpoint with the access_token to read identity claims. No
 * JWT/JWKS verification needed because the access_token itself comes back
 * over a TLS connection where Google authenticated us via client_secret.
 *
 * Required env vars (server boots without them; Google sign-in just stays
 * disabled when missing):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 */
import { randomBytes } from "node:crypto";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const SCOPES = ["openid", "email", "profile"];

export interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

export class GoogleOAuthError extends Error {
  constructor(
    public code:
      | "not_configured"
      | "token_exchange_failed"
      | "userinfo_failed"
      | "email_not_verified",
    message: string,
  ) {
    super(message);
  }
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim(),
  );
}

/** Generate a high-entropy state string for the OAuth state cookie. */
export function newOAuthState(): string {
  return randomBytes(24).toString("hex");
}

/** Build the URL to redirect the browser to so Google can ask the user to consent. */
export function buildAuthorizeUrl(state: string, redirectUri: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) {
    throw new GoogleOAuthError("not_configured", "GOOGLE_CLIENT_ID is not set.");
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  id_token?: string;
}

/**
 * Exchange the authorization code Google sent us for an access token.
 * Server-to-server call authenticated by client_secret — never run this
 * in the browser.
 */
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new GoogleOAuthError("not_configured", "Google OAuth env vars are not set.");
  }
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GoogleOAuthError(
      "token_exchange_failed",
      `Google token exchange failed (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Read identity claims from Google. Returns the `sub` (stable per-Google-
 * account ID we key off of), the email, and whether Google considers the
 * email verified. We reject unverified emails — they could be attacker-
 * controlled and we use the email as a linking key against existing
 * password accounts.
 */
export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GoogleOAuthError(
      "userinfo_failed",
      `Google userinfo fetch failed (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  if (!data.sub || !data.email) {
    throw new GoogleOAuthError(
      "userinfo_failed",
      "Google userinfo response missing sub or email.",
    );
  }
  if (!data.email_verified) {
    throw new GoogleOAuthError(
      "email_not_verified",
      "Google reports this email as unverified.",
    );
  }
  return {
    sub: data.sub,
    email: data.email,
    email_verified: data.email_verified,
    name: data.name,
    picture: data.picture,
  };
}
