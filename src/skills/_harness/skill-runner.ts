/**
 * Generic skill runner. Loads a skill by name, renders its template with
 * the supplied vars, and dispatches to the LLM provider declared in
 * frontmatter via callLLM().
 *
 * The skill loader (skill-loader.ts) handles file IO and templating.
 * The provider abstraction (../llm/provider.ts) handles the SDK shapes.
 * This module is the glue: "render, then call".
 *
 * Skill-specific wrappers (e.g., run-fact-check.ts) layer on top of
 * runSkill() to add typed input/output and any skill-specific gating
 * (env flags, fail-open behavior, etc).
 */
import { loadSkill, renderSkill } from "./skill-loader.ts";
import {
  callLLM,
  type LLMResponse,
  type LLMTool,
  type ProviderRunners,
} from "../../llm/provider.ts";

export interface RunSkillOpts {
  /** Variables to substitute into the skill body. Keys must match the
   * skill's frontmatter `inputs:` list exactly. */
  vars: Record<string, string>;
  /** The user message to attach to the rendered system prompt. */
  user: string;
  /** Tools the model may call. Optional — text-only skills omit this. */
  tools?: LLMTool[];
  /** Force the model to call a specific tool. If unset and the skill's
   * frontmatter has `tool: <name>`, that name is forced automatically. */
  force_tool?: string;
  /** Test injection point. */
  runners?: ProviderRunners;
}

export async function runSkill(name: string, opts: RunSkillOpts): Promise<LLMResponse> {
  const skill = loadSkill(name);
  const system = renderSkill(skill, opts.vars);
  const force = opts.force_tool ?? skill.frontmatter.tool;
  return callLLM(
    {
      provider: skill.frontmatter.provider,
      model: skill.frontmatter.model,
      max_tokens: skill.frontmatter.max_tokens,
      system,
      user: opts.user,
      tools: opts.tools,
      force_tool: force,
    },
    opts.runners,
  );
}
