/**
 * Guards the fat-skill extraction: the comparison-agent system prompt and the
 * verify-offer / parse-comparison-intake skills must parse and render. If a
 * frontmatter typo or a stray {{var}} slips in, the managed agent fails to
 * build and the whole comparison flow goes dark — catch it here, not in prod.
 *
 * Run: bun test test/comparison-skills-render.test.ts
 */
import { describe, expect, test } from "bun:test";
import { loadSkill, renderSkill, clearSkillCache } from "../src/skills/_harness/skill-loader.ts";

describe("comparison skills render", () => {
  test("comparison-agent loads as a static system prompt (no inputs)", () => {
    clearSkillCache();
    const skill = loadSkill("comparison-agent");
    expect(skill.frontmatter.provider).toBe("anthropic");
    expect(skill.frontmatter.inputs).toEqual([]);
    const rendered = renderSkill(skill, {});
    expect(rendered).toContain("comparison engine");
    // Must not contain unresolved template tokens.
    expect(rendered).not.toMatch(/\{\{/);
  });

  test("verify-offer renders with its declared inputs and forces its tool", () => {
    const skill = loadSkill("verify-offer");
    expect(skill.frontmatter.tool).toBe("verify_offer_report");
    const rendered = renderSkill(skill, {
      baseline_summary: "Category: internet",
      offer_summary: "Provider: FastNet",
    });
    expect(rendered).toContain("Category: internet");
    expect(rendered).toContain("Provider: FastNet");
  });

  test("parse-comparison-intake renders with a description and forces its tool", () => {
    const skill = loadSkill("parse-comparison-intake");
    expect(skill.frontmatter.tool).toBe("parse_intake");
    const rendered = renderSkill(skill, { description: "I pay $250/mo for car insurance" });
    expect(rendered).toContain("I pay $250/mo for car insurance");
  });
});
