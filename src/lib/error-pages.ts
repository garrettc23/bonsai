/**
 * Branded error-page server. Reads `public/404.html` / `public/500.html`
 * off disk and serves them with the right status. Falls back to plain
 * text only if the HTML file itself is missing — which would be a deploy
 * pipeline bug, not a runtime concern.
 *
 * Used by:
 *   - handleStatic in server.ts when no file matches the requested path
 *   - the top-level catch in server.ts for non-API uncaught errors
 *
 * API routes (anything under /api/* or /webhooks/*) keep returning JSON
 * 500s — only HTML page navigations get the branded page.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "..", "public");

export function serveErrorPage(name: "404" | "500", status: 404 | 500): Response {
  const fsPath = join(PUBLIC_DIR, `${name}.html`);
  if (!existsSync(fsPath)) {
    return new Response(name === "404" ? "Not found" : "Internal server error", {
      status,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response(readFileSync(fsPath), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
}

/**
 * The top-level catch in server.ts uses this to decide whether to render
 * the branded HTML 500 page or return a JSON error blob. Pulled out so the
 * branching logic is testable in isolation.
 */
export function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/webhooks/");
}
