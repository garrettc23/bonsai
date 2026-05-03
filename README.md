# Bonsai 🌿

**Agents to manage personal bills.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Bun ≥ 1.1](https://img.shields.io/badge/Bun-%E2%89%A5%201.1-black)](https://bun.sh)

People leak money constantly across insurance, rent, lines of credit, taxes, medical bills, utilities, and dozens of other recurring costs. In most cases nobody is actively managing these expenses because the savings on any single line item don't justify the time. But in aggregate, the waste is real. The tools that exist today require a human to initiate each comparison or negotiation, which means it mostly doesn't happen — bills go unexamined and contracts auto-renew at whatever rate the vendor set.

Bonsai is a self-hostable set of agents that runs in the background and continuously looks for savings across every category of spend. Not a dashboard that tells you where you're overpaying — agents that actually renegotiate the electric bill, find a cheaper insurance policy, or flag when a credit line's terms are no longer competitive. The wedge is a general-purpose cost optimization agent for people that quietly saves them money while they sleep.

## Why this exists

- **Agents that act, not dashboards that report.** Bonsai writes the appeal, drafts the email, dials the rep. You approve every move; the agents do the work.
- **Grounding contract.** Every dispute quotes the source verbatim. Every dollar amount traces back to a line on the bill or a clause in the EOB. Hallucinations don't ship.
- **You own your data.** Bring your own keys, deploy your own instance. Bonsai never phones home and there is no operator-paid default that could route your traffic through someone else's account.

## Quickstart

```bash
git clone https://github.com/<your-fork>/bonsai.git
cd bonsai
bun install
cp .env.example .env       # fill in ANTHROPIC_API_KEY + BONSAI_PUBLIC_DOMAIN
bun run make-pdfs          # synthetic fixture PDFs
bun run serve              # http://localhost:3333
```

Bonsai refuses to start until the required env vars are set — see `src/env.ts:validateRequiredEnv`.

## The five agents

```
Bill / contract / statement
       │
       ▼
  ┌───────────┐
  │  Analyzer │   Reads any bill, finds errors and overcharges,
  │           │   quotes the offending lines verbatim.
  └─────┬─────┘
        │
        ▼
  ┌───────────┐
  │   Appeal  │   Drafts a grounded letter that cites the source.
  │           │   No second LLM, no drift. NSA + FCRA clauses where applicable.
  └─────┬─────┘
        │
        ▼
  ┌───────────┐
  │  Contact  │   Resolves the right department + channel for the merchant.
  │ Resolver  │   Web search via Anthropic managed agents.
  └─────┬─────┘
        │
        ▼
  ┌───────────┐   email when the dispute lives in writing,
  │Negotiation│   voice when a rep needs to clear a write-off live.
  │ (email +  │   Holds to a `final_acceptable_floor`. Escalates after
  │   voice)  │   N flat denials.
  └─────┬─────┘
        │
        ▼
  ┌───────────┐   When negotiation isn't the right path: surveys cheaper
  │Comparison │   alternatives (insurance, telecom, utilities, credit) and
  │           │   gates them on switch-probability before showing them.
  └─────┬─────┘
        │
        ▼
   BonsaiReport — findings, letter, transcript/thread, summary $ saved
```

**Analyzer.** Claude Opus 4.7 with a tool-use loop. Reads the bill PDF (text-extracted) plus any supporting docs (EOB, contract, statement) and emits structured `BillingError` rows. Every row carries a verbatim `line_quote`, a 1-indexed `page_number`, a confidence tier, and the supporting evidence. Findings that fail the grounding check are rejected and the model retries.

**Appeal.** A deterministic markdown generator. Reads the analyzer's findings and produces a letter the user can send. No LLM in this step — placeholders are bracketed, NSA / FCRA clauses are added when grounded, and missing metadata renders as `[BRACKETED PLACEHOLDERS]` instead of being silently invented.

**Contact resolver.** Locates the right billing-department email + phone for the merchant on the bill. Backed by web search via Anthropic managed agents. Returns a confidence tier so the orchestrator can fall back to user-supplied contact info when the resolver is uncertain.

**Negotiation.** A two-channel loop:
- **Email** (`src/negotiate-email.ts`) — Claude drafts replies using only facts from grounded findings, has 3 tools (`send_email`, `mark_resolved`, `escalate_human`), and holds to a configurable floor. State persists in `out/threads/{thread_id}.state.json`.
- **Voice** (`src/voice/`) — generates an ElevenLabs Conversational AI agent config with 5 server tools. Real outbound calls go through ElevenLabs + Twilio when the env is wired; otherwise a dual-Claude simulator role-plays both sides so day-to-day dev never burns minutes.

Negotiation runs in one of two **agent modes** (per-user setting, top of the Settings page):

- **Autonomous** (default) — the agent decides when to accept, push back, or escalate. The user only gets pinged when something needs a human (`escalate_human`, signature required, or stalemate).
- **Co-pilot** — the agent pauses on every proposed resolution and hands off to the user. The user accepts via `POST /api/threads/:id/accept` or counters via `POST /api/threads/:id/push-back`. After `MAX_PUSH_BACK_ROUNDS` rounds the next push-back force-escalates to a human. Any finding flagged `requires_signature` always gates on the user, regardless of mode. Threads that sit in `awaiting_user_review` for more than 7 days are swept into `escalated_human` so nothing rots silently.

Notifications (durable in-app inbox + Resend email) are written by `src/lib/notify-user.ts` and read via `GET /api/notifications/inbox`.

**Comparison.** When the cheaper move is to switch providers (insurance, telecom, utilities, credit), the comparison agent surveys alternatives via Anthropic managed agents and gates them on switch-probability before surfacing. The probability floor is configurable per category.

## Channel strategy

```
balance_billing finding + HIGH ≥ $1,500  → voice
anything else                            → email
explicit email/voice                     → honored verbatim
```

Voice gets used when a rep needs to clear a write-off live. Below that threshold, email is cheaper, leaves a paper trail, and is harder for the merchant to wave away.

## Grounding contract

Every finding the analyzer reports must:

1. Quote a verbatim row from the bill (`line_quote`). If the quote doesn't appear in the source ground-truth, the tool call is **rejected** with `is_error: true` and Claude retries. See `src/lib/ground-truth.ts`.
2. Name a 1-indexed `page_number`.
3. Commit to a `confidence` tier. Only the canonical HIGH set ships to merchants; everything else is `worth_reviewing` and never leaves the dashboard.
4. Justify itself with `evidence` from the matching reference doc (EOB for medical, contract for telecom/utilities, etc.).

The grounding contract is the difference between "LLM reads a bill" and "agent a person can hand to their insurer / utility / telecom." Hallucinated line quotes don't make it into outbound mail.

## Overlap-aware totals

The #1 arithmetic mistake when scoring a bill is summing a `balance_billing` finding with the line items it already subsumes (e.g. balance-billing of $3,812 is caused by 5 denied lines totaling $3,590; summing = $7,402 is wrong, the real defensible total is $3,812).

```
defensibleTotal =
  no balance_billing  → sum(HIGH)
  has balance_billing → max( max(balance_billing), sum(HIGH ∖ balance_billing) )
```

`src/analyzer.ts:computeDefensibleTotal` implements this and is unit-tested. The analyzer also auto-repairs Claude's reported summary if it violates the rule (look for `auto-corrected` in the headline).

## What works

| Layer | Status |
|---|---|
| Analyzer | Live. Grounded, two-tier confidence, overlap-aware totals. |
| Appeal letter | Live. Deterministic, placeholder-aware, NSA + FCRA clauses where applicable. |
| Contact resolver | Live. Web search via Anthropic managed agents. |
| Email negotiation | Live (Resend). Real outbound + svix-verified inbound webhook. Mock fallback for local dev. |
| Voice negotiation | Live (ElevenLabs + Twilio). Simulator runs when any voice env var is unset. |
| Comparison | Live. Probability-gated. Anthropic managed agents survey alternatives. |
| Web UI | Live. Upload, audit, dashboard with receipts, agent-reasoning timeline. |

## Self-host on Railway

Bonsai ships with a `Dockerfile` and `railway.json` that get you to a live HTTPS URL in a few minutes. From a fresh clone to the first real audit should take under 30 minutes.

### 1. Initialize

```bash
brew install railway          # or: npm i -g @railway/cli
railway login
railway init                  # creates a new project
railway up                    # uploads + builds via the Dockerfile
```

The URL will 502 until step 2's env vars are set.

### 2. Set required env vars

| Var | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` from console.anthropic.com (Opus 4.7 requires a paid plan) |
| `BONSAI_PUBLIC_DOMAIN` | your deployed domain, e.g. `bonsai.example.com` |
| `NODE_ENV` | `production` (flips cookie `Secure` flag + webhook fail-closed) |
| `BONSAI_DATA_DIR` | `/app/data` (matches the volume mount in step 4) |

### 3. Set the optional env vars you need

Add only what you'll use. Each integration degrades gracefully when its keys are missing — no operator-paid fallback ever runs.

| Var(s) | Enables | Without it |
|---|---|---|
| `RESEND_API_KEY` + `RESEND_FROM` | Real outbound email | Email loop runs in mock mode (writes to `out/`, never sends) |
| `RESEND_WEBHOOK_SECRET` | Inbound replies from merchants | In `NODE_ENV=production` the inbound webhook returns 500 (fail-closed) |
| All four `ELEVENLABS_*` vars | Real outbound voice calls | Voice runs in dual-Claude simulator |
| `SENTRY_DSN` | (reserved) | No-op today |

### 4. Mount the `/app/data` volume

Dashboard → Settings → Volumes → New Volume:
- Mount path: `/app/data`
- Size: 1 GB

Then `railway up` once more so the volume + env vars are picked up together. Signups, bills, threads, and call transcripts now survive deploys.

### 5. Verify Resend inbound

After pointing Resend's inbound webhook at `https://<your-domain>/webhooks/resend-inbound`:

```bash
bash scripts/resend-inbound-smoke.sh \
  --url https://<your-domain> \
  --secret "$RESEND_WEBHOOK_SECRET" \
  --debug-token "$BONSAI_WEBHOOK_DEBUG_TOKEN" \
  --echo
# expect: signature_valid:true, exit 0
```

If `signature_valid:false`, the secret on Railway doesn't match the one in Resend's dashboard, or your laptop's clock is more than 5 minutes off (svix replay window).

### 6. Verify outbound voice

Gated on the four `ELEVENLABS_*` env vars. Dials a number you own as a 30-second smoke test:

```bash
BONSAI_VOICE_SMOKE_TO=+15555550123 \
BONSAI_VOICE_SMOKE_USER_EMAIL=you@example.com \
bun run scripts/voice-smoke.ts
```

The phone rings, the agent reads the opening line, hangup writes a transcript to `out/users/<id>/calls/`.

## Backups

Railway's volume isn't snapshotted by default — one disk fault loses every user's SQLite, threads, transcripts, and uploaded bills. The server can push a nightly tarball of `BONSAI_DATA_DIR` to any S3-compatible object store. Backups are **opt-in**: with the four env vars below unset, the server boots and logs `[backup] disabled` — nothing else happens.

Recommended: [Backblaze B2](https://www.backblaze.com/cloud-storage) (S3-compatible, ~6× cheaper than S3 for storage, cheap egress). Cloudflare R2, AWS S3, and self-hosted MinIO all work too — same env vars.

```bash
BACKUP_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com
BACKUP_S3_BUCKET=bonsai-backups
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
```

What happens after the next deploy:

- On boot, if no successful backup is recorded — or the last one is more than 25 hours old — the server fires a catch-up run immediately.
- Every 24 hours, the same job tars `BONSAI_DATA_DIR`, streams it to `bonsai-backups/YYYY-MM-DD.tar.gz`, and prunes anything older than 30 days.
- Backup failures are non-fatal — they log `[backup] FAILED` and the next run retries.

To verify a backup is recoverable:

```bash
bun run scripts/restore-backup.ts latest
# Validates the tar contents and prints the exact tar -xzf command to run.
# Never auto-extracts (restore is destructive).
```

Cost note: at typical beta scale (tens of MB per user × hundreds of users × 30-day retention) this runs single-digit dollars per month on B2.

## Configuration

Every env var, in one place. See `.env.example` for the canonical reference.

| Var | Required? | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | **yes** | Opus 4.7 access for analysis, appeal, negotiation, comparison |
| `BONSAI_PUBLIC_DOMAIN` | **yes** | Your deployed domain — forcing function so a fork doesn't ship someone else's URL |
| `RESEND_API_KEY` | optional | Real outbound email |
| `RESEND_FROM` | optional | Verified sender, e.g. `Bonsai Appeals <appeals@your-domain.com>` |
| `RESEND_WEBHOOK_SECRET` | optional (req. in prod) | Svix signing secret for inbound webhook |
| `BONSAI_WEBHOOK_DEBUG_TOKEN` | optional | Unlocks the read-only echo route on the inbound webhook |
| `ELEVENLABS_API_KEY` | optional | Real outbound voice |
| `ELEVENLABS_TWILIO_PHONE_NUMBER_ID` | optional | ElevenLabs ID for the imported Twilio number |
| `ELEVENLABS_WEBHOOK_BASE` | optional | Public root for ElevenLabs server-tool callbacks |
| `ELEVENLABS_WEBHOOK_SECRET` | optional | Bearer secret for inbound voice tool callbacks |
| `NODE_ENV` | optional | `production` flips cookie `Secure` + webhook fail-closed |
| `BONSAI_DATA_DIR` | optional | Persistent data dir; defaults to `<repo>/out` |
| `PORT` | optional | HTTP port for the web UI; default 3333 |
| `SENTRY_DSN` | optional | Reserved |
| `BONSAI_AUDIT_DAILY_LIMIT` | optional | Per-user daily audit cap; default 5 |
| `BONSAI_VOICE_DAILY_LIMIT` | optional | Per-user daily call cap; default 5 |
| `BONSAI_VOICE_DAILY_BUDGET_USD` | optional | Operator-wide daily voice budget; default 50 |
| `VOICE_DRY_RUN` | optional | `true` logs the call we'd place without dialing |
| `BONSAI_SUPPORT_EMAIL` | optional | Public support address for the SPA + landing footer (via `/api/public-config`) |
| `BACKUP_S3_ENDPOINT` | optional | S3-compatible endpoint for nightly volume backup (B2, R2, S3, MinIO) |
| `BACKUP_S3_BUCKET` | optional | Bucket name for nightly backups |
| `BACKUP_S3_ACCESS_KEY_ID` | optional | Access key for the backup bucket |
| `BACKUP_S3_SECRET_ACCESS_KEY` | optional | Secret key for the backup bucket |

## Commands

```bash
# Development
bun run typecheck         # tsc --noEmit
bun run test              # bun test
bun run make-pdfs         # regenerate fixture PDFs after editing .md

# Per-stage CLIs (debugging)
bun run day1 ... day5     # stage-by-stage harnesses; see scripts/

# Full pipeline
bun run bonsai [bill] [eob] [channel] [persona]
#   channel: auto | email | voice (default auto)
#   persona: stall_then_concede | hostile | quick_concede | cooperative | voicemail | outright_deny

# Web server
PORT=3333 bun run serve
```

## HTTP endpoints

- `POST /webhooks/resend-inbound` — Resend posts parsed inbound mail here, signed via svix. Handler verifies the signature against `RESEND_WEBHOOK_SECRET` (constant-time HMAC, 5-minute replay window), correlates to a thread (`X-Bonsai-Thread-Id` → `In-Reply-To` → `References`), appends to `out/threads/{thread_id}.json` deduplicated by `message_id`, and kicks one `stepNegotiation`. Returns `401` on bad signature, `202` if no thread correlation, `200` (idempotent) on duplicate message ids.
- `GET /api/receipts` — projects completed `out/report-*.json` files into per-bill rows plus a cumulative savings total. The Home page renders a green hero counter and the three most recent receipts above the dropzone.
- `GET /api/threads/:id/state` — returns the `NegotiationState` plus the thread's outbound + inbound emails. Powers the bill-detail timeline and the proposed-resolution card. 404 if the state doesn't belong to the calling user.
- `POST /api/threads/:id/accept` — co-pilot endpoint. The user accepts the agent's currently proposed resolution; thread transitions to `resolved`. Idempotency-keyed (5-minute TTL) so the UI's confirm-double-click can't double-advance state.
- `POST /api/threads/:id/push-back` — co-pilot endpoint. The user counters the proposed resolution with free-text guidance for the agent's next turn. After `MAX_PUSH_BACK_ROUNDS` rounds the next call force-escalates to `escalated_human` instead of looping again. Idempotency-keyed identically.
- `GET /api/notifications/inbox` — returns the calling user's notification inbox (durable JSONL written by `src/lib/notify-user.ts`), newest-first. Same records that drive the Resend "your input is needed" emails.

## Tests

```bash
bun run test
```

No API keys required. Tests exercise the analyzer's grounding, the appeal letter's placeholder logic, the channel routing heuristic, the email negotiation tool dispatch, and the inbound webhook's svix verify + correlation paths.

## Layout

```
src/
  analyzer.ts            # PDF → errors + metadata via tool-use loop
  appeal-letter.ts       # deterministic markdown generator
  negotiate-email.ts     # email negotiation loop (mutex + MAX_TURNS escalation + BCC)
  negotiate-agent.ts     # negotiation orchestration helpers
  offer-agent.ts         # comparison agent (managed-agent-backed)
  opps-filter.ts         # opportunity probability gate
  simulate-reply.ts      # role-playing rep for email simulator
  replay.ts              # scripted-inbound demo fallback when webhook unreachable
  orchestrator.ts        # runBonsai() — single end-to-end entry
  server.ts              # Bun.serve HTTP + upload + fixture API + receipts + webhook router
  env.ts                 # explicit .env loader + validateRequiredEnv()
  types.ts               # BillingError / BillMetadata / AnalyzerResult
  clients/               # email + email-resend + email-mock
  server/                # webhooks (resend inbound + voice dial/webhooks)
  tools/                 # record-metadata, record-error (grounding contract), finalize
  voice/                 # agent-config, client, simulator, tool-handlers
  lib/                   # ground-truth, thread-store, provider-contact, pdf-extract,
                         # auth, db, backup, rate-limit, user-settings, notify-user, etc.
scripts/                 # day1-poc, day2..5, run-bonsai, voice-smoke, resend-inbound-smoke
fixtures/                # synthetic bill + EOB markdown + generated PDFs
public/                  # static web UI (index, landing, terms, privacy)
test/                    # bun test
```

## Roadmap

What's next:

- More analyzer rule packs per bill category (rent, taxes, subscriptions).
- IVR navigation improvements for the voice agent.
- Multi-tenant state (current `out/` artifacts are file-based; fine for self-host, not for shared deploys).

Explicitly out of scope without a design doc:

- Changes to the grounding contract.
- Model swaps below Opus 4.7 (negotiation + appeal loops are tuned for that capability tier and silently degrade on smaller models).
- Architectural rewrites of the five-agent orchestration.

## License

[MIT](LICENSE) © 2026 Bonsai contributors.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Code of conduct: [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).

## Disclaimer

Bonsai is grounded in the source documents. Every disputed finding quotes a verbatim line from the bill, contract, or statement. Dollar totals are overlap-aware. Still: this is a prototype. Not medical, legal, or financial advice. All shipped fixtures are synthetic.
