/**
 * Anthropic adapter for the LLM provider abstraction.
 *
 * Maps the provider-neutral LLMRequest to Anthropic SDK shapes and
 * normalizes the response into LLMResponse. The only Anthropic SDK
 * import in the new src/llm/ tree.
 *
 * Auth: requires ANTHROPIC_API_KEY in env. We don't validate it here
 * — entry points already call validateRequiredEnv() and the SDK
 * raises a clear error on a missing key.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LLMRequest, LLMResponse, LLMTool } from "./provider.ts";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export async function runAnthropic(req: LLMRequest): Promise<LLMResponse> {
  const tools = req.tools?.map(toAnthropicTool);
  const tool_choice = req.force_tool
    ? ({ type: "tool", name: req.force_tool } as const)
    : undefined;
  const resp = await getClient().messages.create({
    model: req.model,
    max_tokens: req.max_tokens,
    system: req.system,
    tools,
    tool_choice,
    messages: [{ role: "user", content: req.user }],
  });
  return normalize(resp);
}

function toAnthropicTool(t: LLMTool): Anthropic.Tool {
  // Anthropic tool shape is already what LLMTool was modeled on, so
  // this is a passthrough — kept as a function so the conversion is
  // colocated with the provider that owns the shape.
  return {
    name: t.name,
    description: t.description,
    // Cast: Anthropic's TS type narrows this to a specific JSON Schema
    // subset. Our LLMTool stores it as Record<string, unknown> for
    // provider-neutrality. Runtime shapes match.
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
  };
}

function normalize(resp: Anthropic.Messages.Message): LLMResponse {
  let text = "";
  let toolUse: { name: string; input: unknown } | undefined;
  for (const block of resp.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      // First tool_use wins. Skills that need parallel tool calls are
      // not supported through this adapter — they'd use the SDK
      // directly. Today there are none.
      if (!toolUse) toolUse = { name: block.name, input: block.input };
    }
  }
  return { text, tool_use: toolUse };
}
