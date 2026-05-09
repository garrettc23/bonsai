/**
 * Model-agnostic LLM call site.
 *
 * Every skill in `src/skills/` declares its `provider` in frontmatter.
 * The harness loads the skill, renders the prompt, and routes the call
 * through `callLLM()` here — the only place in the codebase that knows
 * about Anthropic vs OpenAI SDK shapes.
 *
 * Why this layer exists: the post we're modeling on (Garry Tan's
 * fat-skills / interchangeable-models architecture) puts cross-modal
 * eval at its center — the fact-check skill is most useful when it
 * runs on a *different provider* than the draft-reply skill, so blind
 * spots don't overlap. That requires the negotiation pipeline to call
 * Anthropic and OpenAI from the same code path with the same
 * tool_use semantics.
 *
 * What this layer does NOT do:
 *   - Streaming. We always wait for the full tool_use block.
 *   - Multi-turn conversation history. The humanizer (today's only
 *     consumer) sends one user message; the multi-turn negotiation
 *     loop in negotiate-email.ts still calls the Anthropic SDK
 *     directly until Phase 5 of the rebuild migrates it.
 *   - Provider-specific knobs (temperature, top_p, etc). Add when
 *     a skill actually needs one — not on speculation.
 */

export type ProviderName = "anthropic" | "openai";

export interface LLMTool {
  name: string;
  description: string;
  /** JSON Schema describing the tool's input. Identical shape across
   * providers — the adapters convert to provider-specific wrapper
   * shapes (Anthropic uses input_schema; OpenAI uses parameters). */
  input_schema: Record<string, unknown>;
}

export interface LLMRequest {
  provider: ProviderName;
  model: string;
  max_tokens: number;
  system: string;
  user: string;
  tools?: LLMTool[];
  /** Force the model to call the named tool. Mirrors Anthropic's
   * tool_choice={type:"tool", name} and OpenAI's tool_choice={type:
   * "function", function:{name}}. When unset, the provider's "auto"
   * mode applies (model picks tool or text). */
  force_tool?: string;
}

export interface LLMToolUse {
  name: string;
  input: unknown;
}

export interface LLMResponse {
  /** Present when the model emitted a tool call. */
  tool_use?: LLMToolUse;
  /** Plain text response (concatenated text blocks). May be empty
   * when tool_use is present. */
  text: string;
}

/**
 * Tests inject runners to avoid hitting real APIs. Production code
 * leaves runners undefined and gets the real Anthropic/OpenAI clients.
 */
export interface ProviderRunners {
  anthropic?: (req: LLMRequest) => Promise<LLMResponse>;
  openai?: (req: LLMRequest) => Promise<LLMResponse>;
}

export async function callLLM(
  req: LLMRequest,
  runners?: ProviderRunners,
): Promise<LLMResponse> {
  if (req.provider === "anthropic") {
    const run = runners?.anthropic ?? (await loadAnthropicRunner());
    return run(req);
  }
  if (req.provider === "openai") {
    const run = runners?.openai ?? (await loadOpenAIRunner());
    return run(req);
  }
  throw new Error(`callLLM: unknown provider ${req.provider as string}`);
}

// Lazy SDK loading. Two reasons:
//   1. Test environments that mock both runners never need to import
//      either SDK.
//   2. A workspace using only Anthropic skills (or only OpenAI skills)
//      doesn't pay the cold-import cost of the unused SDK.
let anthropicRunnerCached: ((req: LLMRequest) => Promise<LLMResponse>) | null = null;
let openaiRunnerCached: ((req: LLMRequest) => Promise<LLMResponse>) | null = null;

async function loadAnthropicRunner(): Promise<(req: LLMRequest) => Promise<LLMResponse>> {
  if (anthropicRunnerCached) return anthropicRunnerCached;
  const mod = await import("./anthropic-client.ts");
  anthropicRunnerCached = mod.runAnthropic;
  return anthropicRunnerCached;
}

async function loadOpenAIRunner(): Promise<(req: LLMRequest) => Promise<LLMResponse>> {
  if (openaiRunnerCached) return openaiRunnerCached;
  const mod = await import("./openai-client.ts");
  openaiRunnerCached = mod.runOpenAI;
  return openaiRunnerCached;
}
