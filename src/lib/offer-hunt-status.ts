export interface OfferHuntStatusFields {
  baselines_total: number;
  baselines_done: number;
  started_at: number;
  ended_at?: number;
  status: "in_flight" | "done";
}

export interface OfferHuntStatusPayload {
  in_flight: boolean;
  baselines_total: number;
  baselines_done: number;
  started_at: number | null;
  ended_at: number | null;
}

export function projectOfferHuntStatus(
  fields: OfferHuntStatusFields | null | undefined,
): OfferHuntStatusPayload {
  if (!fields) {
    return {
      in_flight: false,
      baselines_total: 0,
      baselines_done: 0,
      started_at: null,
      ended_at: null,
    };
  }
  return {
    in_flight: fields.status === "in_flight",
    baselines_total: fields.baselines_total,
    baselines_done: fields.baselines_done,
    started_at: fields.started_at,
    ended_at: fields.ended_at ?? null,
  };
}
