# Bonsai 🌿

**Medical bill audit + negotiation, end-to-end.** Upload an itemized hospital
bill and the matching EOB, and Bonsai finds errors, drafts a grounded appeal
letter, and negotiates a correction — by email or by phone.

Hackathon build for Devpost — deadline Tue 2026-04-28 12:00 PT.

```
Bill PDF + EOB PDF
       │
       ▼
  ┌─────────────┐
  │  Analyzer   │  Claude Sonnet 4.5, tool-use loop, grounding contract
  │  (src/      │  → every finding quotes a verbatim bill line
  │   analyzer) │  → overlap-aware totals (balance_billing is an envelope)
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │   Appeal    │  Deterministic markdown. No 2nd LLM → no drift.
  │   Letter    │  NSA + FCRA clauses added when grounded.
  │   (src/     │  Null metadata fields render as [BRACKETED PLACEHOLDERS].
  │   appeal-   │
  │   letter)   │
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐   auto: balance-billing ≥ $1,500 → voice, else email
  │  Strategy   │
  └──────┬──────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌──────────┐
│ Email  │ │  Voice   │  ElevenLabs Conversational AI config + server_tools
│ thread │ │   call   │  Simulator: dual-Claude (agent + role-playing rep)
│ loop   │ │  loop    │  Real tool dispatch → floor enforcement
└────────┘ └──────────┘
         │
         ▼
   BonsaiReport  — findings, letter, transcript/thread, summary $ saved
```

## Quickstart

```bash
bun install
cp .env.example .env        # set ANTHROPIC_API_KEY
bun run make-pdfs           # fixtures/*.md → fixtures/*.pdf
bun run test                # 33 tests, <100ms
bun run bonsai              # end-to-end CLI on bill-001, auto channel
bun run serve               # web UI at http://localhost:3333
```

## What works

| Layer | Command | Status |
|---|---|---|
| Analyzer | `bun run day2 bill-001 eob-001` | Grounded, 2-tier confidence, overlap-aware totals |
| Appeal letter | `bun run day3 bill-001 eob-001` | Deterministic, placeholder-aware, NSA + FCRA |
| Email negotiation | `bun run day4 bill-001 stall_then_concede` | Full loop, Resend-or-Mock, 4 rep personas |
| Voice negotiation | `bun run day5 bill-001 stall_then_concede` | ElevenLabs config ready, simulator validates tools |
| Full pipeline CLI | `bun run bonsai bill-001 eob-001 auto` | Analyzer → letter → strategy → negotiate → report |
| Web UI | `bun run serve` | Upload or fixture, tabs: findings / letter / conversation / raw |

## Commands

```bash
# Development
bun run typecheck         # tsc --noEmit (via bun for dyld reasons)
bun run test              # bun test — 33 tests
bun run make-pdfs         # regenerate fixture PDFs after editing .md

# Per-stage CLIs (debugging)
bun run day2 <bill> <eob>                    # analyzer only
bun run day3 <bill> <eob>                    # analyzer → letter
bun run day4 <bill> [persona]                # email loop, one fixture
bun run day5 <bill> [persona]                # voice simulator, one fixture

# Full pipeline
bun run bonsai [bill] [eob] [channel] [persona]
#   bill:    fixture name, default bill-001
#   eob:     fixture name, default eob-001
#   channel: auto | email | voice, default auto
#   persona: stall_then_concede | hostile | quick_concede | cooperative | voicemail | outright_deny

# Web server
PORT=3333 bun run serve
```

## Grounding contract

Every finding the analyzer reports must:

1. Quote a verbatim row from the bill (`line_quote`). If the quote doesn't
   appear in the bill markdown ground-truth, the tool call is **rejected**
   with `is_error: true` and Claude retries. See `src/lib/ground-truth.ts`.
2. Name a 1-indexed `page_number`.
3. Commit to a `confidence` tier. Only the 2-tier set can be HIGH:
   `duplicate`, `denied_service`, `balance_billing`. Everything else is
   `worth_reviewing` and never ships to billing departments.
4. Justify itself with EOB `evidence`.

The grounding contract is the difference between "LLM reads a bill" and
"agent a patient can hand to their insurer." A hallucinated line quote
would be caught before it lands in an appeal letter.

## Overlap-aware totals

The #1 arithmetic mistake when scoring a bill is summing a `balance_billing`
finding with the line items it already subsumes (e.g. balance-billing of
$3,812 is caused by 5 denied lines totaling $3,590; summing = $7,402 is wrong,
the real defensible total is $3,812).

Rule:

```
defensibleTotal =
  no balance_billing  → sum(HIGH)
  has balance_billing → max( max(balance_billing), sum(HIGH ∖ balance_billing) )
```

`src/analyzer.ts:computeDefensibleTotal` implements this and is unit-tested
(`test/compute-defensible-total.test.ts`). The analyzer also auto-repairs
Claude's reported summary if it violates this rule (look for
`auto-corrected` in the headline).

## Channel strategy

```
auto + balance_billing finding + HIGH ≥ $1,500  → voice
auto + anything else                             → email
explicit email/voice                             → honored verbatim
```

Rationale: balance-billing disputes above $1,500 almost always need a rep
on the phone to remove the write-off from the account. Below that threshold,
email is cheaper and leaves a paper trail.

## Negotiation loops

