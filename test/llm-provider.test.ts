import { describe, expect, test } from "bun:test";
import { callLLM, type LLMRequest, type LLMResponse } from "../src/llm/provider.ts";

const baseReq: LLMRequest = {
  provider: "anthropic",
  model: "claude-opus-4-7",
  max_tokens: 100,
  system: "you are a test",
  user: "hello",
};

describe("callLLM dispatch", () => {
  test("routes anthropic requests to the anthropic runner", async () => {
    const captured: LLMRequest[] = [];
    const stub = async (req: LLMRequest): Promise<LLMResponse> => {
      captured.push(req);
      return { text: "from anthropic" };
    };
    const resp = await callLLM(baseReq, { anthropic: stub });
    expect(resp.text).toBe("from anthropic");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.provider).toBe("anthropic");
  });

  test("routes openai requests to the openai runner", async () => {
    const captured: LLMRequest[] = [];
    const stub = async (req: LLMRequest): Promise<LLMResponse> => {
      captured.push(req);
      return { text: "from openai" };
    };
    const resp = await callLLM(
      { ...baseReq, provider: "openai", model: "gpt-5" },
      { openai: stub },
    );
    expect(resp.text).toBe("from openai");
    expect(captured[0]?.provider).toBe("openai");
  });

  test("the wrong-provider runner is not called", async () => {
    let openaiCalls = 0;
    const stub = async (): Promise<LLMResponse> => {
      openaiCalls++;
      return { text: "" };
    };
    await callLLM(baseReq, {
      anthropic: async () => ({ text: "ok" }),
      openai: stub,
    });
    expect(openaiCalls).toBe(0);
  });

  test("normalized response shape: tool_use is optional, text always present", async () => {
    const stub = async (): Promise<LLMResponse> => ({
      text: "",
      tool_use: { name: "do_thing", input: { x: 1 } },
    });
    const resp = await callLLM(baseReq, { anthropic: stub });
    expect(resp.tool_use?.name).toBe("do_thing");
    expect((resp.tool_use?.input as { x: number }).x).toBe(1);
    expect(resp.text).toBe("");
  });

  test("force_tool is forwarded to the runner unchanged", async () => {
    let seenForceTool: string | undefined;
    const stub = async (req: LLMRequest): Promise<LLMResponse> => {
      seenForceTool = req.force_tool;
      return { text: "" };
    };
    await callLLM(
      { ...baseReq, force_tool: "humanize_email" },
      { anthropic: stub },
    );
    expect(seenForceTool).toBe("humanize_email");
  });
});
