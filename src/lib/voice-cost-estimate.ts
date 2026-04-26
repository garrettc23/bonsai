/**
 * Voice-call cost estimator.
 *
 * Pinned per-minute rates; bump these as carrier / model pricing shifts.
 * The agent currently runs on `gemini-2.0-flash-001` (see agent-config.ts);
 * the `anthropic` line item is named for the spec but reflects whatever
 * reasoning model the agent uses — keep the constant easy to retune.
 */

export const RATE_TWILIO_PER_MIN = 0.014;
export const RATE_ELEVENLABS_PER_MIN = 0.10;
export const RATE_ANTHROPIC_PER_MIN = 0.05;

export const DEFAULT_MIN_MINUTES = 5;
export const DEFAULT_MAX_MINUTES = 15;

export interface CostComponents {
  twilio: number;
  elevenlabs: number;
  anthropic: number;
}

export interface CostEstimate {
  min_usd: number;
  max_usd: number;
  components: CostComponents;
}

function totalPerMin(): number {
  return RATE_TWILIO_PER_MIN + RATE_ELEVENLABS_PER_MIN + RATE_ANTHROPIC_PER_MIN;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Estimate the cost of a call. Pass an estimated duration to compute the
 * point cost; pass nothing to get the default 5-15 min range. `components`
 * is computed at the duration that yields `max_usd` so the operator can
 * see the worst-case breakdown.
 */
export function estimateCallCost(estimatedDurationMin?: number): CostEstimate {
  const perMin = totalPerMin();
  if (typeof estimatedDurationMin === "number" && Number.isFinite(estimatedDurationMin)) {
    const cost = round2(perMin * estimatedDurationMin);
    return {
      min_usd: cost,
      max_usd: cost,
      components: {
        twilio: round2(RATE_TWILIO_PER_MIN * estimatedDurationMin),
        elevenlabs: round2(RATE_ELEVENLABS_PER_MIN * estimatedDurationMin),
        anthropic: round2(RATE_ANTHROPIC_PER_MIN * estimatedDurationMin),
      },
    };
  }
  return {
    min_usd: round2(perMin * DEFAULT_MIN_MINUTES),
    max_usd: round2(perMin * DEFAULT_MAX_MINUTES),
    components: {
      twilio: round2(RATE_TWILIO_PER_MIN * DEFAULT_MAX_MINUTES),
      elevenlabs: round2(RATE_ELEVENLABS_PER_MIN * DEFAULT_MAX_MINUTES),
      anthropic: round2(RATE_ANTHROPIC_PER_MIN * DEFAULT_MAX_MINUTES),
    },
  };
}
