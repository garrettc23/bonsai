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
  │  Analyzer   │  Claude Opus 4.7, tool-use loop, grounding contract
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

## Deploy to Railway

Bonsai ships with a `Dockerfile` and `railway.json` that get you to a live
HTTPS URL in a few minutes. From a fresh `git clone` to first real audit
should take under 30 minutes.

### 1. Railway init

```bash
brew install railway          # or: npm i -g @railway/cli
railway login
railway init                  # follow prompts; creates a new project
railway up                    # uploads + builds via the Dockerfile
```

**What good looks like:** `railway up` exits 0. `railway status` shows
the service flipping Building → Active. `railway domain` (or the
dashboard) returns a `*.up.railway.app` URL. The URL will 502 until
step 2's env vars are set — that's expected.

### 2. Set 4 required env vars

Via `railway variables --set 'KEY=value'` or the dashboard (Settings →
Variables):

| Var | Value | Why |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Operator-paid; every audit on Opus 4.7 runs ~$0.25-1.00 |
| `NODE_ENV` | `production` | Flips cookie `Secure` flag; makes webhook fail-closed if signing secret missing |
| `BONSAI_DATA_DIR` | `/app/data` | Matches the volume mount path in step 4 |
| `RESEND_FROM` | `appeals@your-domain.com` | Must be a verified domain in Resend |

**What good looks like:** `railway variables` lists all four. After the
next `railway up`, `https://<your-domain>/healthz` returns `200 ok`.

### 3. Set 4 optional env vars

Add only what the operator needs. Any subset is fine for the first
audit; the app degrades gracefully when these are missing.

| Var | When to set it | Without it |
|---|---|---|
| `RESEND_API_KEY` | Any real outbound email | Email negotiation runs in mock mode (writes to `out/`, never sends) |
| `RESEND_WEBHOOK_SECRET` | Inbound replies from providers | In `NODE_ENV=production` the inbound webhook returns 500 by design (fail-closed) |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` + `ELEVENLABS_WEBHOOK_BASE` + `ELEVENLABS_TWILIO_PHONE_NUMBER_ID` | Real outbound voice calls | Voice runs in simulator mode (dual-Claude, transcript labeled accordingly in `out/users/<id>/calls/`) |
| `SENTRY_DSN` | Post-beta — not yet wired into the codebase | No-op today; reserved for future error tracking |

For a full email round-trip, both `RESEND_API_KEY` and
`RESEND_WEBHOOK_SECRET` must be set, and the inbound webhook must be
configured in the Resend dashboard pointing at
`https://<your-domain>/webhooks/resend-inbound`.

**What good looks like:** the variables you chose are listed by
`railway variables`. The app boots without warnings about missing
required-for-mode vars.

### 4. Mount the `/app/data` volume

Dashboard → Settings → Volumes → **New Volume**:
- Mount path: `/app/data`
- Size: 1 GB (raise later if you grow)

Then redeploy so the volume + env vars are picked up together:

```bash
railway up
```

**What good looks like:** signing up + uploading a bill, then running
`railway up` again, preserves the user and the bill. SQLite at
`/app/data/bonsai.db` and per-user directories at
`/app/data/users/<id>/` (uploads, threads, calls, reports) survive
across deploys.

### 5. Verify Resend inbound

Walk through the four-step **Resend post-deploy verification** runbook
below before relying on the email loop. It signs a real svix payload,
hits the deploy's read-only echo route, and confirms the inbound
webhook routes a real reply end-to-end.

**What good looks like:** all four steps in that section pass.

### 6. Verify outbound voice — `bun run voice-smoke`

Gated on the ElevenLabs vars from step 3. Dials the operator's own cell
as a 30-second smoke test, verifies tool callbacks fire, and writes a
transcript.

```bash
VOICE_SMOKE_TO=+15555550123 bun run voice-smoke
```

