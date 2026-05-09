import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  factCheck,
  violationsToFeedback,
  type FactCheckViolation,
} from "../src/skills/_harness/run-fact-check.ts";
import type { LLMRequest, LLMResponse } from "../src/llm/provider.ts";

const baseOpts = {
  draft_subject: "Re: dispute on claim CLM-001",
  draft_body: "We're disputing the $900 balance-billing charge per the EOB.",
  preserve_facts: [
    "Claim number: CLM-001",
    'Disputed line ($900.00): "Balance billing for OON anesthesia"',
  ],
};

describe("factCheck — env gate (BONSAI_CROSSMODAL)", () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.BONSAI_CROSSMODAL;
    delete process.env.BONSAI_CROSSMODAL;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.BONSAI_CROSSMODAL;
    else process.env.BONSAI_CROSSMODAL = prior;
  });

  test("when off, returns passed=true skipped=true without calling the runner", async () => {
    let openaiCalls = 0;
    const stub = async (): Promise<LLMResponse> => {
      openaiCalls++;
      return { text: "" };
    };
    const result = await factCheck({ ...baseOpts, runners: { openai: stub } });
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.violations).toEqual([]);
    expect(openaiCalls).toBe(0);
  });

  test("when on, the runner IS called and the report is parsed", async () => {
    process.env.BONSAI_CROSSMODAL = "1";
    const captured: LLMRequest[] = [];
    const stub = async (req: LLMRequest): Promise<LLMResponse> => {
      captured.push(req);
      return {
        text: "",
        tool_use: {
          name: "fact_check_report",
          input: { passed: true, violations: [] },
        },
      };
    };
    const result = await factCheck({ ...baseOpts, runners: { openai: stub } });
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.provider).toBe("openai");
    expect(captured[0]?.model).toBe("gpt-5");
    expect(captured[0]?.force_tool).toBe("fact_check_report");
    // Skill-rendered system prompt must include the facts and the
    // draft body so the model can actually verify.
    expect(captured[0]?.system).toContain("CLM-001");
    expect(captured[0]?.system).toContain("Balance billing for OON anesthesia");
    expect(captured[0]?.system).toContain("$900 balance-billing charge");
  });
});

describe("factCheck — violation parsing", () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.BONSAI_CROSSMODAL;
    process.env.BONSAI_CROSSMODAL = "1";
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.BONSAI_CROSSMODAL;
    else process.env.BONSAI_CROSSMODAL = prior;
  });

  test("parses a passed=false report with multiple violations", async () => {
    const stub = async (): Promise<LLMResponse> => ({
      text: "",
      tool_use: {
        name: "fact_check_report",
        input: {
          passed: false,
          violations: [
            { kind: "fabricated", detail: "Draft mentions claim CLM-002 but the analyzer has CLM-001." },
            { kind: "wrong_amount", detail: "Draft says $9,000 but the analyzer fact is $900." },
          ],
        },
      },
    });
    const result = await factCheck({ ...baseOpts, runners: { openai: stub } });
    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]?.kind).toBe("fabricated");
    expect(result.violations[1]?.kind).toBe("wrong_amount");
  });

  test("coerces unknown violation kinds to 'other'", async () => {
    const stub = async (): Promise<LLMResponse> => ({
      text: "",
      tool_use: {
        name: "fact_check_report",
        input: {
          passed: false,
          violations: [{ kind: "totally_made_up_kind", detail: "Some issue." }],
        },
      },
    });
    const result = await factCheck({ ...baseOpts, runners: { openai: stub } });
    expect(result.violations[0]?.kind).toBe("other");
  });

  test("drops violations without a detail field", async () => {
    const stub = async (): Promise<LLMResponse> => ({
      text: "",
      tool_use: {
        name: "fact_check_report",
        input: {
          passed: false,
          violations: [
            { kind: "fabricated" }, // no detail → drop
            { kind: "wrong_amount", detail: "Wrong by $100." },
          ],
        },
      },
    });
    const result = await factCheck({ ...baseOpts, runners: { openai: stub } });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe("wrong_amount");
  });
});

describe("factCheck — fail-open behavior", () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.BONSAI_CROSSMODAL;
    process.env.BONSAI_CROSSMODAL = "1";
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.BONSAI_CROSSMODAL;
    else process.env.BONSAI_CROSSMODAL = prior;
  });

  test("runner error → passed=true skipped=true", async () => {
    const stub = async (): Promise<LLMResponse> => {
      throw new Error("openai down");
    };
    const result = await factCheck({ ...baseOpts, runners: { openai: stub } });
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
  });

  test("missing tool_use in response → passed=true skipped=true", async () => {
    const stub = async (): Promise<LLMResponse> => ({ text: "I refuse to use the tool" });
    const result = await factCheck({ ...baseOpts, runners: { openai: stub } });
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
  });
});

describe("violationsToFeedback", () => {
  test("renders the empty list as 'passed'", () => {
    expect(violationsToFeedback([])).toBe("Fact-check passed.");
  });

  test("renders violations as a numbered list with the redraft instruction", () => {
    const violations: FactCheckViolation[] = [
      { kind: "fabricated", detail: "Invented claim number CLM-999." },
      { kind: "missing_fact", detail: "Did not cite the EOB amount." },
    ];
    const out = violationsToFeedback(violations);
    expect(out).toContain("Fact-check failed");
    expect(out).toContain("1. [fabricated] Invented claim number CLM-999.");
    expect(out).toContain("2. [missing_fact] Did not cite the EOB amount.");
    expect(out).toContain("Redraft the email and call send_email again");
  });
});
