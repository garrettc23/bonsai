/**
 * Comparison-engine unit tests: net-value ranking, normalized-cost handling,
 * mortgage-refi break-even gating, category dimension playbooks, and the
 * offer-card projection of the new structured fields.
 *
 * Run: bun test test/comparison-engine.test.ts
 */
import { describe, expect, test } from "bun:test";
import { netValueScore, type Baseline, type OfferRecord } from "../src/offer-agent.ts";
import {
  billKindForCategory,
  categoryForBillKind,
  dimensionsFor,
  isFinancialCategory,
  renderDimensionBlock,
} from "../src/lib/comparison-dimensions.ts";
import { offerCardFromRecord } from "../src/lib/offer-history.ts";

function baseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    label: "Test baseline",
    category: "car_insurance",
    current_provider: "Current Co",
    current_price: 250,
    ...overrides,
  };
}

function offer(overrides: Partial<OfferRecord> = {}): OfferRecord {
  return {
    provider: "Alt Co",
    price_usd: 200,
    terms_url: "https://example.com/terms",
    recommended: true,
    savings_vs_baseline: 50,
    ...overrides,
  };
}

describe("netValueScore", () => {
  test("a like-for-like clean win outranks a thinly-cheaper coverage-dropping option", () => {
    const b = baseline();
    // Clean: $200 effective, full parity, high confidence, low friction.
    const clean = offer({
      normalized_cost: { effective_monthly_usd: 200, horizon_months: 12 },
      equivalence: { keeps: ["100/300 liability"], gives_up: [], gains: [], parity_score: 1.0 },
      confidence: 0.9,
      switching_friction: "low",
    });
    // Cheaper sticker ($180) but drops coverage (low parity), shaky, hard to switch.
    const cheap = offer({
      provider: "Bargain Co",
      price_usd: 180,
      normalized_cost: { effective_monthly_usd: 180, horizon_months: 12 },
      equivalence: { keeps: [], gives_up: ["drops to state-minimum liability"], gains: [], parity_score: 0.4 },
      confidence: 0.6,
      switching_friction: "high",
    });
    expect(netValueScore(clean, b)).toBeGreaterThan(netValueScore(cheap, b));
  });

  test("a promo whose effective monthly exceeds the baseline scores zero", () => {
    const b = baseline({ current_price: 85, category: "internet" });
    // Teaser $50 but standard $95 → effective $80? Here effective > baseline.
    const promo = offer({
      provider: "TeaserNet",
      price_usd: 50,
      normalized_cost: {
        effective_monthly_usd: 90,
        horizon_months: 24,
        promo_price_usd: 50,
        promo_months: 12,
        standard_price_usd: 95,
      },
      equivalence: { keeps: ["1Gbps"], gives_up: [], gains: [], parity_score: 0.9 },
      confidence: 0.8,
      switching_friction: "medium",
    });
    expect(netValueScore(promo, b)).toBe(0);
  });

  test("friction penalizes an otherwise equal offer", () => {
    const b = baseline();
    const common = {
      normalized_cost: { effective_monthly_usd: 200, horizon_months: 12 },
      equivalence: { keeps: [], gives_up: [], gains: [], parity_score: 1.0 },
      confidence: 1.0,
    } as const;
    const low = offer({ ...common, switching_friction: "low" });
    const high = offer({ ...common, switching_friction: "high" });
    expect(netValueScore(low, b)).toBeGreaterThan(netValueScore(high, b));
  });
});

