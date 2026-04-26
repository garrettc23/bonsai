export const PROBABILITY_FLOOR = 0.5;

export type OppLike = { probability?: number };

export function filterByProbability<T extends OppLike>(opps: T[]): T[] {
  return opps.filter(
    (o) => typeof o.probability === "number" && Number.isFinite(o.probability) && o.probability >= PROBABILITY_FLOOR,
  );
}

export const OPPS_TOOL = {
  name: "propose_opportunities",
  description: `Return 3-6 bill-specific strategies to lower this bill, each with a >=${PROBABILITY_FLOOR} probability of actually working.`,
  input_schema: {
    type: "object",
    required: ["opportunities"],
    properties: {
      opportunities: {
        type: "array",
        minItems: 3,
        maxItems: 6,
        items: {
          type: "object",
          required: ["opp_id", "title", "description", "dollar_estimate", "icon", "probability"],
          properties: {
            opp_id: {
              type: "string",
              description: "Short stable slug for this opportunity, e.g. 'dispute-duplicate-cpt' or 'apply-charity-care'.",
            },
            title: { type: "string", description: "2-6 words, imperative." },
            description: {
              type: "string",
              description: "1-2 sentences, concrete, references the bill when helpful.",
            },
            dollar_estimate: {
              type: "number",
              minimum: 0,
              description: "Realistic savings in dollars. 0 if truly unknown.",
            },
            icon: {
              type: "string",
              enum: ["shield", "scan", "pulse", "doc", "phone", "mail", "pill", "hospital", "sparkle", "check"],
              description: "Pick the icon that best matches the strategy's vibe.",
            },
            probability: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: `Likelihood this strategy actually reduces the charge (0.0-1.0). Only emit opportunities with probability >= ${PROBABILITY_FLOOR}.`,
            },
          },
        },
      },
    },
  },
};
