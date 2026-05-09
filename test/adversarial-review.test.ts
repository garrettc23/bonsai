import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  adversarialReview,
  weakPointsToFeedback,
  type WeakPoint,
} from "../src/skills/_harness/run-adversarial-review.ts";
import type { LLMRequest, LLMResponse } from "../src/llm/provider.ts";

const baseOpts = {
  draft_subject: "Re: Appeal — please reduce balance",
  draft_body: "Per the EOB, patient responsibility is $100. Please reduce the balance accordingly.",
  bill_kind: "medical",
  prior_outbound: "Initial dispute documented in our prior letter.",
  latest_inbound: "We received your appeal. We're reviewing.",
  floor_context: "floor=$100; original=$1000",
};

describe("adversarialReview — env gate", () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.BONSAI_CROSSMODAL;
    delete process.env.BONSAI_CROSSMODAL;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.BONSAI_CROSSMODAL;
    else process.env.BONSAI_CROSSMODAL = prior;
  });

  test("when off, returns passed=true skipped=true and does not call the runner", async () => {
    let calls = 0;
    const stub = async (): Promise<LLMResponse> => {
      calls++;
      return { text: "" };
    };
    const result = await adversarialReview({ ...baseOpts, runners: { openai: stub } });
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("adversarialReview — passed/failed semantics", () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.BONSAI_CROSSMODAL;
    process.env.BONSAI_CROSSMODAL = "1";
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.BONSAI_CROSSMODAL;
    else process.env.BONSAI_CROSSMODAL = prior;
  });

  test("passes when there are no high-severity weak points", async () => {
    const stub = async (): Promise<LLMResponse> => ({
      text: "",
      tool_use: {
        name: "adversarial_report",
        input: {
          passed: true,
          weak_points: [
            { kind: "tone_mismatch", severity: "low", detail: "could be slightly firmer" },
          ],
        },
      },
    });
    const result = await adversarialReview({ ...baseOpts, runners: { openai: stub } });
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.weak_points).toHaveLength(1);
  });

  test("fails when there is at least one high-severity weak point, even if passed=true", async () => {
    // Even if the model says passed=true, a high-severity weak point
    // should be treated as failure. This is the safety guard against a
    // model that's too eager to pass things.
    const stub = async (): Promise<LLMResponse> => ({
      text: "",
      tool_use: {
        name: "adversarial_report",
        input: {
          passed: true,
          weak_points: [
            { kind: "weak_ask", severity: "high", detail: "no quantified ask anywhere" },
          ],
        },
      },
    });
    const result = await adversarialReview({ ...baseOpts, runners: { openai: stub } });
    expect(result.passed).toBe(false);
    expect(result.weak_points[0]?.severity).toBe("high");
  });

  test("skill render contains the draft body and the floor context", async () => {
    const stub = async (req: LLMRequest): Promise<LLMResponse> => {
      expect(req.provider).toBe("openai");
      expect(req.model).toBe("gpt-5");
      expect(req.force_tool).toBe("adversarial_report");
      expect(req.system).toContain("patient responsibility is $100");
      expect(req.system).toContain("floor=$100");
      return {
        text: "",
        tool_use: { name: "adversarial_report", input: { passed: true, weak_points: [] } },
      };
    };
    await adversarialReview({ ...baseOpts, runners: { openai: stub } });
  });
});

describe("adversarialReview — fail-open paths", () => {
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
      throw new Error("openai 500");
    };
    const result = await adversarialReview({ ...baseOpts, runners: { openai: stub } });
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
  });

  test("missing tool_use → passed=true skipped=true", async () => {
    const stub = async (): Promise<LLMResponse> => ({ text: "I refuse to use the tool" });
    const result = await adversarialReview({ ...baseOpts, runners: { openai: stub } });
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
  });

  test("invalid weak_points (unknown kind/severity) are filtered", async () => {
    const stub = async (): Promise<LLMResponse> => ({
      text: "",
      tool_use: {
        name: "adversarial_report",
        input: {
          passed: false,
          weak_points: [
            { kind: "made_up_kind", severity: "high", detail: "should be dropped" },
            { kind: "weak_ask", severity: "extreme", detail: "should also be dropped" },
            { kind: "weak_ask", severity: "high", detail: "this one should survive" },
          ],
        },
      },
    });
    const result = await adversarialReview({ ...baseOpts, runners: { openai: stub } });
    expect(result.weak_points).toHaveLength(1);
    expect(result.weak_points[0]?.detail).toBe("this one should survive");
  });
});

describe("weakPointsToFeedback", () => {
  test("renders 'passed' when there are no high-severity weak points", () => {
    expect(weakPointsToFeedback([])).toBe("Adversarial review passed.");
    const onlyMedium: WeakPoint[] = [{ kind: "weak_ask", severity: "medium", detail: "x" }];
    expect(weakPointsToFeedback(onlyMedium)).toBe("Adversarial review passed.");
  });

  test("renders only HIGH-severity weak points with the redraft instruction", () => {
    const wp: WeakPoint[] = [
      { kind: "weak_ask", severity: "high", detail: "no quantified ask" },
      { kind: "tone_mismatch", severity: "low", detail: "skip" },
      { kind: "easy_deflection", severity: "high", detail: "rep can stall on missing dates" },
    ];
    const feedback = weakPointsToFeedback(wp);
    expect(feedback).toContain("Adversarial review found high-severity");
    expect(feedback).toContain("1. [weak_ask]");
    expect(feedback).toContain("2. [easy_deflection]");
    expect(feedback).not.toContain("[tone_mismatch]");
    expect(feedback).toContain("Redraft the email");
  });
});