describe("netValueScore — mortgage refi gating", () => {
  const refiBaseline = baseline({ category: "mortgage_refi", current_price: 2000 });
  const refiOffer = (refi: OfferRecord["refi"]) =>
    offer({
      provider: "Lender",
      price_usd: 1800,
      normalized_cost: { effective_monthly_usd: 1800, horizon_months: 12 },
      equivalence: { keeps: ["30y term"], gives_up: [], gains: [], parity_score: 0.9 },
      confidence: 0.8,
      switching_friction: "medium",
      refi,
    });

  test("reasonable break-even + preserved term scores > 0", () => {
    const score = netValueScore(
      refiOffer({
        new_rate_pct: 5.5,
        new_term_months: 348,
        closing_costs_usd: 4000,
        monthly_payment_usd: 1800,
        break_even_months: 20,
        keeps_similar_term: true,
      }),
      refiBaseline,
    );
    expect(score).toBeGreaterThan(0);
  });

  test("break-even beyond the cap scores 0", () => {
    const score = netValueScore(
      refiOffer({
        new_rate_pct: 6.5,
        new_term_months: 360,
        closing_costs_usd: 12000,
        monthly_payment_usd: 1800,
        break_even_months: 60,
        keeps_similar_term: true,
      }),
      refiBaseline,
    );
    expect(score).toBe(0);
  });

  test("re-amortizing to a fresh term (keeps_similar_term=false) scores 0", () => {
    const score = netValueScore(
      refiOffer({
        new_rate_pct: 6.0,
        new_term_months: 360,
        closing_costs_usd: 3000,
        monthly_payment_usd: 1800,
        break_even_months: 12,
        keeps_similar_term: false,
      }),
      refiBaseline,
    );
    expect(score).toBe(0);
  });

  test("financial offer with NO refi block fails closed (scores 0)", () => {
    // A cheaper effective monthly is not enough for a refi/balance transfer —
    // without break-even + term data we can't call it a real win.
    const noRefi = offer({
      provider: "Lender",
      price_usd: 1800,
      normalized_cost: { effective_monthly_usd: 1800, horizon_months: 12 },
      equivalence: { keeps: [], gives_up: [], gains: [], parity_score: 0.9 },
      confidence: 0.9,
      switching_friction: "low",
      refi: null,
    });
    expect(netValueScore(noRefi, refiBaseline)).toBe(0);
  });
});

describe("netValueScore — guards", () => {
  test("zero/negative baseline price scores 0 (no divide-by-zero)", () => {
    const b = baseline({ current_price: 0 });
    const o = offer({ normalized_cost: { effective_monthly_usd: 50, horizon_months: 12 } });
    expect(netValueScore(o, b)).toBe(0);
  });
});

describe("comparison-dimensions", () => {
  test("every category has dimensions and a cadence", () => {
    for (const cat of [
      "car_insurance", "internet", "mortgage_refi", "credit_card", "electricity",
      "prescription", "hospital_bill", "streaming", "mobile_phone", "other",
    ] as const) {
      const d = dimensionsFor(cat);
      expect(d.dimensions.length).toBeGreaterThan(0);
      expect(d.cadence.length).toBeGreaterThan(0);
    }
  });

  test("financial categories are flagged", () => {
    expect(isFinancialCategory("mortgage_refi")).toBe(true);
    expect(isFinancialCategory("credit_card")).toBe(true);
    expect(isFinancialCategory("internet")).toBe(false);
  });

  test("renderDimensionBlock includes the label and the dimensions", () => {
    const block = renderDimensionBlock("car_insurance");
    expect(block).toContain("Car insurance");
    expect(block).toContain("liability");
  });

  test("bill-kind ↔ category mapping is coherent", () => {
    expect(categoryForBillKind("telecom")).toBe("internet");
    expect(categoryForBillKind("financial")).toBe("mortgage_refi");
    expect(billKindForCategory("internet")).toBe("telecom");
    expect(billKindForCategory("mortgage_refi")).toBe("financial");
    expect(billKindForCategory("car_insurance")).toBe("insurance");
  });
});

describe("offerCardFromRecord — structured fields", () => {
  test("uses normalized effective monthly for offered/saves and carries equivalence", () => {
    const b = baseline({ current_price: 85, category: "internet" });
    const o = offer({
      provider: "FastNet",
      price_usd: 40,
      normalized_cost: {
        effective_monthly_usd: 55,
        horizon_months: 24,
        promo_price_usd: 40,
        promo_months: 12,
        standard_price_usd: 70,
        one_time_fees_usd: 99,
      },
      equivalence: { keeps: ["1Gbps"], gives_up: ["12mo contract"], gains: ["no data cap"], parity_score: 0.85 },
      confidence: 0.8,
      verified: true,
      net_value_score: 0.3,
    });
    const card = offerCardFromRecord("file.json", b, o);
    expect(card.offered).toBe(55); // effective, not sticker $40
    expect(card.saves).toBe(30); // 85 - 55
    expect(card.equivalence?.gives_up).toContain("12mo contract");
    expect(card.promo?.standard_price).toBe(70);
    expect(card.verified).toBe(true);
    expect(card.net_value_score).toBe(0.3);
  });

  test("legacy record without normalized_cost falls back to sticker delta", () => {
    const b = baseline({ current_price: 100, category: "prescription" });
    const o = offer({ provider: "GoodRx", price_usd: 12, savings_vs_baseline: 88 });
    const card = offerCardFromRecord("file.json", b, o);
    expect(card.offered).toBe(12);
    expect(card.saves).toBe(88);
    expect(card.equivalence).toBeUndefined();
  });
});
