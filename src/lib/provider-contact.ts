/**
 * Provider contact resolution.
 *
 * Given a provider name (and optionally a billing address), use Claude with
 * the web-search server tool to surface the customer-support email and/or
 * phone number for that provider's billing department. Results are cached
 * in `provider_contacts` (SQLite) by a normalized key so the same provider
 * isn't re-resolved on every bill. Surfaces `confidence` and `source_urls`
 * so the user can sanity-check before negotiation goes out.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./db.ts";

const MODEL = "claude-opus-4-7";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";

export type ContactConfidence = "high" | "medium" | "low";

export interface ResolvedProviderContact {
  email: string | null;
  phone: string | null;
  source_urls: string[];
  confidence: ContactConfidence;
  /** A short human-readable note about how the contact was identified. */
  notes: string;
  /** Cache key the row is stored under (for debugging / cache busting). */
  cache_key: string;
  /** When this row was resolved (unix ms). */
  resolved_at: number;
}

interface ProviderContactRow {
  cache_key: string;
  provider_name: string;
  provider_address: string | null;
  email: string | null;
  phone: string | null;
  source_urls: string;
  confidence: ContactConfidence;
  notes: string | null;
  resolved_at: number;
}

function normalizeKey(name: string, address?: string | null): string {
  const a = (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const b = (address ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return b ? `${a}||${b}` : a;
}

export interface ResolveProviderContactOpts {
  provider_name: string;
  provider_address?: string | null;
  /** Skip cache (force a fresh web search). */
  bypassCache?: boolean;
  /** Override the Claude client (for testing). */
  anthropic?: Anthropic;
}

const REPORT_TOOL: Anthropic.Tool = {
  name: "report_provider_contact",
  description:
    "Report the billing department's customer-support contact info you found. Always cite source_urls. Use null when you cannot find a value with reasonable confidence.",
  input_schema: {
    type: "object",
    required: ["confidence", "source_urls", "notes"],
    properties: {
      email: {
        type: ["string", "null"],
        description:
          "Billing-department customer-support email. Prefer addresses ending in the provider's domain. Null if no reliable email was found.",
      },
      phone: {
        type: ["string", "null"],
        description:
          "Billing-department customer-support phone, formatted with country code (e.g. +1-415-555-0132). Null if no reliable phone was found.",
      },
      source_urls: {
        type: "array",
        items: { type: "string" },
        description:
          "URLs you actually visited to derive these values. Empty array means you couldn't ground the answer.",
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description:
          "high = found on the provider's own domain billing page; medium = found on a credible third-party (state board, BBB, insurance directory); low = inferred from indirect signals or single uncorroborated source.",
      },
      notes: {
        type: "string",
        description:
          "1-2 sentences explaining how you identified the contact (page title, document type, etc.).",
      },
    },
  },
};

const SYSTEM_PROMPT = `You are Bonsai's contact-resolution agent. Given a healthcare or service provider's name (and possibly an address), find their billing department's customer-support email and phone.

Search strategy:
- Start with the provider's official site. The "Patient Accounts", "Billing Inquiries", or "Customer Service" page is your best bet.
- For small clinics, fall back to the practice's "Contact Us" page.
- For hospital systems, distinguish billing vs general operator — only return the BILLING contact.
- For utility, telecom, or subscription providers, find their corporate billing-support page (not sales).
- Prefer the toll-free or local-area phone listed on the billing page. Format as +1-AAA-BBB-CCCC for US numbers.
- Prefer an email on the provider's own domain over a generic info@ alias.

When you cannot find a reliable answer:
- Return email or phone as null rather than guessing.
- Set confidence to "low" and explain why in notes.

Reply ONLY via the report_provider_contact tool. No prose outside the tool call.`;

function loadCache(cache_key: string): ResolvedProviderContact | null {
  const row = getDb()
    .query(
      "SELECT cache_key, provider_name, provider_address, email, phone, source_urls, confidence, notes, resolved_at FROM provider_contacts WHERE cache_key = ?",
    )
    .get(cache_key) as ProviderContactRow | null;
  if (!row) return null;
  let urls: string[] = [];
  try {
    urls = JSON.parse(row.source_urls) as string[];
    if (!Array.isArray(urls)) urls = [];
  } catch {
    urls = [];
  }
  return {
    email: row.email,
    phone: row.phone,
    source_urls: urls,
    confidence: row.confidence,
    notes: row.notes ?? "",
    cache_key: row.cache_key,
    resolved_at: row.resolved_at,
  };
}

function saveCache(
  cache_key: string,
  provider_name: string,
  provider_address: string | null,
  contact: Omit<ResolvedProviderContact, "cache_key" | "resolved_at">,
): ResolvedProviderContact {
  const now = Date.now();
  getDb()
    .query(
      `INSERT OR REPLACE INTO provider_contacts
       (cache_key, provider_name, provider_address, email, phone, source_urls, confidence, notes, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cache_key,
      provider_name,
      provider_address,
      contact.email,
      contact.phone,
      JSON.stringify(contact.source_urls),
      contact.confidence,
      contact.notes,
      now,
    );
  return { ...contact, cache_key, resolved_at: now };
}

export async function resolveProviderContact(
  opts: ResolveProviderContactOpts,
): Promise<ResolvedProviderContact> {
  const cache_key = normalizeKey(opts.provider_name, opts.provider_address ?? null);
  if (!opts.bypassCache) {
    const hit = loadCache(cache_key);
    if (hit) return hit;
  }

  const anthropic = opts.anthropic ?? new Anthropic();
  const userMessage = [
    `Provider name: ${opts.provider_name}`,
    opts.provider_address ? `Provider billing address (from the bill): ${opts.provider_address}` : null,
    "",
    "Find the customer-support EMAIL and PHONE for this provider's billing department. Cite each source_url you actually used.",
  ]
    .filter(Boolean)
    .join("\n");

  // The web_search server tool runs entirely on Anthropic's side — we don't
  // dispatch tool calls. We just need to read the final tool_use back out.
  // Cap searches modestly so we don't burn 8 web hits on every audit.
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [
      { type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: 4 } as unknown as Anthropic.Tool,
      REPORT_TOOL,
    ],
    tool_choice: { type: "tool", name: "report_provider_contact" },
    messages: [{ role: "user", content: userMessage }],
  });

  const toolBlock = resp.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock =>
      b.type === "tool_use" && b.name === "report_provider_contact",
  );
  if (!toolBlock) {
    // The model didn't return our reporting tool — record an unresolved row
    // so we don't re-spend the search budget on the next call. Cache TTL can
    // be added if we ever want to retry.
    const empty = saveCache(cache_key, opts.provider_name, opts.provider_address ?? null, {
      email: null,
      phone: null,
      source_urls: [],
      confidence: "low",
      notes: "Resolver returned no structured result.",
    });
    return empty;
  }

  const input = toolBlock.input as {
    email?: string | null;
    phone?: string | null;
    source_urls?: unknown;
    confidence?: ContactConfidence;
    notes?: string;
  };
  const urls = Array.isArray(input.source_urls)
    ? (input.source_urls.filter((u): u is string => typeof u === "string"))
    : [];
  const cleaned = {
    email: typeof input.email === "string" && input.email.trim() ? input.email.trim() : null,
    phone: typeof input.phone === "string" && input.phone.trim() ? input.phone.trim() : null,
    source_urls: urls,
    confidence: (input.confidence ?? "low") as ContactConfidence,
    notes: typeof input.notes === "string" ? input.notes.trim() : "",
  };
  return saveCache(cache_key, opts.provider_name, opts.provider_address ?? null, cleaned);
}

/** Wipe a cached entry — useful when the user manually corrects the contact. */
export function invalidateProviderContact(provider_name: string, provider_address?: string | null): void {
  getDb().query("DELETE FROM provider_contacts WHERE cache_key = ?").run(normalizeKey(provider_name, provider_address ?? null));
}
