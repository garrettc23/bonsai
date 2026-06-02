/**
 * End-to-end test of the audit phase: upload → analyze → appeal letter →
 * channel choice. runBonsai()/runAuditPhase() is the single entry point the
 * server and CLI both call, but until now it was only exercised by ad-hoc
 * fixture runs — never asserted.
 *
 * We inject a scripted Anthropic client (the `anthropicClient` test seam on
 * RunBonsaiOpts) so the audit is deterministic and free. This proves the
 * wiring: analyzer findings flow into the appeal letter and the summary, and
 * the strategy reflects the contact channels available.
 *
 * Run: bun test test/orchestrator-e2e.test.ts
 */
import { describe, expect, test } from "bun:test";
import { runAuditPhase } from "../src/orchestrator.ts";
import {
  mockAnthropic,
  scriptOneDuplicateThenFinalize,
} from "./helpers/mock-anthropic.ts";

describe("runAuditPhase — audit → appeal → channel", () => {
  test("wires analyzer findings into the appeal and summary, picks email", async () => {
    const report = await runAuditPhase({
      billFixtureName: "bill-001",
      channel: "email",
      provider_email: "billing@stsynthetic.example",
      anthropicClient: mockAnthropic(scriptOneDuplicateThenFinalize()),
    });

    // Analyzer ran and recorded the grounded duplicate.
    expect(report.analyzer.errors.length).toBe(1);
    expect(report.analyzer.errors[0].error_type).toBe("duplicate");
    expect(report.analyzer.summary.high_confidence_total).toBe(468);

    // Appeal letter was generated off the analyzer output.
    expect(typeof report.appeal.subject).toBe("string");
    expect(report.appeal.subject.length).toBeGreaterThan(0);

    // Channel strategy honored the explicit request.
    expect(report.strategy.chosen).toBe("email");

    // Summary reflects the audit, pre-negotiation.
    expect(report.summary.defensible_disputed).toBe(468);
    expect(report.summary.channel_used).toBe("email");
    expect(report.summary.outcome).toBe("in_progress");
    expect(report.summary.final_balance).toBeNull();
  });

  test("auto channel with no contact info defaults to email until contact is filled", async () => {
    const report = await runAuditPhase({
      billFixtureName: "bill-001",
      anthropicClient: mockAnthropic(scriptOneDuplicateThenFinalize()),
    });
    expect(report.strategy.chosen).toBe("email");
    expect(report.summary.outcome).toBe("in_progress");
  });
});
