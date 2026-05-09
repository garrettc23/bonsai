/**
 * Skill loader — reads a skill markdown file, parses its YAML-subset
 * frontmatter, and renders {{variable}} substitutions in the body.
 *
 * Skill files live in `src/skills/<name>.md` and look like:
 *
 *   ---
 *   name: humanize
 *   description: Rewrite a drafted email…
 *   model: claude-opus-4-7
 *   provider: anthropic
 *   max_tokens: 2048
 *   inputs: [tone, sign_block, facts_block]
 *   tool: humanize_email
 *   ---
 *
 *   You are Bonsai's humanizer. Tone: {{tone}}.
 *   {{facts_block}}
 *
 * Why hand-roll instead of `gray-matter` + Mustache? Frontmatter is a
 * tiny deterministic shape (we own both sides), and pulling in two new
 * deps for ~60 lines of parsing is the wrong trade. Skill bodies use
 * single-pass `{{var}}` substitution — no conditionals, no loops. If a
 * skill needs a conditional block, the caller pre-builds the block as a
 * string and passes it in. That keeps formatting decisions in TypeScript
 * where they're testable, and keeps the loader a couple dozen lines.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** `src/skills/` — one level up from `src/skills/_harness/`. */
const SKILLS_DIR = join(__dirname, "..");

export type SkillProvider = "anthropic" | "openai";

export interface SkillFrontmatter {
  name: string;
  description: string;
  model: string;
  provider: SkillProvider;
  max_tokens: number;
  /** Names of variables the body references. Validated at render time —
   * declared-but-not-provided is an error, undeclared-but-referenced is
   * also an error. Both catch typos before they hit production. */
  inputs: string[];
  /** Tool name the skill expects to be force-called via tool_choice.
   * Optional — text-only skills omit it. */
  tool?: string;
}

export interface Skill {
  frontmatter: SkillFrontmatter;
  /** Raw markdown body (everything after the closing `---`). */
  body: string;
}

const cache = new Map<string, Skill>();

/**
 * Load a skill by name. Cached after first load; tests that mutate skill
 * files on disk should call `clearSkillCache()` between tests.
 */
export function loadSkill(name: string): Skill {
  const cached = cache.get(name);
  if (cached) return cached;
  const path = join(SKILLS_DIR, `${name}.md`);
  const raw = readFileSync(path, "utf8");
  const skill = parseSkill(raw, name);
  cache.set(name, skill);
  return skill;
}

export function clearSkillCache(): void {
  cache.clear();
}

/**
 * Render a skill body with the given variable bindings. Throws if any
 * declared input is missing or any undeclared variable is referenced —
 * both indicate a skill/caller mismatch the developer wants to know
 * about loudly, not silently.
 */
export function renderSkill(skill: Skill, vars: Record<string, string>): string {
  // Declared inputs must be provided. Undefined is allowed only if the
  // caller explicitly passes "" — that's the contract for "this section
  // is empty this turn". `null`/`undefined` is treated as absent.
  for (const declared of skill.frontmatter.inputs) {
    if (!(declared in vars)) {
      throw new Error(
        `skill ${skill.frontmatter.name}: declared input "${declared}" was not provided`,
      );
    }
  }
  // Walk the template once; collect references; substitute.
  return skill.body.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, varName: string) => {
    if (!skill.frontmatter.inputs.includes(varName)) {
      throw new Error(
        `skill ${skill.frontmatter.name}: body references "{{${varName}}}" but it is not in frontmatter inputs`,
      );
    }
    return vars[varName] ?? "";
  });
}

/** Parse a skill file. Exported for tests; production code uses loadSkill. */
export function parseSkill(raw: string, name: string): Skill {
  // Strict frontmatter shape: file must start with --- on its own line,
  // a block of key: value lines, then --- on its own line. Anything else
  // is malformed.
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) {
    throw new Error(`skill ${name}: missing or malformed frontmatter`);
  }
  const fm = parseFrontmatter(match[1] ?? "", name);
  const body = (match[2] ?? "").trimStart();
  if (fm.name !== name) {
    throw new Error(
      `skill ${name}: frontmatter "name: ${fm.name}" must match the filename`,
    );
  }
  return { frontmatter: fm, body };
}

/**
 * Parse a tiny YAML-subset:
 *   key: value
 *   key: [a, b, c]
 *   key: 123
 *
 * No nesting, no quoting, no multi-line values. If a skill ever needs
 * those, switch to gray-matter — but we should fight to never need them.
 */
function parseFrontmatter(text: string, skillName: string): SkillFrontmatter {
  const fields: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      throw new Error(`skill ${skillName}: malformed frontmatter line: ${line}`);
    }
    const key = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();
    fields[key] = parseValue(rawValue);
  }
  return validateFrontmatter(fields, skillName);
}

function parseValue(raw: string): string | number | string[] {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  // Numeric values are coerced; everything else is a bare string. We
  // don't support quoted strings — descriptions with colons/quotes
  // should use a separate description field convention if it ever comes
  // up. So far it hasn't.
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function validateFrontmatter(fields: Record<string, unknown>, skillName: string): SkillFrontmatter {
  const required = ["name", "description", "model", "provider", "max_tokens"] as const;
  for (const key of required) {
    if (!(key in fields)) {
      throw new Error(`skill ${skillName}: missing required frontmatter field "${key}"`);
    }
  }
  const provider = fields.provider;
  if (provider !== "anthropic" && provider !== "openai") {
    throw new Error(
      `skill ${skillName}: provider must be "anthropic" or "openai", got ${JSON.stringify(provider)}`,
    );
  }
  const maxTokens = fields.max_tokens;
  if (typeof maxTokens !== "number" || maxTokens <= 0) {
    throw new Error(
      `skill ${skillName}: max_tokens must be a positive number, got ${JSON.stringify(maxTokens)}`,
    );
  }
  const inputsRaw = fields.inputs ?? [];
  if (!Array.isArray(inputsRaw) || inputsRaw.some((s) => typeof s !== "string")) {
    throw new Error(`skill ${skillName}: inputs must be a list of strings`);
  }
  const tool = fields.tool;
  if (tool !== undefined && typeof tool !== "string") {
    throw new Error(`skill ${skillName}: tool must be a string when present`);
  }
  return {
    name: String(fields.name),
    description: String(fields.description),
    model: String(fields.model),
    provider,
    max_tokens: maxTokens,
    inputs: inputsRaw as string[],
    tool: tool as string | undefined,
  };
}
