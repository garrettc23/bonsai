/**
 * OpenAI adapter for the LLM provider abstraction.
 *
 * Maps the provider-neutral LLMRequest to OpenAI Chat Completions
 * shapes and normalizes the response into LLMResponse. The only
 * OpenAI SDK import in the new src/llm/ tree.
 *
 * Auth: requires OPENAI_API_KEY in env. Validation happens lazily —
 * the SDK raises a clear error on a missing key, and Bonsai-skills
 * that don't use OpenAI never hit this code path.
 *
 * Why Chat Completions vs Responses API: Chat Completions has the
 * most mature tool_choice + structured output story across both 4o
 * and 5 model families and matches the Anthropic tool_use shape
 * closely enough that the adapters stay symmetric.
 */
import OpenAI from "openai";
import type { LLMRequest, LLMResponse, LLMTool } from "./provider.ts";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

export async function runOpenAI(req: LLMRequest): Promise<LLMResponse> {
  const tools = req.tools?.map(toOpenAITool);
  const tool_choice = req.force_tool
    ? ({ type: "function" as const, function: { name: req.force_tool } })
    : undefined;
  const resp = await getClient().chat.completions.create({
    model: req.model,
    max_tokens: req.max_tokens,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    tools,
    tool_choice,
  });
  return normalize(resp);
}

function toOpenAITool(t: LLMTool): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  };
}

function normalize(resp: OpenAI.Chat.Completions.ChatCompletion): LLMResponse {
  const choice = resp.choices[0];
  if (!choice) return { text: "" };
  const message = choice.message;
  let toolUse: { name: string; input: unknown } | undefined;
  const calls = message.tool_calls;
  if (calls && calls.length > 0) {
    const first = calls[0];
    // OpenAI v6 uses `type: "function"` for function tool calls. The
    // discriminated union also has "custom" tools — we only emit
    // function tools, so that branch shouldn't appear, but guard
    // anyway so a future SDK addition doesn't silently mis-parse.
    if (first && first.type === "function") {
      // OpenAI returns arguments as a JSON string; Anthropic returns
      // a parsed object. Normalize to the parsed shape so downstream
      // skill handlers see one type.
      let input: unknown;
      const argsText = first.function.arguments;
      try {
        input = argsText ? JSON.parse(argsText) : {};
      } catch {
        // Surface the malformed JSON to the caller as a string —
        // they'll typically log it and fall back. Preferable to
        // silently swallowing a tool call.
        input = { _malformed_json: argsText };
      }
      toolUse = { name: first.function.name, input };
    }
  }
  return {
    text: message.content ?? "",
    tool_use: toolUse,
  };
}
