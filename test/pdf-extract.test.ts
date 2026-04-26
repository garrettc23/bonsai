/**
 * Smoke tests for `unpdf`-backed text extraction. Confirms the shipped
 * fixture PDF yields enough text to ground line_quote validation, and
 * that ScannedPdfError carries a stable `code` field the upload route
 * can branch on.
 *
 * Run: bun test test/pdf-extract.test.ts
 */
import { describe, expect, test } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPdfText, ScannedPdfError } from "../src/lib/pdf-extract.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

describe("extractPdfText", () => {
  test("extracts text from bill-001.pdf", async () => {
    const out = await extractPdfText(join(FIXTURES, "bill-001.pdf"));
    expect(out.totalPages).toBeGreaterThan(0);
    expect(out.pages.length).toBe(out.totalPages);
    expect(out.full.length).toBeGreaterThan(200);
    expect(out.full.toLowerCase()).toContain("balance");
  });
});

describe("ScannedPdfError", () => {
  test("exposes a stable code", () => {
    const err = new ScannedPdfError("nope");
    expect(err.code).toBe("SCANNED_PDF");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ScannedPdfError");
  });
});
