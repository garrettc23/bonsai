import { describe, expect, test, beforeEach } from "bun:test";
import {
  parseSkill,
  renderSkill,
  loadSkill,
  clearSkillCache,
} from "../src/skills/_harness/skill-loader.ts";

describe("parseSkill", () => {
  test("parses a minimal skill", () => {
    const raw = `---
name: noop
description: A no-op skill.
model: claude-opus-4-7
provider: anthropic
max_tokens: 100
---
Hello world.`;
    const skill = parseSkill(raw, "noop");
    expect(skill.frontmatter.name).toBe("noop");
    expect(skill.frontmatter.model).toBe("claude-opus-4-7");
    expect(skill.frontmatter.provider).toBe("anthropic");
    expect(skill.frontmatter.max_tokens).toBe(100);
    expect(skill.frontmatter.inputs).toEqual([]);
    expect(skill.frontmatter.tool).toBeUndefined();
    expect(skill.body).toBe("Hello world.");
  });

  test("parses inputs as a string list", () => {
    const raw = `---
name: noop
description: x
model: gpt-5
provider: openai
max_tokens: 1
inputs: [a, b, c]
tool: my_tool
---
{{a}}/{{b}}/{{c}}`;
    const skill = parseSkill(raw, "noop");
    expect(skill.frontmatter.inputs).toEqual(["a", "b", "c"]);
    expect(skill.frontmatter.tool).toBe("my_tool");
  });

  test("rejects when filename and frontmatter name disagree", () => {
    const raw = `---
name: alpha
description: x
model: claude-opus-4-7
provider: anthropic
max_tokens: 1
---
body`;
    expect(() => parseSkill(raw, "beta")).toThrow(/must match the filename/);
  });

  test("rejects malformed frontmatter (missing closing fence)", () => {
    const raw = `---
name: noop
description: x
model: claude-opus-4-7
provider: anthropic
max_tokens: 1
body without fence`;
    expect(() => parseSkill(raw, "noop")).toThrow(/missing or malformed/);
  });

  test("rejects unknown provider", () => {
    const raw = `---
name: noop
description: x
model: m
provider: bedrock
max_tokens: 1
---`;
    expect(() => parseSkill(raw, "noop")).toThrow(/provider must be/);
  });

  test("rejects non-numeric max_tokens", () => {
    const raw = `---
name: noop
description: x
model: m
provider: anthropic
max_tokens: lots
---`;
    expect(() => parseSkill(raw, "noop")).toThrow(/max_tokens must be a positive number/);
  });
});

describe("renderSkill", () => {
  const skill = parseSkill(
    `---
name: hello
description: x
model: m
provider: anthropic
max_tokens: 1
inputs: [name, mood]
---
Hi {{name}}, you seem {{mood}} today.`,
    "hello",
  );

  test("substitutes declared variables", () => {
    expect(renderSkill(skill, { name: "Garrett", mood: "focused" })).toBe(
      "Hi Garrett, you seem focused today.",
    );
  });

  test("treats empty string as a valid value", () => {
    expect(renderSkill(skill, { name: "Garrett", mood: "" })).toBe(
      "Hi Garrett, you seem  today.",
    );
  });

  test("throws when a declared input is omitted entirely", () => {
    expect(() => renderSkill(skill, { name: "Garrett" })).toThrow(
      /declared input "mood" was not provided/,
    );
  });

  test("throws when body references an undeclared variable", () => {
    const sneaky = parseSkill(
      `---
name: sneaky
description: x
model: m
provider: anthropic
max_tokens: 1
inputs: [a]
---
{{a}} {{b}}`,
      "sneaky",
    );
    expect(() => renderSkill(sneaky, { a: "1" })).toThrow(
      /references "{{b}}" but it is not in frontmatter inputs/,
    );
  });
});

describe("loadSkill", () => {
  beforeEach(() => clearSkillCache());

  test("loads the humanize skill from disk and renders it", () => {
    const skill = loadSkill("humanize");
    expect(skill.frontmatter.name).toBe("humanize");
    expect(skill.frontmatter.tool).toBe("humanize_email");
    // Render with the same shape humanizer.ts uses — proves the skill
    // file's declared inputs are exactly what the caller provides.
    const rendered = renderSkill(skill, {
      tone: "firm",
      tone_guidance: "Be direct.",
      bill_kind: "medical",
      playbook: "MEDICAL DISPUTE.",
      length_rule: "the body MUST be at or under 200 words.",
      sign_block: "Sign the email as: Garrett.",
      facts_block: "",
    });
    expect(rendered).toContain("Sign the email as: Garrett.");
    expect(rendered).toContain("user selected: firm");
    expect(rendered).toContain("MEDICAL DISPUTE.");
    expect(rendered).not.toContain("{{");
  });
});
