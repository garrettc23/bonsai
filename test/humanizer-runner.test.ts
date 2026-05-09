import { describe, expect, test } from "bun:test";
import { humanize } from "../src/lib/humanizer.ts";
import type { LLMRequest, LLMResponse } from "../src/llm/provider.ts";

/**
 * Phase-2 wiring proof: the humanizer goes through callLLM and respects
 * an injected runner. test/setup.ts preloads BONSAI_DISABLE_HUMANIZER=1
 * for the rest of the suite — we unset it locally so the runner code
 * path actually executes.
 */
describe("humanize() routes through callLLM and respects runner injection", () => {
  test("uses the injected anthropic runner instead of hitting the real SDK", async () => {
    const prior = process.env.BONSAI_DISABLE_HUMANIZER;
    delete process.env.BONSAI_DISABLE_HUMANIZER;
    try {
      const captured: LLMRequest[] = [];
      const stub = async (req: LLMRequest): Promise<LLMResponse> => {
        captured.push(req);
        return {
          text: "",
          tool_use: {
            name: "humanize_email",
            input: { subject: "Re: dispute", body_markdown: "Short clean body." },
          },
        };
      };
      const result = await humanize({
        body: "Hello, [CLAIM NUMBER] dispute for $900.",
        subject: "Dispute",
        is_first_contact: true,
        user_name: "Test Patient",
        runners: { anthropic: stub },
      });
      expect(result.subject).toBe("Re: dispute");
      expect(result.body).toBe("Short clean body.");
      expect(captured).toHaveLength(1);
      // Skill frontmatter values should flow through unchanged.
      expect(captured[0]?.provider).toBe("anthropic");
      expect(captured[0]?.model).toBe("claude-opus-4-7");
      expect(captured[0]?.force_tool).toBe("humanize_email");
      // Skill-rendered system prompt must reach the runner.
      expect(captured[0]?.system).toContain("user selected: firm");
      expect(captured[0]?.system).toContain("Sign the email as: Test Patient");
    } finally {
      if (prior === undefined) delete process.env.BONSAI_DISABLE_HUMANIZER;
      else process.env.BONSAI_DISABLE_HUMANIZER = prior;
    }
  });

  test("falls back to the original draft when the runner errors", async () => {
    const prior = process.env.BONSAI_DISABLE_HUMANIZER;
    delete process.env.BONSAI_DISABLE_HUMANIZER;
    try {
      const stub = async (): Promise<LLMResponse> => {
        throw new Error("provider exploded");
      };
      const result = await humanize({
        body: "Original body that must survive.",
        subject: "Original subject",
        runners: { anthropic: stub },
      });
      expect(result.subject).toBe("Original subject");
      expect(result.body).toBe("Original body that must survive.");
    } finally {
      if (prior === undefined) delete process.env.BONSAI_DISABLE_HUMANIZER;
      else process.env.BONSAI_DISABLE_HUMANIZER = prior;
    }
  });
});