**Email (`src/negotiate-email.ts`).** Claude drafts a reply using only facts
from the analyzer's grounded findings, has 3 tools (`send_email`, `mark_resolved`,
`escalate_human`), and holds to a `final_acceptable_floor` (defaults to EOB
patient responsibility). Escalates after 3 flat denials. State is persisted
in `out/threads/{thread_id}.state.json`.

**Voice (`src/voice/`).** Generates an ElevenLabs Conversational AI agent
config with 5 server_tools (`get_disputed_line`, `confirm_eob_amount`,
`record_negotiated_amount`, `request_human_handoff`, `end_call`). The
simulator (`src/voice/simulator.ts`) uses dual-Claude — one plays our agent
(using the real agent config), another role-plays a billing-dept rep with
one of 4 personas. Tool calls dispatch to the real handlers
(`src/voice/tool-handlers.ts`), so when we swap in real ElevenLabs the same
tool code runs.

**Simulator personas.**

- `cooperative` — rep acknowledges errors after 1-2 rounds
- `stall_then_concede` — rep stalls twice, then gives in (default)
- `hostile` — rep denies everything, tests escalation logic
- `quick_concede` / `outright_deny` — email-specific
- `voicemail` — voice-specific, tests voicemail handoff

## Grounding in real life (what's simulated vs real)

| Integration | Status | To go real |
|---|---|---|
| Claude API | **real** | Already using `@anthropic-ai/sdk` |
| Email send | **mock by default, Resend if env set** | Set `RESEND_API_KEY` + `RESEND_FROM` |
| Email inbound | simulator (Claude role-plays reply) | Resend inbound webhook → `email-resend.ts` |
| Voice call | **full simulator** (no real dial yet) | Create ElevenLabs + Twilio accounts, wire webhook |
| OCR on uploaded PDFs | requires matching fixture .md | Add `unpdf` or vendor LLM OCR — noted in `server.ts` |

All fixtures are synthetic. No real PHI. This is a hackathon prototype and
is not medical, legal, or financial advice.

## Tests

```bash
bun test
```

- `test/compute-defensible-total.test.ts` — overlap math
- `test/appeal-letter.test.ts` — placeholders, NSA clause gating, verbatim quote preservation
- `test/choose-channel.test.ts` — routing heuristic
- `test/types.test.ts` — BillingError + BillMetadata schema guardrails

## Layout

```
src/
  analyzer.ts            # PDF → errors + metadata via tool-use loop
  appeal-letter.ts       # deterministic markdown generator
  negotiate-email.ts     # Claude-driven email negotiation loop
  simulate-reply.ts      # role-playing rep for email simulator
  orchestrator.ts        # runBonsai() — single end-to-end entry
  server.ts              # Bun.serve HTTP + upload + fixture API
  env.ts                 # explicit .env loader (bun sandbox quirk)
  types.ts               # BillingError / BillMetadata / AnalyzerResult
  clients/
    email.ts             # EmailClient interface
    email-mock.ts        # in-memory thread state for simulator
    email-resend.ts      # real client + autoEmailClient() factory
  tools/
    record-metadata.ts
    record-error.ts      # enforces grounding contract
    finalize.ts
  voice/
    agent-config.ts      # generates ElevenLabs agent system prompt + server_tools
    client.ts            # POST /v1/convai/*
    simulator.ts         # dual-Claude: agent + persona-driven rep
    tool-handlers.ts     # real dispatch used by both webhook + simulator
  lib/
    ground-truth.ts      # line_quote verbatim validator

scripts/
  day1-poc.ts            # prose-output POC (stage reference)
  day2-analyzer.ts       # analyzer CLI
  day3-appeal.ts         # letter CLI
  day4-negotiate-email.ts
  day5-voice-call.ts
  run-bonsai.ts          # full pipeline CLI (bun run bonsai)
  make-fixture-pdfs.ts   # headless chrome md → pdf

fixtures/
  bill-001.md / .pdf, eob-001.md / .pdf     # ER visit, 6 errors
  bill-002.md / .pdf, eob-002.md / .pdf     # outpatient arthroscopy, 7 errors

public/                  # static web UI
  index.html
  assets/app.css
  assets/app.js

test/                    # bun test
```

## Two fixtures validated end-to-end

| Fixture | Original balance | Defensible | Voice final | Email final | Channel heuristic |
|---|---:|---:|---:|---:|---|
| bill-001 | $6,371.50 | $3,612 | $2,759.50 | $2,559.50 | voice (BB ≥ $1,500) |
| bill-002 | $7,149.00 | $6,517 | $632.00 | — | voice (BB ≥ $1,500) |

Saved range: **$3,612 – $6,517 per bill** across the two fixtures.

## Known follow-ups

- Live PDF text extraction (currently uploaded PDFs require a matching
  `fixtures/<name>.md` for ground-truth line_quote validation). Wire in
  `unpdf` or similar.
- Real ElevenLabs + Twilio wiring for voice (simulator is complete; swap is
  one-env-var + webhook URL config).
- Real Resend inbound webhook handler for email replies in prod.
- `out/` artifacts (reports, thread state, call transcripts) are file-based
  — fine for a single-user demo, not for multi-tenant.

## Disclaimer

Bonsai is grounded in the EOB. Every disputed finding quotes a verbatim
line from the bill or EOB. Dollar totals are overlap-aware. Still: this
is a hackathon prototype. Not medical, legal, or financial advice.
