/**
 * Deterministic coverage for the simulator's system-tool branches (keypad
 * DTMF feed-through and the loop-me-in transfer). We inject a stub Anthropic
 * client so the agent's tool calls are scripted — no network, no API spend —
 * and assert the simulator routes them correctly:
 *
 *   - play_keypad_touch_tone presses are surfaced to the rep persona.
 *   - record_live_transfer flips CallState to live_transfer.
 *   - transfer_to_number is terminal (the AI drops off).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { simulateCall } from "../src/voice/simulator.ts";
import { createUser, type User } from "../src/lib/auth.ts";
import { withUserContext } from "../src/lib/user-context.ts";
import type { AnalyzerResult } from "../src/types.ts";

function fakeAnalyzer(): AnalyzerResult {
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
      bill_kind: "telecom",
    },
    errors: [],
    summary: { high_confidence_total: 0, worth_reviewing_total: 0, bill_total_disputed: 0, headline: "none" },
    grounding_failures: [],
    meta: { model: "test", input_tokens: 0, output_tokens: 0, elapsed_ms: 0, tool_turns: 0 },
  };
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function msg(blocks: Block[], stop: "tool_use" | "end_turn") {
  return { content: blocks, stop_reason: stop };
}

/**
 * Stub Anthropic client. Rep turns (no `tools` param) return canned menu text;
 * agent turns (with `tools`) return a scripted sequence that presses a key,
 * then loops the user in, then transfers.
 */
function stubClient(): { client: Anthropic; repInputs: string[] } {
  const repInputs: string[] = [];
  let agentCall = 0;
  const agentScript = [
    msg([{ type: "tool_use", id: "a0", name: "play_keypad_touch_tone", input: { digits: "2" } }], "tool_use"),
    msg([{ type: "text", text: "Pressing 2 for billing." }], "end_turn"),
    msg([{ type: "tool_use", id: "a2", name: "record_live_transfer", input: { reason: "identity_challenge" } }], "tool_use"),
    msg([{ type: "tool_use", id: "a3", name: "transfer_to_number", input: { client_message: "Connecting you now." } }], "tool_use"),
  ];

  const create = async (params: { tools?: unknown; messages: Array<{ role: string; content: unknown }> }) => {
    if (params.tools) {
      const i = Math.min(agentCall, agentScript.length - 1);
      agentCall += 1;
      return agentScript[i];
    }
    // Rep turn: capture what the agent "said" (last user message) for assertions.
    const last = params.messages[params.messages.length - 1];
    if (last && typeof last.content === "string") repInputs.push(last.content);
    return msg([{ type: "text", text: "Press 2 for billing." }], "end_turn");
  };

  return { client: { messages: { create } } as unknown as Anthropic, repInputs };
}

describe("simulator system-tool routing", () => {
  const TEST_DIR = join(tmpdir(), `bonsai-sim-systools-${process.pid}-${Date.now()}`);
  let user: User;

  beforeAll(async () => {
    process.env.BONSAI_DATA_DIR = TEST_DIR;
    user = await createUser(`sim-${Date.now()}@test.example`, "supersecret", { acceptedTerms: true });
  });
  afterAll(() => {
    delete process.env.BONSAI_DATA_DIR;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("keypad press feeds the rep; transfer ends the call as live_transfer", async () => {
    await withUserContext(user, async () => {
      const { client, repInputs } = stubClient();
      const { state, transcript } = await simulateCall({
        analyzer: fakeAnalyzer(),
        persona: "ivr",
        anthropic: client,
        account_holder_phone: "+14155550132",
        max_turns: 4,
      });

      // The keypad press reached the rep as a "[The caller pressed keypad: 2]" note.
      expect(repInputs.some((s) => s.includes("pressed keypad: 2"))).toBe(true);

      // The transfer flipped the outcome and was logged in the transcript.
      expect(state.outcome.status).toBe("live_transfer");
      expect(state.outcome.live_transfer_reason).toBe("identity_challenge");
      const toolLines = transcript.filter((t) => t.who === "tool").map((t) => t.text);
      expect(toolLines.some((t) => t.startsWith("play_keypad_touch_tone"))).toBe(true);
      expect(toolLines.some((t) => t.startsWith("transfer_to_number"))).toBe(true);
    });
  });

  test("no callback phone → transfer tool is never synthesized; agent can't loop the user in", async () => {
    await withUserContext(user, async () => {
      // Agent presses a key, then ends the call normally — no transfer available.
      let agentCall = 0;
      const script = [
        msg([{ type: "tool_use", id: "b0", name: "play_keypad_touch_tone", input: { digits: "2" } }], "tool_use"),
        msg([{ type: "tool_use", id: "b1", name: "end_call", input: { outcome: "no_adjustment" } }], "tool_use"),
      ];
      const create = async (params: { tools?: unknown }) => {
        if (params.tools) return script[Math.min(agentCall++, script.length - 1)];
        return msg([{ type: "text", text: "Press 2 for billing." }], "end_turn");
      };
      const client = { messages: { create } } as unknown as Anthropic;

      const { state, transcript, agent_config } = await simulateCall({
        analyzer: fakeAnalyzer(),
        persona: "ivr",
        anthropic: client,
        account_holder_phone: null, // no phone → no transfer
        max_turns: 4,
      });

      // Config gates the transfer tool out entirely.
      const names = agent_config.conversation_config.agent.prompt.tools.map((t) => t.name);
      expect(names).not.toContain("transfer_to_number");
      expect(names).not.toContain("record_live_transfer");

      // No transfer ever appears, and the outcome is not a live transfer.
      const toolLines = transcript.filter((t) => t.who === "tool").map((t) => t.text);
      expect(toolLines.some((t) => t.startsWith("transfer_to_number"))).toBe(false);
      expect(state.outcome.status).not.toBe("live_transfer");
    });
  });
});