**What good looks like:** the phone rings, the agent reads the opening
line, hangup writes a transcript to `out/users/<id>/calls/`. (This
script ships with PR-2 — real ElevenLabs + Twilio wiring. Until then,
voice runs in simulator mode for every audit and step 6 is a no-op:
the simulator writes a labeled transcript without dialing.)

### 7. Submit a real bill via the web UI

Open the Railway domain in a browser, sign up, drop a real (non-fixture)
bill PDF + EOB PDF, click **Audit**.

**What good looks like:** the audit completes in 30-90s. Findings list
verbatim `line_quote` rows from the uploaded bill. The defensible total
renders in the dashboard hero. The bill drawer shows the
agent-reasoning timeline. Image-only / scanned PDFs return a
`SCANNED_PDF` error with a "paste rows or upload a text PDF" prompt —
no silent OCR.

---

**Health check.** Railway hits `/healthz` automatically (wired in
`railway.json`). Once it passes, the public URL is live.

### Resend post-deploy verification

After deploying to Railway and pointing Resend's inbound webhook at
your domain, run this 4-step check before relying on the email loop.

1. Set `BONSAI_WEBHOOK_DEBUG_TOKEN` on Railway to any random secret.
   This unlocks the read-only echo route used in step 2
   (`POST /webhooks/resend-inbound/echo`). With the env var unset,
   the route is a hard 404 — no debug surface in production by default.

2. From your laptop, smoke-test the deployed signature verifier
   (read-only, no thread state mutation):

   ```bash
   bash scripts/resend-inbound-smoke.sh \
     --url https://<your-domain> \
     --secret "$RESEND_WEBHOOK_SECRET" \
     --debug-token "$BONSAI_WEBHOOK_DEBUG_TOKEN" \
     --echo
   # expect: signature_valid:true, exit 0
   ```

   If `signature_valid:false`, your `RESEND_WEBHOOK_SECRET` on Railway
   doesn't match the one configured in Resend's dashboard, or your
   laptop's clock is more than 5 minutes off (svix replay window).

