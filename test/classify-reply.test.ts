import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  classifyReply,
  classifyReplyAsPrior,
  type ClassifyResult,
} from "../src/skills/_harness/run-classify-reply.ts";
import type { LLMRequest, LLMResponse } from "../src/llm/provider.ts";

const baseOpts = {
  latest_inbound: "We received your appeal. Manager will review in 5-7 business days.",
  prior_outbound: "Disputing the balance per the EOB.",
  bill_kind: "medical",
  floor_context: "floor=$100; original=$1000; eob_amount=$100",
};

describe("classifyReply — env gate", () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.BONSAI_CROSSMODAL;
    delete process.env.BONSAI_CROSSMODAL;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.BONSAI_CROSSMODAL;
    else process.env.BONSAI_CROSSMODAL = prior;
  });

  test("returns null without calling the runner when off", async () => {
    let calls = 0;
    const stub = async (): Promise<LLMResponse> => {
      calls++;
      return { text: "" };
    };
    const result = await classifyReply({ ...baseOpts, runners: { openai: stub } });
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("classifyReply — kind/confidence parsing", () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.BONSAI_CROSSMODAL;
    process.env.BONSAI_CROSSMODAL = "1";
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.BONSAI_CROSSMODAL;
    else process.env.BONSAI_CROSSMODAL = prior;
  });

  test("parses a well-formed classifier response", async () => {
    const stub = async (req: LLMRequest): Promise<LLMResponse> => {
      // The skill renders to gpt-5 + classify_reply force_tool — assert
      // the runner sees those.
      expect(req.provider).toBe("openai");
      expect(req.model).toBe("gpt-5");
      expect(req.force_tool).toBe("classify_reply");
      // The skill should have included the latest_inbound text in its
      // rendered system prompt.
      expect(req.system).toContain("We received your appeal");
      return {
        text: "",
        tool_use: {
          name: "classify_reply",
          input: {
            kind: "stall",
            confidence: "high",
            reasoning: "rep said 'manager will review in 5-7 business days'",
          },
        },
      };
    };
    const result = await classifyReply({ ...baseOpts, runners: { openai: stub } });
    expect(result?.kind).toBe("stall");
    expect(result?.confidence).toBe("high");
    expect(result?.reasoning).toContain("manager will review");
  });

  test("rejects unknown kinds → returns null", async () => {
    const stub = async (): Promise<LLMResponse> => ({
      text: "",
      tool_use: {
        name: "classify_reply",
        input: { kind: "totally_made_up", confidence: "high", reasoning: "x" },
      },
    });
    const result = await classifyReply({ ...baseOpts, runners: { openai: stub } });
    expect(result).toBeNull();
  });

  test("coerces unknown confidence to 'low'", async () => {
    const stub = async (): Promise<LLMResponse> => ({
      text: "",
      tool_use: {
        name: "classify_reply",
        input: { kind: "denial", confidence: "extreme", reasoning: "rep refused" },
      },
    });
    const result = await classifyReply({ ...baseOpts, runners: { openai: stub } });
    expect(result?.confidence).toBe("low");
  });

  test("missing reasoning → null", async () => {
    const stub = async (): Promise<LLMResponse> => ({
      text: "",
      tool_use: {
        name: "classify_reply",
        input: { kind: "denial", confidence: "high", reasoning: "" },
      },
    });
    const result = await classifyReply({ ...baseOpts, runners: { openai: stub } });
    expect(result).toBeNull();
  });

  test("runner error → null (fail-open)", async () => {
    const stub = async (): Promise<LLMResponse> => {
      throw new Error("openai 503");
    };
    const result = await classifyReply({ ...baseOpts, runners: { openai: stub } });
    expect(result).toBeNull();
  });
});

describe("classifyReplyAsPrior", () => {
  test("renders null as empty string", () => {
    expect(classifyReplyAsPrior(null)).toBe("");
  });

  test("renders a result as a non-directive prior block", () => {
    const result: ClassifyResult = {
      kind: "partial_concession",
      confidence: "medium",
      reasoning: "rep offered 3 months credit but the balance stands",
    };
    const block = classifyReplyAsPrior(result);
    expect(block).toContain("kind=partial_concession");
    expect(block).toContain("confidence=medium");
    expect(block).toContain("rep offered 3 months credit");
    expect(block).toContain("This is a prior, not a directive");
  });
});
