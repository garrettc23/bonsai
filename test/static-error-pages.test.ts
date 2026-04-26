/**
 * Branded 404 / 500 page handling.
 *
 * Pins:
 *   - public/404.html and public/500.html exist with the right shell.
 *   - serveErrorPage returns text/html with the matching status.
 *   - isApiPath splits the catch block correctly so /api/* and /webhooks/*
 *     keep returning JSON 500s while page navigations get the HTML page.
 */
import { describe, expect, test } from "bun:test";
import { isApiPath, serveErrorPage } from "../src/lib/error-pages.ts";

describe("serveErrorPage", () => {
  test("404 → status 404, HTML, brand wordmark + 'Page not found' copy", async () => {
    const res = serveErrorPage("404", 404);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Page not found");
    expect(body).toContain("wordmark");
    expect(body).toContain("/api/public-config");
  });

  test("500 → status 500, HTML, 'Something broke' copy + retry button", async () => {
    const res = serveErrorPage("500", 500);
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Something broke");
    expect(body).toContain("error-retry");
    expect(body).toContain("/api/public-config");
  });
});

describe("isApiPath", () => {
  test("/api/* paths are API", () => {
    expect(isApiPath("/api/run")).toBe(true);
    expect(isApiPath("/api/public-config")).toBe(true);
  });

  test("/webhooks/* paths are API (JSON-only contract for webhook callers)", () => {
    expect(isApiPath("/webhooks/voice/dial")).toBe(true);
  });

  test("page navigations are not API", () => {
    expect(isApiPath("/")).toBe(false);
    expect(isApiPath("/app")).toBe(false);
    expect(isApiPath("/nonsense")).toBe(false);
    expect(isApiPath("/terms")).toBe(false);
  });
});
