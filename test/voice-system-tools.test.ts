/**
 * Voice system tools: keypad/IVR navigation, voicemail, holds, and the
 * loop-me-in warm transfer. These lock the load-bearing invariants of the
 * v0.2 voice upgrade:
 *
 *   1. The keypad, skip_turn, and voicemail_detection system tools are enabled
 *      for every bill kind so the agent can navigate IVRs and not burn minutes
 *      on voicemail.
 *   2. The transfer_to_number system tool AND the record_live_transfer webhook
 *      checkpoint are present ONLY when a usable callback phone is on file;
 *      otherwise the agent falls back to request_human_handoff.
 *   3. The transfer destination is normalized to E.164.
 *   4. The prompt actually instructs the agent to USE the keypad and to loop
 *      the account holder in for identity/payment walls.
 *   5. record_live_transfer transitions the call outcome to "live_transfer".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentConfig, toE164 } from "../src/voice/agent-config.ts";
import { dispatchToolCall, newCallState } from "../src/voice/tool-handlers.ts";
import { createUser, type User } from "../src/lib/auth.ts";
import { withUserContext } from "../src/lib/user-context.ts";
import type { AnalyzerResult, BillKind } from "../src/types.ts";

const ALL_KINDS: BillKind[] = [
  "medical",
  "telecom",
  "utility",
  "subscription",
  "insurance",
  "financial",
  "other",
];

function fakeAnalyzer(overrides: Partial<AnalyzerResult["metadata"]> = {}): AnalyzerResult {
  return {
    metadata: {
      patient_name: "Jane Doe",
      provider_name: "Acme Provider",
      provider_billing_address: null,
      claim_number: null,
      date_of_service: null,
      insurer_name: null,
      eob_patient_responsibility: null,
      bill_current_balance_due: 250,
      account_number: "ACC-1",
      bill_kind: "medical",
      ...overrides,
    },
    errors: [],
    summary: {
      high_confidence_total: 0,
      worth_reviewing_total: 0,
      bill_total_disputed: 0,
      headline: "no findings",
    },
    grounding_failures: [],
    meta: { model: "test", input_tokens: 0, output_tokens: 0, elapsed_ms: 0, tool_turns: 0 },
  };
}

function toolNames(opts: { bill_kind: BillKind; phone?: string | null }): string[] {
  const cfg = generateAgentConfig({
    result: fakeAnalyzer({ bill_kind: opts.bill_kind }),
    webhook_base_url: "https://x",
    webhook_secret: "s",
    bill_kind: opts.bill_kind,
    account_holder_phone: opts.phone ?? null,
  });
  return cfg.conversation_config.agent.prompt.tools.map((t) => t.name);
}

describe("toE164 normalization", () => {
  test("10-digit US number gets +1", () => {
    expect(toE164("4155550132")).toBe("+14155550132");
  });
  test("formatted US number is stripped", () => {
    expect(toE164("(415) 555-0132")).toBe("+14155550132");
    expect(toE164("+1-415-555-0132")).toBe("+14155550132");
  });
  test("11-digit leading-1 number", () => {
    expect(toE164("14155550132")).toBe("+14155550132");
  });
  test("null/empty/garbage returns null", () => {
    expect(toE164(null)).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164("call me")).toBeNull();
    expect(toE164("12345")).toBeNull(); // too short
  });
  test("11-digit not starting with 1 is rejected", () => {
    expect(toE164("24155550132")).toBeNull();
  });
  test("international +CC numbers pass through when length is plausible", () => {
    expect(toE164("+44 20 7183 8750")).toBe("+442071838750");
  });
  test("+ prefix with too-few / too-many digits is rejected", () => {
    expect(toE164("+1234")).toBeNull(); // 4 digits, < 8
    expect(toE164("+1234567890123456")).toBeNull(); // 16 digits, > 15
  });
});

describe("Keypad / voicemail / hold system tools (always on)", () => {
  for (const kind of ALL_KINDS) {
    test(`${kind}: keypad, skip_turn, voicemail_detection are enabled`, () => {
      const names = toolNames({ bill_kind: kind });
      expect(names).toContain("play_keypad_touch_tone");
      expect(names).toContain("skip_turn");
      expect(names).toContain("voicemail_detection");
    });
  }

  test("keypad tool carries the documented system params shape", () => {
    const cfg = generateAgentConfig({
      result: fakeAnalyzer(),
      webhook_base_url: "https://x",
      webhook_secret: "s",
    });
    const keypad = cfg.conversation_config.agent.prompt.tools.find(
      (t) => t.name === "play_keypad_touch_tone",
    );
    expect(keypad).toBeDefined();
    expect(keypad).toMatchObject({ type: "system", params: { systemToolType: "play_keypad_touch_tone" } });
  });

  test("prompt instructs the agent to use the keypad and handle voicemail/holds", () => {
    const prompt = generateAgentConfig({
      result: fakeAnalyzer(),
      webhook_base_url: "https://x",
      webhook_secret: "s",
    }).conversation_config.agent.prompt.prompt;
    expect(prompt).toContain("play_keypad_touch_tone");
    expect(prompt.toLowerCase()).toContain("voicemail");
    expect(prompt).toContain("skip_turn");
  });
});

describe("Loop-me-in transfer (gated on callback phone)", () => {
  test("with a phone: transfer_to_number + record_live_transfer are present and E.164", () => {
    const cfg = generateAgentConfig({
      result: fakeAnalyzer(),
      webhook_base_url: "https://x",
      webhook_secret: "s",
      account_holder_phone: "(415) 555-0132",
    });
    const tools = cfg.conversation_config.agent.prompt.tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("transfer_to_number");
    expect(names).toContain("record_live_transfer");

    const transfer = tools.find((t) => t.name === "transfer_to_number") as {
      params?: { transfers?: Array<{ transfer_destination: { phone_number: string }; transfer_type: string }> };
    };
    const rule = transfer.params?.transfers?.[0];
    expect(rule?.transfer_destination.phone_number).toBe("+14155550132");
    expect(rule?.transfer_type).toBe("conference"); // warm transfer

    const prompt = cfg.conversation_config.agent.prompt.prompt;
    expect(prompt).toContain("loop-me-in");
    expect(prompt).toContain("transfer_to_number");
    expect(prompt).toContain("record_live_transfer");
  });

  test("without a phone: transfer is omitted; agent falls back to handoff", () => {
    const names = toolNames({ bill_kind: "medical", phone: null });
    expect(names).not.toContain("transfer_to_number");
    expect(names).not.toContain("record_live_transfer");
    expect(names).toContain("request_human_handoff");

    const prompt = generateAgentConfig({
      result: fakeAnalyzer(),
      webhook_base_url: "https://x",
      webhook_secret: "s",
      account_holder_phone: null,
    }).conversation_config.agent.prompt.prompt;
    expect(prompt).not.toContain("loop-me-in");
    expect(prompt).toContain("request_human_handoff");
  });

  test("an unusable phone string is treated as no phone", () => {
    const names = toolNames({ bill_kind: "telecom", phone: "ask me later" });
    expect(names).not.toContain("transfer_to_number");
  });
});

describe("record_live_transfer outcome transition", () => {
  // dispatchToolCall persists CallState via currentUserPaths(), so these run
  // inside a temp data dir + user context.
  const TEST_DIR = join(tmpdir(), `bonsai-voice-systools-${process.pid}-${Date.now()}`);
  let user: User;

  beforeAll(async () => {
    process.env.BONSAI_DATA_DIR = TEST_DIR;
    user = await createUser(`systools-${Date.now()}@test.example`, "supersecret", {
      acceptedTerms: true,
    });
  });
  afterAll(() => {
    delete process.env.BONSAI_DATA_DIR;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("sets outcome.status to live_transfer with the reason", async () => {
    await withUserContext(user, async () => {
      const state = newCallState({ call_id: "c1", analyzer: fakeAnalyzer(), final_acceptable_floor: 100 });
      expect(state.outcome.status).toBe("in_progress");

      dispatchToolCall(state, "record_live_transfer", { reason: "identity_challenge" });
      expect(state.outcome.status).toBe("live_transfer");
      expect(state.outcome.live_transfer_reason).toBe("identity_challenge");
    });
  });

  test("does not clobber a recorded success — annotates the reason instead", async () => {
    await withUserContext(user, async () => {
      const state = newCallState({ call_id: "c2", analyzer: fakeAnalyzer(), final_acceptable_floor: 1000 });
      dispatchToolCall(state, "record_negotiated_amount", {
        amount: 500,
        commitment_notes: "agreed",
      });
      expect(state.outcome.status).toBe("success");

      dispatchToolCall(state, "record_live_transfer", { reason: "payment_authorization" });
      expect(state.outcome.status).toBe("success");
      expect(state.outcome.live_transfer_reason).toBe("payment_authorization");
    });
  });

  test("preserves a recorded PARTIAL balance — does not lose the negotiated amount", async () => {
    await withUserContext(user, async () => {
      // floor below the agreed amount → record_negotiated_amount lands "partial".
      const state = newCallState({ call_id: "c3", analyzer: fakeAnalyzer(), final_acceptable_floor: 100 });
      dispatchToolCall(state, "record_negotiated_amount", {
        amount: 500,
        commitment_notes: "rep agreed to 500, above floor",
      });
      expect(state.outcome.status).toBe("partial");
      expect(state.outcome.negotiated_amount).toBe(500);

      dispatchToolCall(state, "record_live_transfer", { reason: "identity_challenge" });
      // Partial win is kept; transfer reason annotated alongside it.
      expect(state.outcome.status).toBe("partial");
      expect(state.outcome.negotiated_amount).toBe(500);
      expect(state.outcome.live_transfer_reason).toBe("identity_challenge");
    });
  });
});
