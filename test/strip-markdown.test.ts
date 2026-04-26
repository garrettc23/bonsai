import { describe, expect, test } from "bun:test";
import { stripMarkdown } from "../src/lib/strip-markdown.ts";

describe("stripMarkdown", () => {
  test("removes ** bold runs", () => {
    expect(stripMarkdown("**hello**")).toBe("hello");
    expect(stripMarkdown("a **b** c")).toBe("a b c");
  });

  test("removes __ bold runs", () => {
    expect(stripMarkdown("__hello__")).toBe("hello");
    expect(stripMarkdown("a __b__ c")).toBe("a b c");
  });

  test("removes single-* italic at word boundaries", () => {
    expect(stripMarkdown("*italic*")).toBe("italic");
    expect(stripMarkdown("Use *italic* here.")).toBe("Use italic here.");
  });

  test("removes _italic_ at word boundaries", () => {
    expect(stripMarkdown("_italic_")).toBe("italic");
    expect(stripMarkdown("Use _italic_ here.")).toBe("Use italic here.");
  });

  test("preserves snake_case identifiers", () => {
    expect(stripMarkdown("claim_number")).toBe("claim_number");
    expect(stripMarkdown("Account_number_123 is fine")).toBe(
      "Account_number_123 is fine",
    );
    expect(stripMarkdown("ref claim_number on the EOB")).toBe(
      "ref claim_number on the EOB",
    );
  });

  test("strips ATX headings at line start", () => {
    expect(stripMarkdown("# Title")).toBe("Title");
    expect(stripMarkdown("## Heading")).toBe("Heading");
    expect(stripMarkdown("###### Six")).toBe("Six");
    expect(stripMarkdown("body line\n## Heading\nmore body")).toBe(
      "body line\nHeading\nmore body",
    );
  });

  test("strips leading > blockquote markers", () => {
    expect(stripMarkdown("> quoted")).toBe("quoted");
    expect(stripMarkdown(">no space")).toBe("no space");
    expect(stripMarkdown("line\n> quoted\nline")).toBe("line\nquoted\nline");
  });

  test("normalizes * and + bullets to -", () => {
    expect(stripMarkdown("* item one")).toBe("- item one");
    expect(stripMarkdown("+ item two")).toBe("- item two");
  });

  test("leaves - bullets alone", () => {
    expect(stripMarkdown("- already a hyphen bullet")).toBe(
      "- already a hyphen bullet",
    );
  });

  test("strips backtick fences and inline backticks", () => {
    expect(stripMarkdown("```\ncode\n```")).toBe("\ncode\n");
    expect(stripMarkdown("see `claim_number` field")).toBe(
      "see claim_number field",
    );
  });

  test("does not flag mid-word asterisks accidentally", () => {
    expect(stripMarkdown("rate*5*x")).toBe("rate*5*x");
  });

  test("idempotent: running twice equals running once", () => {
    const samples = [
      "**bold** and _italic_",
      "## Heading\n> quote\n* bullet\n- bullet",
      "claim_number stays, but **fix this** changes",
      "Hello,\n\nWe're disputing the $900 charge — see EOB.\n\nThanks,",
    ];
    for (const s of samples) {
      const once = stripMarkdown(s);
      expect(stripMarkdown(once)).toBe(once);
    }
  });

  test("realistic email body — no markdown survives", () => {
    const input = `Hello,

**We are disputing** the \`$900\` balance-billing charge on _claim_number_ CLM-001.

## Background
> The EOB shows in-network status.

* Per the No Surprises Act
* Patient responsibility is $100

Thanks,
Patient`;
    const out = stripMarkdown(input);
    expect(out).not.toContain("**");
    expect(out).not.toMatch(/^#+\s/m);
    expect(out).not.toMatch(/^>\s/m);
    expect(out).not.toMatch(/^\*\s/m);
    expect(out).not.toContain("`");
    expect(out).toContain("claim_number CLM-001");
  });
});
