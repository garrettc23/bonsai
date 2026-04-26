// Group bills by normalized provider_name and assign Finder-style suffixes
// ("Memorial Hospital", "Memorial Hospital (1)", "Memorial Hospital (2)").
//
// Input rows are assumed to be newest-first (the order /api/history and
// /api/receipts return). We walk in REVERSE so the OLDEST entry keeps the
// unsuffixed name and newer dupes pick up "(1)", "(2)", etc.
//
// - Trims trailing whitespace and lowercases for grouping; preserves the
//   original casing/spacing when rendering.
// - Skips dedup for empty / placeholder names ("", null, "Unknown
//   provider") — suffixing a placeholder makes it worse.
//
// Returns Map<rowKey, displayName>. The caller picks a stable key (e.g.
// audit.name for audit rows, r.name for receipt rows).

export interface DisplayNameOptions<T> {
  getKey: (row: T) => string;
  getName: (row: T) => string | null | undefined;
}

export function computeDisplayNames<T>(
  rows: readonly T[] | null | undefined,
  opts: DisplayNameOptions<T>,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!Array.isArray(rows) || rows.length === 0) return out;
  const counts = new Map<string, number>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const key = opts.getKey(row);
    const raw = opts.getName(row);
    if (typeof raw !== "string" || raw.length === 0) {
      out.set(key, raw ?? null);
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed || /^unknown provider$/i.test(trimmed)) {
      out.set(key, raw);
      continue;
    }
    const norm = trimmed.toLowerCase();
    const n = counts.get(norm) ?? 0;
    out.set(key, n === 0 ? trimmed : `${trimmed} (${n})`);
    counts.set(norm, n + 1);
  }
  return out;
}
