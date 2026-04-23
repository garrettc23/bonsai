/**
 * Voice-call tool handlers.
 *
 * When the ElevenLabs agent calls a server tool mid-call, the HTTP webhook
 * posts the tool name + input to our server. Our server dispatches to one
 * of these handlers, which compute the response and return it to
 * ElevenLabs for the agent to speak. They also persist state (the agent's
 * committed outcome) to out/calls/{call_id}.json.
 *
 * Handlers are pure functions of (state, input) → (response, new state).
 * The HTTP wrapper is in src/server/voice-webhook.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalyzerResult, BillingError } from "../types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CALLS_DIR = join(__dirname, "..", "..", "out", "calls");

export interface CallState {
  call_id: string;
  thread_id?: string;
  analyzer: AnalyzerResult;
  final_acceptable_floor: number;
  // transcript of tool calls + results, appended as they happen
  tool_events: Array<{ ts: string; tool: string; input: unknown; output: unknown }>;
  // final outcome committed by end_call
  outcome: {
    status: "in_progress" | "success" | "partial" | "no_adjustment" | "handoff" | "voicemail_left" | "dropped";
    negotiated_amount?: number;
    commitment_notes?: string;
    handoff_reason?: string;
  };
}

export function newCallState(opts: {
  call_id: string;
  analyzer: AnalyzerResult;
  final_acceptable_floor?: number;
  thread_id?: string;
}): CallState {
  const floor =
    opts.final_acceptable_floor ?? opts.analyzer.metadata.eob_patient_responsibility ?? 0;
  return {
    call_id: opts.call_id,
    thread_id: opts.thread_id,
    analyzer: opts.analyzer,
    final_acceptable_floor: floor,
    tool_events: [],
    outcome: { status: "in_progress" },
  };
}

export function loadCallState(call_id: string): CallState | null {
  const path = join(CALLS_DIR, `${call_id}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveCallState(state: CallState): void {
  mkdirSync(CALLS_DIR, { recursive: true });
  writeFileSync(join(CALLS_DIR, `${state.call_id}.json`), JSON.stringify(state, null, 2), "utf8");
}

function appendEvent(state: CallState, tool: string, input: unknown, output: unknown): void {
  state.tool_events.push({ ts: new Date().toISOString(), tool, input, output });
}

/* ── Handlers ────────────────────────────────────────────────────────── */

export function handleGetDisputedLine(
  state: CallState,
  input: { cpt_code?: string; index?: number },
): { result: { found: boolean; line?: BillingError; message?: string } } {
  const high = state.analyzer.errors.filter((e) => e.confidence === "high");
  let found: BillingError | undefined;
  if (input.cpt_code) {
    found = high.find((e) => e.cpt_code === input.cpt_code);
  } else if (input.index && input.index >= 1 && input.index <= high.length) {
    found = high[input.index - 1];
  }
  const out = found
    ? { result: { found: true, line: found } }
    : { result: { found: false, message: `No disputed line matches. Available: ${high.length} lines.` } };
  appendEvent(state, "get_disputed_line", input, out);
  saveCallState(state);
  return out;
}

export function handleConfirmEobAmount(
  state: CallState,
): { result: { eob_patient_responsibility: number | null; bill_current_balance_due: number | null } } {
  const out = {
    result: {
      eob_patient_responsibility: state.analyzer.metadata.eob_patient_responsibility,
      bill_current_balance_due: state.analyzer.metadata.bill_current_balance_due,
    },
  };
  appendEvent(state, "confirm_eob_amount", {}, out);
  saveCallState(state);
  return out;
}

export function handleRecordNegotiatedAmount(
  state: CallState,
  input: { amount: number; commitment_notes: string },
): { result: { recorded: boolean; floor_respected: boolean; at_or_below_floor: boolean } } {
  const atOrBelow = input.amount <= state.final_acceptable_floor;
  state.outcome = {
    status: atOrBelow ? "success" : "partial",
    negotiated_amount: input.amount,
    commitment_notes: input.commitment_notes,
  };
  const out = { result: { recorded: true, floor_respected: atOrBelow, at_or_below_floor: atOrBelow } };
  appendEvent(state, "record_negotiated_amount", input, out);
  saveCallState(state);
  return out;
}

export function handleRequestHumanHandoff(
  state: CallState,
  input: { reason: "hostile" | "legal_threat" | "supervisor_refused" | "unclear" | "voicemail" },
): { result: { acknowledged: boolean } } {
  state.outcome = { status: "handoff", handoff_reason: input.reason };
  const out = { result: { acknowledged: true } };
  appendEvent(state, "request_human_handoff", input, out);
  saveCallState(state);
  return out;
}

export function handleEndCall(
  state: CallState,
  input: { outcome: "success" | "partial" | "no_adjustment" | "handoff" | "voicemail_left" | "dropped" },
): { result: { acknowledged: boolean } } {
  // Respect an explicit outcome unless we already recorded a stronger one.
  if (state.outcome.status === "in_progress") {
    state.outcome.status = input.outcome;
  }
  const out = { result: { acknowledged: true } };
  appendEvent(state, "end_call", input, out);
  saveCallState(state);
  return out;
}

/**
 * Single entrypoint used by the webhook handler and the simulator.
 * Dispatches to the correct handler based on the tool name.
 */
export function dispatchToolCall(
  state: CallState,
  toolName: string,
  input: unknown,
): { result: unknown } | { error: string } {
  switch (toolName) {
    case "get_disputed_line":
      return handleGetDisputedLine(state, input as { cpt_code?: string; index?: number });
    case "confirm_eob_amount":
      return handleConfirmEobAmount(state);
    case "record_negotiated_amount":
      return handleRecordNegotiatedAmount(state, input as { amount: number; commitment_notes: string });
    case "request_human_handoff":
      return handleRequestHumanHandoff(state, input as { reason: "hostile" | "legal_threat" | "supervisor_refused" | "unclear" | "voicemail" });
    case "end_call":
      return handleEndCall(state, input as { outcome: "success" | "partial" | "no_adjustment" | "handoff" | "voicemail_left" | "dropped" });
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