3. Trigger a real email negotiation from the dashboard (any bill with a
   finding). Confirm the outbound email shows up in the patient's
   profile-email inbox (BCC'd) and lands in the rep's inbox.

4. Reply to that email from any inbox addressed to
   `appeals@<your-domain>`. Within 5 seconds:
   - the bill drawer's email transcript shows the new reply,
   - the patient's inbox shows the same thread (Bonsai forwards inbound
     replies to the user's profile email), and
   - the Railway logs show `[webhook]` entries for the inbound + a
     follow-up `stepNegotiation`.

If step 4 fails but step 2 passed, the inbound webhook URL is wrong in
Resend's dashboard or the inbound mailbox isn't routing to it.

**Cost shape.** Railway Hobby is $5/month and includes the volume.
Anthropic API usage is operator-paid (every audit on Opus 4.7 runs
~$0.25-1.00 in tokens). Each user supplies their own Resend +
ElevenLabs keys via Settings → Integrations, so those costs don't
land on the operator.

## What works

| Layer | Command | Status |
|---|---|---|
| Analyzer | `bun run day2 bill-001 eob-001` | Grounded, 2-tier confidence, overlap-aware totals |
| Appeal letter | `bun run day3 bill-001 eob-001` | Deterministic, placeholder-aware, NSA + FCRA |
| Email negotiation | `bun run day4 bill-001 stall_then_concede` | Full loop, Resend-or-Mock outbound, **live Resend inbound webhook** + replay fallback, BCC the patient, 4 rep personas |
| Voice negotiation | `bun run day5 bill-001 stall_then_concede` | ElevenLabs config ready, simulator validates tools |
| Full pipeline CLI | `bun run bonsai bill-001 eob-001 auto` | Analyzer → letter → strategy → negotiate → report |
| Web UI | `bun run serve` | Upload or fixture, tabs: findings / letter / conversation / raw, receipts hero on Home, agent-reasoning timeline in the bill drawer |

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

## Voice setup (real ElevenLabs)

When all four `ELEVENLABS_*` env vars below are set, the orchestrator
routes the voice channel to a real ElevenLabs Conversational AI call
(via the linked Twilio trunk) instead of the dual-Claude simulator. With
any one missing, the simulator path stays in effect — the simulator
exists precisely so day-to-day dev never depends on Twilio minutes.

```
ELEVENLABS_API_KEY=...                  # xi-api-key (Settings → API Keys)
ELEVENLABS_TWILIO_PHONE_NUMBER_ID=...   # see one-time setup below
ELEVENLABS_WEBHOOK_BASE=https://bonsai.example.com   # public root; agent posts back to <base>/webhooks/voice/<tool>
ELEVENLABS_WEBHOOK_SECRET=...           # Bearer secret embedded in the agent's webhook headers
```

Optional cost-control knobs:

```
BONSAI_VOICE_DAILY_LIMIT=5              # per-user daily call cap (default 5)
BONSAI_VOICE_DAILY_BUDGET_USD=50        # operator-wide daily ceiling (default $50)
VOICE_DRY_RUN=true                      # log the call we WOULD place, return a synthetic conversation_id
```

One-time provisioning:

1. **Provision a Twilio number.** Twilio console → Phone Numbers → Buy a Number.
2. **Import it into ElevenLabs.** Dashboard → Phone Numbers → Import number → From Twilio. Paste your Twilio account SID + auth token + the number. Bonsai never holds Twilio credentials; ElevenLabs proxies all carrier traffic.
3. **Look up the `phone_number_id`.** ElevenLabs maintains its own ID for the imported number. Get it with:
   ```
   curl -H "xi-api-key: $ELEVENLABS_API_KEY" https://api.elevenlabs.io/v1/convai/twilio/phone-numbers
   ```
   Set the matching entry's `id` as `ELEVENLABS_TWILIO_PHONE_NUMBER_ID` in Railway.
4. **Smoke-test end-to-end.** `bun run scripts/voice-smoke.ts` against a number you own:
   ```
   BONSAI_VOICE_SMOKE_TO=+15551234567 \
   BONSAI_VOICE_SMOKE_USER_EMAIL=you@example.com \
   bun run scripts/voice-smoke.ts
   ```
   The script dials, then polls the per-user transcript file under
   `out/users/<id>/calls/<conversation_id>.json` until the agent's
   `end_call` server-tool fires, and prints the final state.

A single ElevenLabs imported number serves all per-user agents — agent
binding happens at call time via `agent_id` + `agent_phone_number_id` on
the outbound-call request, not at agent-creation time.

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
| Email inbound | **real Resend webhook + replay fallback** | `POST /webhooks/resend-inbound` verifies svix, dedupes by `message_id`, steps the agent. Set `RESEND_WEBHOOK_SECRET`. Replay mode (`src/replay.ts`) covers the demo case where the tunnel is unreachable. |
| Voice call | **full simulator** (no real dial yet) | Create ElevenLabs + Twilio accounts, wire webhook |
| OCR on uploaded PDFs | requires matching fixture .md | Add `unpdf` or vendor LLM OCR — noted in `server.ts` |

All fixtures are synthetic. No real PHI. This is a hackathon prototype and
is not medical, legal, or financial advice.

## HTTP endpoints

The web server (`bun run serve`) exposes:

- `POST /webhooks/resend-inbound` — Resend posts parsed inbound email here
  signed with svix. Handler verifies the signature against
  `RESEND_WEBHOOK_SECRET` (constant-time HMAC, 5-minute replay window),
  correlates the message to a thread (`X-Bonsai-Thread-Id` header → `In-Reply-To`
  → `References`), appends to `out/threads/{thread_id}.json` deduplicated by
  `message_id`, and kicks one `stepNegotiation` so the dashboard updates without
  polling. Returns `401` on bad signature, `202` if no thread correlation,
  `200` (idempotent) on duplicate message ids. In production, missing
  `RESEND_WEBHOOK_SECRET` returns `500` (fail-closed); in dev it accepts unsigned
  payloads with a console warning.
- `GET /api/receipts` — projects completed `out/report-*.json` files into per-bill
  rows (`provider`, `original`, `final`, `saved`, `outcome`, `source line_quote`)
  plus a cumulative savings total. The Home page renders a green hero counter and
  the three most recent receipts above the dropzone.

On boot the server also runs `seedReceipts()` (`src/seed-receipts.ts`), which
copies `fixtures/seed-receipts/*.json` into `out/report-*.json` if the
destination doesn't already exist. Idempotent; never overwrites a real run.

## Tests

```bash
bun test
```

- `test/compute-defensible-total.test.ts` — overlap math
- `test/appeal-letter.test.ts` — placeholders, NSA clause gating, verbatim quote preservation
- `test/choose-channel.test.ts` — routing heuristic
- `test/types.test.ts` — BillingError + BillMetadata schema guardrails
- `test/negotiate-email.test.ts` — tool dispatch, termination, idempotency, MAX_TURNS exhaustion, BCC threading
- `test/webhook-resend-inbound.test.ts` — svix verify (valid + tampered + replay), 401/202/200 paths, In-Reply-To correlation, message_id dedupe

## Layout

```
src/
  analyzer.ts            # PDF → errors + metadata via tool-use loop
  appeal-letter.ts       # deterministic markdown generator
  negotiate-email.ts     # Claude-driven email negotiation loop (mutex + MAX_TURNS escalation + BCC)
  simulate-reply.ts      # role-playing rep for email simulator
  replay.ts              # scripted-inbound demo fallback when Resend webhook is unreachable
  seed-receipts.ts       # cold-start: copies fixtures/seed-receipts/*.json → out/report-*.json
  orchestrator.ts        # runBonsai() — single end-to-end entry
  server.ts              # Bun.serve HTTP + upload + fixture API + receipts + webhook router
  server/
    webhooks.ts          # POST /webhooks/resend-inbound — svix verify, correlate, dedupe, step
  env.ts                 # explicit .env loader (bun sandbox quirk)
  types.ts               # BillingError / BillMetadata / AnalyzerResult
  clients/
    email.ts             # EmailClient interface (now carries optional bcc)
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
    thread-store.ts      # withThreadLock() + appendInboundIdempotent() — per-thread mutex over out/threads/{id}.json

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
  seed-receipts/                            # cold-start receipts for the dashboard
    seed-memorial-1842.json                 # balance-billing save
    seed-sierra-947.json                    # coding correction
    seed-university-3612.json               # NSA + duplicate CPT

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

## Roadmap

- ~~Live PDF text extraction (currently uploaded PDFs require a matching `fixtures/<name>.md` for ground-truth line_quote validation). Wire in `unpdf` or similar.~~ — shipped in 0.1.4.0: `src/lib/pdf-extract.ts` wraps `unpdf` and feeds the analyzer's verbatim `line_quote` validator with text pulled directly from the upload.
- Real ElevenLabs + Twilio wiring for voice (simulator is complete; swap is
  one-env-var + webhook URL config).
- ~~Real Resend inbound webhook handler for email replies in prod.~~ — shipped: svix-verified `POST /webhooks/resend-inbound` with replay-window dedupe and per-thread mutex. Post-deploy smoke runbook + `scripts/resend-inbound-smoke.sh` shipped in 0.1.5.0.
- `out/` artifacts (reports, thread state, call transcripts) are file-based
  — fine for a single-user demo, not for multi-tenant.

## Disclaimer

Bonsai is grounded in the EOB. Every disputed finding quotes a verbatim
line from the bill or EOB. Dollar totals are overlap-aware. Still: this
is a hackathon prototype. Not medical, legal, or financial advice.
