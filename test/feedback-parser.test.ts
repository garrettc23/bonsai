/**
 * Unit tests for feedback-parser — the regex-based translator from free-text
 * user feedback ("stop being aggressive, email only") into structured
 * directives (channel gates + tone overrides) the negotiation agent honors.
 *
 * Pure logic, no I/O, no Claude calls — cheap to exhaustively cover.
 *
 * Run: bun test
 */
import { describe, expect, test } from "bun:test";
import {
  parseFeedbackDirectives,
  toneGuidance,
} from "../src/lib/feedback-parser.ts";

describe("parseFeedbackDirectives — channel exclusives", () => {
  test('"email only" gates out sms and voice', () => {
    const d = parseFeedbackDirectives(["email only, please"]);
    expect(d.channels).toEqual({ email: true, sms: false, voice: false });
  });

  test('"only email" matches same as "email only"', () => {
    const d = parseFeedbackDirectives(["only email from now on"]);
    expect(d.channels).toEqual({ email: true, sms: false, voice: false });
  });

  test('"sms only" gates out email and voice', () => {
    const d = parseFeedbackDirectives(["sms only"]);
    expect(d.channels).toEqual({ email: false, sms: true, voice: false });
  });

  test('"only texts" is treated as sms only', () => {
    const d = parseFeedbackDirectives(["only texts going forward"]);
    expect(d.channels).toEqual({ email: false, sms: true, voice: false });
  });

  test('"voice only" gates out email and sms', () => {
    const d = parseFeedbackDirectives(["phone only please"]);
    expect(d.channels).toEqual({ email: false, sms: false, voice: true });
  });

  test("exclusive overrides any individual 'no X' in the same feedback", () => {
    // "email only" should win and set all three, not leave voice/sms as just undefined.
    const d = parseFeedbackDirectives(["email only, no calls"]);
    expect(d.channels).toEqual({ email: true, sms: false, voice: false });
  });
});

describe("parseFeedbackDirectives — channel negatives (non-exclusive)", () => {
  test('"no calls" disables voice only, leaves others unspecified', () => {
    const d = parseFeedbackDirectives(["no calls please"]);
    expect(d.channels).toEqual({ voice: false });
  });

  test('"stop texting" disables sms only', () => {
    const d = parseFeedbackDirectives(["stop texting me"]);
    expect(d.channels).toEqual({ sms: false });
  });

  test("don't email (with apostrophe) disables email only", () => {
    const d = parseFeedbackDirectives(["don't email them anymore"]);
    expect(d.channels).toEqual({ email: false });
  });

  test("multiple negatives stack", () => {
    const d = parseFeedbackDirectives(["no calls and no texts"]);
    expect(d.channels).toEqual({ voice: false, sms: false });
  });

  test("feedback with no channel signals leaves channels undefined", () => {
    const d = parseFeedbackDirectives(["just keep going"]);
    expect(d.channels).toBeUndefined();
  });
});

describe("parseFeedbackDirectives — tone", () => {
  test('"stop being aggressive" → polite', () => {
    expect(parseFeedbackDirectives(["stop being aggressive"]).tone).toBe("polite");
  });

  test('"tone it down" → polite', () => {
    expect(parseFeedbackDirectives(["tone it down a bit"]).tone).toBe("polite");
  });

  test('"be nicer" → polite', () => {
    expect(parseFeedbackDirectives(["be nicer to the rep"]).tone).toBe("polite");
  });

  test('"push harder" → aggressive', () => {
    expect(parseFeedbackDirectives(["push harder on them"]).tone).toBe("aggressive");
  });

  test('"hardball" → aggressive', () => {
    expect(parseFeedbackDirectives(["time for hardball"]).tone).toBe("aggressive");
  });

  test('"be firm" → firm', () => {
    expect(parseFeedbackDirectives(["be firm but fair"]).tone).toBe("firm");
  });

  test("polite cue wins when both stop-aggressive and firm appear", () => {
    // Polite is checked first and should win here (regex order defines priority).
    const d = parseFeedbackDirectives(["stop being aggressive and be firm"]);
    expect(d.tone).toBe("polite");
  });

  test("no tone cues → tone undefined", () => {
    expect(parseFeedbackDirectives(["email only"]).tone).toBeUndefined();
  });
});

describe("parseFeedbackDirectives — notes preservation", () => {
  test("preserves trimmed, non-empty lines", () => {
    const d = parseFeedbackDirectives(["  hi there  ", "", "  ", "second line"]);
    expect(d.notes).toEqual(["hi there", "second line"]);
  });

  test("empty input → empty notes, no channels, no tone", () => {
    const d = parseFeedbackDirectives([]);
    expect(d).toEqual({ notes: [] });
  });

  test("combined feedback: tone + channel + free-form note in one string", () => {
    const d = parseFeedbackDirectives([
      "stop being aggressive, email only, and don't mention hardship yet",
    ]);
    expect(d.tone).toBe("polite");
    expect(d.channels).toEqual({ email: true, sms: false, voice: false });
    expect(d.notes).toHaveLength(1);
    expect(d.notes[0]).toContain("don't mention hardship");
  });

  test("directives scan across multiple feedback lines (joined with newlines)", () => {
    const d = parseFeedbackDirectives(["be nicer", "no calls"]);
    expect(d.tone).toBe("polite");
    expect(d.channels).toEqual({ voice: false });
  });
});

describe("toneGuidance", () => {
  test("polite guidance mentions gratitude/cooperation", () => {
    const g = toneGuidance("polite");
    expect(g.toLowerCase()).toContain("gratitude");
  });

  test("aggressive guidance mentions short deadlines", () => {
    const g = toneGuidance("aggressive");
    expect(g).toMatch(/7 days/);
  });

  test("firm guidance is the fallback (non-empty, not the polite/aggressive copy)", () => {
    const g = toneGuidance("firm");
    expect(g.length).toBeGreaterThan(0);
    expect(g.toLowerCase()).not.toContain("gratitude");
    expect(g).not.toMatch(/7 days/);
  });
});
