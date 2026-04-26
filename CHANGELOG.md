# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.12.0] - 2026-04-26

### Changed
- **Bills mid-negotiation no longer say "Watching" in the list view.** The lifecycle classifier in `public/assets/app.js` only considered `status === "negotiating"` and `outcome === "negotiating"` as active — but in real-email mode the kickoff worker flips `status` to `"completed"` once the outbound is sent, leaving `outcome` at `"in_progress"` while the agent waits on a reply. That fell through to the catch-all "Watching" chip and read like the bill was idle when in fact the agent was actively negotiating. Added `outcome === "in_progress"` to the `isNegotiating` predicate so those rows show "Negotiating" with the yellow chip. Audited-but-not-yet-approved bills now surface "Awaiting your approval" instead of "Watching" — the chip already existed in the attention bucket but the row never landed there. "Watching" is now reserved for the post-resolution monitor state (mock rows where the user pressed Start with "Resume on schedule").
- **Accept Terms at signup also locks in agent authorization + HIPAA consent.** New users had to find Settings → Profile and tick two more boxes before Bonsai could legitimately negotiate a medical bill on their behalf. The signup handler in `src/server.ts` now passes `authorized: true` and `hipaa_acknowledged: true` to `setProfileConfig` alongside the existing email seed (already wrapped in `withUserContext`). Both stamps land in the per-user settings file with their respective `*_at` timestamps. Both consents remain user-revocable from Settings → Profile — this only removes the friction of re-acknowledging the same scope the linked T&C document already covers.

### Fixed
- **Pasted billing-dept email no longer gets wiped by the contact-card poll.** When the provider-contact lookup returned `confidence: "none"`, `applyContactStatus` would unconditionally set `#contact-email`/`#contact-phone` to `""` for any element that wasn't `document.activeElement`. The 2.5s poll runs continuously, so a user who typed an email and then moved focus to the "Accept & lower my bill" button could have their input erased between keystroke and click — `approveAndRun` would then read the empty field, fail its front-end gate, and surface the "we need an email or phone" warning even though the user clearly entered one. The wipe is now guarded by `!emailEl.value` (and the phone equivalent), so it only runs when the field is already empty. Init still wipes on first render via `initContactCard`, which is the only path that needs to.
- **The "Reset" button on the Bills filter bar now visibly activates when filters are applied.** Previously it had a single quiet style regardless of state, so users couldn't tell at a glance whether their list was filtered or empty. Added a `is-active` class toggled by a new `syncBillsFilterResetState` helper that runs on every change handler (search, category, date, price, score) and on initial bind. The active state in `public/assets/app.css` darkens the border, fills the text, and tints the background so it reads as the obvious "click here to clear" affordance.
- **Bill drawer subheader is now just the relative time.** It used to compose the patient name, date of service, and "last activity \<time\>" with mid-dot separators (`Jane Doe · 2025-03-14 · last activity 5 min ago`) — duplicative because the patient name already lives in the drawer header above. Subheader is now the `relTime`-formatted last-activity string alone.

## [0.1.11.0] - 2026-04-25

### Changed
- **"Opportunities to lower this bill" now ships only high-confidence angles.** Every opportunity must declare a `probability` (0.0–1.0) of actually reducing the charge, and anything below 0.5 is dropped before the user ever sees it. The OPPS_TOOL schema (`src/server.ts`) now requires `opp_id` + `probability` on every item, the system prompt explicitly instructs the model to skip speculative tactics ("better three high-confidence opportunities than seven mixed ones"), and a shared `filterByProbability` helper in `src/opps-filter.ts` gates all three response paths — the live Opus call, the cached complaint-flow opportunities, and the fixture fast-path. The client (`public/assets/app.js`) re-applies the same filter as belt-and-braces. The complaint-intake `COMPLAINT_TOOL` schema picked up the same fields so its drafted opportunities flow through the same gate. The shipped `fixtures/bill-001.opportunities.json` was regenerated with explicit `opp_id` slugs and probabilities (0.55–0.92).
- **Headline savings now recalculates when the user dismisses a card.** Each opportunity card grew a `×` dismiss button; the "predicted to save" total is now derived from the visible (non-dismissed) opportunities instead of being baked once at render. Dismissals persist in `localStorage` keyed by `run_id` (`bonsai.opps.dismissed.${runId}`) so a hard refresh keeps the user's choices. A small "Show N dismissed" footer link clears the set and brings everything back, which means un-dismiss restores the dollar amount automatically — the total is always `clampSaved(sum-of-visible, maxSavingsCap(report))`. The synthetic fallback (`buildOpportunities`) tags items with stable `opp_id`s so dismissal works identically when the API fails.
- **Synthetic fallback levers are now gated on bill context.** The synth path used to unconditionally append "Hunt for T&C loopholes" and "Leverage a competitor offer" to every bill — including dental and medical, where neither makes sense. Item 4 now only appears if the analyzer surfaced policy/T&C language in any error finding OR the `bill_kind` is one of `telecom | utility | subscription | insurance | financial`. Item 5 only appears for `telecom | utility | subscription | insurance` (multi-provider markets where a switch threat is plausible). When in doubt, skip — better silence than a dead-end suggestion.
- **`OPPS_TOOL` is now exported from `src/opps-filter.ts`** so tests can import the schema without booting the live `Bun.serve()` listener in `src/server.ts`.

### Tests
- New `test/opportunities-filter.test.ts` covers schema shape (required fields, probability range), `filterByProbability` behavior across edge inputs (NaN, null, missing, boundary values), and that the shipped fixture passes the gate. Nine new tests, total suite 223/223.

## [0.1.10.1] - 2026-04-25

### Fixed
- **Signup + every authenticated `/api/*` request was 500'ing in prod after the `/app/data` volume was mounted.** The Dockerfile dropped to `USER bun` after a build-time `chown -R bun:bun /app`, but Railway's persistent volume mounts over `/app/data` at runtime with root ownership — so the bun process couldn't open the SQLite DB or write the per-user file tree. `createUser()` threw, the route handler bubbled to the 500 fallback, and the SPA showed "Sign in failed." Removed `USER bun` from the Dockerfile so the container runs as root; container isolation is the real security boundary on Railway. A follow-up can reintroduce the bun user via an entrypoint script that chowns `/app/data` at startup.

## [0.1.10.0] - 2026-04-25

### Changed
- **Audit daily limit lowered from 20 to 5.** A solo curious user can no longer drain the operator's Opus 4.7 budget with a casual afternoon of clicking. Hoisted the literal into a single `AUDIT_DAILY_LIMIT_DEFAULT = 5` constant in `src/server.ts` so the env-var default and the safety fallback move together. `BONSAI_AUDIT_DAILY_LIMIT` still overrides for staging or future paid tiers.

### Fixed
- **Landing page now says "CC'd" instead of "BCC'd".** The third feature card on `public/landing.html` claimed users were BCC'd on every email, but `src/clients/email-resend.ts:95` has been threading a `cc:` field to Resend for a while. Copy now matches reality.

### Added
- **Diagnostic logging on `/api/*` 401s.** When a request hits the catch-all auth gate without a valid session, the server now `console.warn`s a structured `[auth-fail]` line with the failure category (`no_cookie` / `session_not_found` / `user_not_found`), the request path and method, and a boolean `has_cookie`. The next "why is the API 401-ing in prod" question is answerable from logs alone. The cookie value and session token are never logged. Implemented as a sibling export `requireUserDiag` in `src/lib/auth.ts` so the route handler stays a single conditional.
- **Defensive `apiFetch` wrapper in the SPA.** `public/assets/app.js` now routes every `/api/*` call through a tiny wrapper that pins `credentials: "same-origin"`. Browsers default to that already, so this is belt-and-braces — if a future fetch override or polyfill ever shifts the default, the bonsai_session cookie still rides along. 38 call sites migrated; non-`/api` fetches are untouched.

## [0.1.9.0] - 2026-04-25

### Added
- **Rate limiting on public endpoints.** A stranger from Twitter can no longer drain the operator's Anthropic budget overnight or spam the password-reset mailer. New `src/lib/rate-limit.ts` is an in-process sliding-window counter (no Redis dep — fine for single-host beta) keyed by an arbitrary string. Three routes are gated:
  - `POST /api/auth/forgot` — 5 reset requests per email per hour. Keyed on email (not IP) so per-account harassment is the abuse model, not per-IP signup floods.
  - `POST /api/auth/signup` — 10 signups per IP per hour. IP comes from `x-forwarded-for` (Railway) with `server.requestIP(req)` as the local-dev fallback.
  - `POST /api/audit` — 20 audits per user per day, env-overridable via `BONSAI_AUDIT_DAILY_LIMIT`. Audit kicks off Opus 4.7 at ~$0.25–$1.00 per run; the env knob lets staging or paid tiers lift the cap without a rebuild. The 429 response says "Daily limit hit, upgrade to remove." so the future paywall message is already in place.
  - `POST /webhooks/resend-inbound` stays unlimited — svix-HMAC-verified, dropping a legitimate rep reply would look like Bonsai is dead.
- Every 429 ships a `Retry-After` header plus `{ error, retry_after_sec }` JSON body so the SPA can surface the wait time inline.

## [0.1.8.0] - 2026-04-25

### Fixed
- **Provider-contact lookup can no longer hang the plan-review tab.** `src/lib/provider-contact.ts` now wraps the web-search Claude call in a 30s `AbortController`. On timeout the resolver returns a no-cache `confidence: "none"` result with an explicit "lookup timed out, please paste contact" note, so a transient model hang doesn't poison future runs. Low-confidence results that come back with neither email nor phone collapse to the same `"none"` shape — the user always sees an explicit paste-to-proceed prompt instead of a vague "we found something, sort of" state. The contact card on the plan-review screen renders the new state with a tightened "We couldn't find this provider's billing email — paste it from your bill" copy and keeps the existing autosave-on-type / Approve auto-save flow intact, so a single paste plus Accept unblocks negotiation. The 30s ceiling is overridable in tests via `BONSAI_CONTACT_LOOKUP_TIMEOUT_MS`.

## [0.1.7.0] - 2026-04-25

### Added
- **Branded landing page at `/`.** A first-time visitor now arrives at a real marketing page — sticky nav with the `Bons|ai` wordmark, Instrument Serif hero ("Every bill, negotiated."), four feature cards (grounded audit, appeal letter, email negotiation, voice negotiation), four-step how-it-works, six-question FAQ, and a footer with Terms / Privacy / contact / disclaimer. The signed-in app moves to `/app` (with `/app/*` deep-link support), so existing bookmarks keep working. New `public/landing.html` (~270 lines) and `public/assets/landing.css` (~345 lines) reuse the SPA's brand tokens, fonts, and dark-pill button — single source of truth in `app.css`, no token duplication.
- **Open Graph + Twitter card metadata.** Pasting a Bonsai URL into iMessage, Slack, or Twitter now unfurls with a 1200×630 preview image (`public/og-image.png`) and a clean title + description block. OG meta added to all four public pages: landing, app shell, terms, privacy. The OG image is rendered from a committed SVG source via `scripts/build-og-image.ts` (uses the existing `sharp` dep — re-run after editing `public/og-image.svg`).

### Changed
- **`/` → `landing.html`, SPA → `/app`.** `handleStatic` (`src/server.ts`) re-routes `/` to the new landing page and serves the SPA shell (`index.html`) for `/app` and any `/app/...` deep link. `/terms` and `/privacy` continue to resolve via the existing extensionless mapping. Password-reset emails now generate `https://<host>/app?reset=<token>` so clicking the link drops the user into the SPA's reset view (was `/?reset=...`, which now harmlessly hits the landing page instead).
- **SPA navigation hooks.** After a successful password reset, `app.js` strips the token by replacing the URL with `/app` (was `/`). Logging out now redirects to `/` (the landing page) rather than reloading the empty auth screen.
- **Static-asset MIME types.** `contentType()` now recognizes `.png`, `.jpg/.jpeg`, `.webp`, and `.ico` so the OG image and any future raster assets serve with the correct `Content-Type` instead of `application/octet-stream`.

## [0.1.6.0] - 2026-04-25

### Changed
- **Operator deploy runbook.** `Deploy to Railway` rewritten as a 7-step numbered checklist with "what good looks like" notes for each step, taking a friend from `git clone` to first real audit in under 30 minutes. Required vs optional env vars are split into two tables. Step 5 points at the dedicated "Resend post-deploy verification" runbook (shipped in 0.1.5.0); step 6 (`bun run voice-smoke`) stays gated on real ElevenLabs + Twilio wiring. `Known follow-ups` renamed to `Roadmap` with the now-shipped real Resend inbound webhook and live PDF text extraction items struck through.

## [0.1.5.0] - 2026-04-25

### Added
- **Resend post-deploy verification.** Operators can now smoke-test a fresh Resend deploy without waiting for a rep's first reply. New `scripts/resend-inbound-smoke.sh` signs a real svix payload (echo or full mode), hits the deploy, and asserts the handler accepts and routes correctly. New `POST /webhooks/resend-inbound/echo?debug_token=<env>` route echoes svix signature validity + thread correlation method without mutating state — gated by `BONSAI_WEBHOOK_DEBUG_TOKEN` (route is a hard 404 when the env var is unset). README adds a 4-step post-deploy verification runbook in the Deploy section.

## [0.1.4.0] - 2026-04-25

### Added
- **Real PDF text extraction on uploaded bills.** New `src/lib/pdf-extract.ts` wraps `unpdf` (Bun-friendly, no native deps) and exposes `extractPdfText(path)`. The `POST /api/run` upload route no longer rejects PDFs that lack a matching `fixtures/<name>.md`: it pulls text directly from the uploaded PDF and feeds it through the existing `groundTruthFromText`, so the analyzer's verbatim `line_quote` validator still anchors every finding to the actual bill. Image-only / scanned PDFs raise a `ScannedPdfError` that surfaces to the client as `{ code: "SCANNED_PDF" }` with a "this looks scanned, paste rows or upload a text PDF" message — no silent OCR, the grounding contract holds. Fixture demo path is unchanged; only the previously-unreachable rejection branch flips to live extraction.

## [0.1.3.0] - 2026-04-25

### Fixed
- **Outbound emails no longer leak markdown punctuation.** Emails ship to Resend as the plain `text:` field, so `**bold**`, `## headings`, `> blockquotes`, and backticks were rendering as literal characters in Gmail and Outlook. The negotiator's `send_email` tool now asks for `body_text` (was `body_markdown`), the tool description and system prompt forbid markdown formatting with explicit do/don't examples, and the humanizer's system prompt picks up a matching rule. A new `stripMarkdown()` helper runs as a belt-and-braces last line of defense in both the Resend and Mock email clients — even if Claude drifts back into markdown habits, the wire payload is clean. Snake_case identifiers like `claim_number` and `account_number` are preserved verbatim. The appeal-letter PDF attachment intentionally stays markdown (it's an attachment, not the body).

### Changed
- **`OutboundEmail.body_markdown` → `body_text`** on the email type (`src/clients/email.ts`) and every callsite (`src/negotiate-email.ts`, `src/negotiate-agent.ts`, `src/orchestrator.ts`, `scripts/day4-negotiate-email.ts`, both email clients, the webhook test fixture). Aligns with `InboundEmail.body_text` so both sides of the wire share the same field name and contract.

## [Unreleased]

### Added
- **Terms of Service + Privacy Policy gate on signup.** New `users.accepted_terms_at` column. `POST /api/auth/signup` now requires `accepted_terms: true` in the body — server returns `400 terms_not_accepted` otherwise. Auth screen renders a terms-acceptance checkbox in the foot of the card (signup mode only, sharing the same grid cell as the "Forgot password?" link in login mode so card height never changes between tabs). Links route to two new branded static pages (`public/terms.html`, `public/privacy.html`); `handleStatic` auto-maps extensionless URLs to `.html` so `/terms` and `/privacy` resolve.
- **Outcome verification loop.** New PendingRun fields `outcome_verified` (`"yes" | "no" | "partial"`), `outcome_notes`, `outcome_verified_at`. Drawer ribbon ("Did your next bill match?") renders for every resolved bill; a "Yes, matched" button submits immediately and a "No / partial" button opens a modal with notes. `attentionReason()` adds a `verify_outcome` key for resolved bills older than 21 days that the user hasn't confirmed — they surface in the Bills attention bucket alongside the existing `awaiting / escalated / paused / error` reasons. `POST /api/bills/verify-outcome` persists the verdict; `/api/history` projects the new fields and a computed `needs_outcome_check` flag.
- **Email + password auth with per-user data isolation.** `users` and `sessions` tables in SQLite (`out/bonsai.db`) backed by Bun's argon2id hashing. HTTP-only `bonsai_session` cookie (30-day TTL), middleware that 401s every `/api/*` route without a session, and per-request `withUserContext` (AsyncLocalStorage) so `email-mock`, `negotiate-email`, `offer-agent`, `voice/*`, and `user-settings` silently route to `out/users/<id>/{pending,threads,offers,calls,uploads,user-settings.json,report-*.json}` without signature changes. Login screen replaces home for unauthenticated visitors; sidebar foot stayed clean — Log out lives in Settings → Account.
- **Forgot-password flow.** New `password_resets` table (1-hour single-use tokens). `POST /api/auth/forgot` mints + sends via Resend when configured, otherwise logs `[forgot] dev reset link for <email>: <url>` to the server console. `POST /api/auth/reset` consumes the token, sets the new hash, clears every existing session for that user, mints a fresh cookie. Front-end gets a Forgot password link on Log in (kept in layout via `visibility:hidden` so the card doesn't jump on tab toggle), a Reset-your-password view that submits the email, and a Set-a-new-password view auto-rendered when the URL carries `?reset=<token>`.
- **Provider contact resolution via web search.** New `src/lib/provider-contact.ts` calls Claude with the `web_search_20250305` server tool, returns `{ email, phone, source_urls[], confidence, notes }`, and caches in a new `provider_contacts` SQLite table keyed on `provider_name||address`. Runs as a background step right after `runAuditPhase`; result lands on `PendingRun.resolved_contact`. New endpoints `GET /api/contact/:run_id`, `POST /api/contact/override`, `POST /api/contact/retry`. Plan-review tab gets a contact card under Opportunities — confidence chip, editable email/phone, Save + Re-search buttons, source-URL chips. Negotiator pulls `provider_email`/`provider_phone` from `resolved_contact` (falls back to placeholder when null/unresolved).
- **Branded empty states for Bills + Comparison.** Pre-first-bill, both views render a card matching the home dropzone's voice — solid 1.5px border at ~32% ink, Instrument Serif headline, ink-soft body, dark pill `Upload a bill` CTA that routes to Home. Bills says "No bills uploaded yet"; Comparison says "Comparison activates after your first bill." Once `historyCache.audits.length > 0` the views swap back to their full chrome (stats + filters + table on Bills, banner + filter chips + grid on Comparison) — original DOM is stashed inside the empty-hero element and re-mounted via `restoreViewChildren()`.
- **Password show/hide toggle** on Log in / Sign up / Set-new-password forms. Eye icon inside the input flips `type` between `password` and `text`, swaps to a slashed-eye glyph, updates `aria-pressed` / `aria-label`, and keeps focus in the field.
- **Auth + path-isolation tests** (`test/auth.test.ts`, 25 cases): hashing, session lifecycle, expired-token eviction, cookie-driven `requireUser`, password-reset token round-trip + single-use + clears-all-sessions invariant, traversal-safe `userPaths()`. DB lives at `tmpdir()/bonsai-test-<pid>` so a parallel `bun run serve` keeps using `out/bonsai.db`.

### Changed
- **Brand-aligned auth screen.** Same `bonsai-logo.svg` + `Bons|ai` wordmark with the `ai` accent that the sidebar uses. Tagline: "Every bill, negotiated." Card height stays constant across Log in / Sign up tabs.
- **Comparison savings banner is gated on real recommendations.** The "Annual savings if you switch to all recommended" bar (with the `$0` and Accept-all button) used to render unconditionally; it now hides via `[hidden]` when `recommended.length === 0 || total <= 0`, and the `.offers-banner[hidden] { display: none }` rule is added because `display: flex` on the parent was overriding the default hidden behavior.
- **Settings consolidation.** Account + Data merged into one card titled "Account" with three rows: Signed in as / Log out, Export all data, Delete account. Removes one heading + one card from the page.
- **Empty-account fresh signup.** Mock recurring bills + mock offers (`MOCK_RECURRING_BILLS`, `MOCK_OFFERS`) collapsed to `[]` so a freshly signed-in account shows no phantom badges, no test data; existing filter calls keep working because filtering an empty array is a no-op.
- **Stale SQLite handle recovery.** `getDb()` honors `BONSAI_DB_PATH` (used by tests), reopens automatically when the configured path changes or the file got unlinked from underneath — fixes the `SQLITE_IOERR_VNODE` 500s that hit when `out/` was wiped beneath a running server.

### Removed
- **SMS code paths**, end to end. The 0.1.1.0 release dropped the SMS toggle from Settings and routed the persistent pipeline email→call, but the underlying modules were still on disk. This release deletes them: `src/clients/sms.ts`, `src/clients/sms-twilio.ts`, `src/clients/sms-mock.ts`, `src/negotiate-sms.ts`, `src/simulate-sms-reply.ts` (~780 LOC), plus every SMS branch in `orchestrator.ts`, `negotiate-agent.ts`, `server.ts`, `user-settings.ts`, `feedback-parser.ts`, the SMS-thread renderer in `app.js`, the `.conv-msg.sms` styling block in `app.css`, the `TWILIO_*` block in `.env.example`, and the matching test cases. `Channel`, `AttemptChannel`, `channels_enabled`, and `FeedbackDirectives.channels` collapse to email + voice. The "stop texting"/"sms only" parser keywords are gone — drivers now only know email and voice.
- **All four mock attention rows** (`mock-attn-awaiting` / `escalated` / `paused` / `error`) plus the rest of `MOCK_RECURRING_BILLS` and the mock `MOCK_OFFERS`. Real audits drive both Bills and Comparison from this release forward.

## [0.1.2.0] - 2026-04-24

### Added
- **Live email negotiation, end-to-end.** Resend inbound webhook (`POST /webhooks/resend-inbound`) verifies svix HMAC signatures with a 5-minute replay window, deduplicates by `message_id`, and serializes per-thread writes through an in-process mutex so the agent's outbound and the rep's inbound never clobber each other. Thread correlation tries `X-Bonsai-Thread-Id` first, then falls back to `In-Reply-To` / `References` chained against outbound message ids — works whether the recipient's mail client echoes custom headers or not. Once an inbound is persisted, the handler kicks `stepNegotiation` so the dashboard updates without polling.
- **Receipts dashboard on the Home page.** `GET /api/receipts` reads completed `out/report-*.json` files and projects per-bill rows (`provider`, `original`, `final`, `saved`, `outcome`, `source line_quote`) plus a cumulative `$-saved`. The overview view now opens with a green hero counter and the three most recent receipts above the dropzone, so the demo never lands on an empty screen.
- **Cold-start seed receipts.** Three pre-shipped JSONs under `fixtures/seed-receipts/` (Memorial Hospital balance billing, University Medical Center NSA + duplicate CPT, Sierra Imaging coding correction) auto-copy into `out/report-*.json` on server boot if missing — totalling $6,401 saved across 3 bills out of the box. Idempotent; never overwrites a real run.
- **Agent-reasoning timeline in the bill drawer.** A new "Agent reasoning" section above the email transcript renders the negotiation as a sequential step list — `Drafted initial appeal → Reply received (classified as stall) → Cited NSA in follow-up → Resolved`. Each step has a colored dot for kind (good/warn/danger/resolved/escalated), a label, and a one-line rationale. Classification uses keyword heuristics on the inbound body; tactic detection runs on the outbound to surface the angle the agent took (NSA citation, deadline pressure, supervisor request, FCRA framing).
- **BCC the account holder on every outbound.** When `profile.email` is set, the agent BCCs that address on the initial appeal and every follow-up so the patient sees the thread in their own inbox even though Resend sends from a Bonsai-controlled domain. Threaded through `OutboundEmail.bcc` → `NegotiationState.bcc` → `ResendEmailClient.send`. The plan-review screen surfaces this with a green-dot hint that reads either "You'll be BCC'd at <email>…" or "Add your email in Settings → Profile to get BCC'd."
- **Replay mode for demo fallback.** New `src/replay.ts` exposes `replayThreadInbound(thread_id, replies, opts)` — schedules scripted inbound messages on a timer, deduplicates by `message_id`, and steps the agent under the per-thread mutex. Designed as the safety net when Resend inbound webhooks are unreachable on stage.
- **Per-thread mutex helper.** New `src/lib/thread-store.ts` exports `withThreadLock(thread_id, fn)` and `appendInboundIdempotent(thread_id, inbound)`. Used by the webhook handler and replay path to serialize JSON-file read-modify-write on `out/threads/{id}.json`.
- **22 new tests across 2 files** (`test/negotiate-email.test.ts`, `test/webhook-resend-inbound.test.ts`). Covers: tool dispatch (send_email / mark_resolved / escalate_human), termination, idempotency, MAX_TURNS exhaustion, system-prompt composition, BCC threading, svix signature verification (valid + tampered + replay window), webhook 401/202/200 paths, In-Reply-To correlation fallback, message_id idempotency. Suite total: 139 pass / 0 fail (was 117).

### Changed
- **MAX_TURNS exhaustion no longer silently freezes a thread.** If the negotiator burns through all four turns of `MAX_TURNS_PER_STEP` without producing a terminal tool call, `stepNegotiation` now auto-escalates with `reason: "unclear"` and a note explaining the agent didn't terminate — instead of advancing `last_seen_inbound_ts` and going mute on the thread.
- **Multi-channel handoff context now actually wired.** `formatPriorAttempts` was previously dead code with a 17-line comment apologising for it; this release threads its output through `prior_attempts_summary` on `negotiate-email.StartOpts`, `negotiate-sms.StartSmsOpts`, and `RunNegotiationAgentOpts`, then injects it into `renderAnalyzerContext` on every step so the SMS agent doesn't repeat the email's failed arguments verbatim. The dead-code comment block is removed.
- **`stepNegotiation` accepts a `threadsDir` override** so tests can point at a `tmpdir` instead of contending with the production `out/threads/` directory.

## [0.1.1.0] - 2026-04-24

### Added
- **Bills attention reasons.** Every Bills row carries a status chip — `Negotiating`, `Resolved`, `Watching`, or one of four attention states: `Awaiting your approval`, `Provider countered — review`, `Paused by you`, `Agent error`. The chip color matches the urgency: red for counters and errors, amber for items waiting on you, gray for self-paused. Sidebar **Bills** badge counts attention rows in real time; resolving an item drops the count immediately.
- **Needs attention drawer tab.** Click into any attention bill and the drawer lands on a new tab that explains *why* the row needs you and *what to do next*. State-specific content includes a numbered step list, an inline chat surface to course-correct the agent, and a primary CTA. For *Provider countered* the tab shows a side-by-side counter snapshot (`Original $3,420 → Counter $1,900 → Saves $1,520 (44%)`) plus the rep's notes; the user picks **Approve counter** or **Keep negotiating**. For *Awaiting your approval* the drawer widens to 960px so the audit findings, plan, and chat have room.
- **Compare modal.** The Compare button on every offer card now opens a 1080px side-by-side modal: Current provider + price (struck through) on the left, Recommended provider + price (green) on the right, savings line that calls out per-period and annualized totals, plus *Why it fits* / *Switch friction* / *Timing* / *Confidence* sections. Mobile collapses to a single column.
- **Connect-accounts modal in Settings.** Each integration (Anthropic, Resend, ElevenLabs) renders one tidy row: status pill + **Connect** button, or **Edit** + **Disconnect** when configured. Clicking opens a modal with credential fields (secrets masked, last-4 visible when set). Saved credentials persist to `out/user-settings.json` and propagate to `process.env` on save and on server startup, so the next Anthropic/Resend/ElevenLabs client created inside any request handler picks them up without a restart. The Anthropic pill flips from `NOT CONNECTED` (red) to `CONNECTED` (green) the moment a real key is saved.
- **Recommended filter chip** in Comparison, leftmost and selected by default. Selecting it shows recommended offers across categories.
- **House Insurance** as a first-class category. New `house_insurance` `OfferCategory` with three live sources (Lemonade, Hippo, an independent broker), a Lemonade Homeowners offer in the Comparison grid, and `inferCategory()` regex that routes home-only carriers (`lemonade|hippo|kin|homeowners?|home insurance|dwelling|property insurance`) before falling through to auto.
- **Stop / Start choice modal.** Pressing Start no longer auto-resumes — it asks: **Start now** kicks the next round off immediately; **Resume on schedule** un-pauses but waits for the next scheduled tick.
- **Synthetic Activity timelines** for attention rows so the Activity tab tells a coherent story even before the first real audit (Bill received → Plan built → state-specific tail).
- **Trash button next to the bill name** in the drawer header — red by default, fills on hover. Mock recurring bills hide via localStorage; real audits hit `/api/delete` after the existing confirm modal.
- **Inline unsaved-changes guard** on Profile and Settings. Editing a field and clicking another nav opens an in-app `Discard unsaved changes?` modal (no more browser-native `confirm()`).
- **Four mock attention test rows** (`mock-attn-awaiting` / `escalated` / `paused` / `error`) so every attention state is reachable for testing without running a real audit.
- 16 new unit tests for `IntegrationsConfig` getters/setter and `applyIntegrationsToEnv` (`test/user-settings.test.ts`). Suite total: 75 pass / 0 fail.

### Changed
- **Channels reduced to Email + Call.** SMS toggle removed from the Settings tone card; persistent-negotiation pipeline now goes email → call. ElevenLabs integration label updated to `ElevenLabs (call)`.
- **Comparison page header trimmed.** Removed the `Opportunities / Recommended / Annualized` stats block, the `Agent hunting alternatives…` live indicator, and the banner subtitle. The annual-savings banner stands alone with eyebrow `Annual savings if you switch to all recommended`.
- **Comparison grid is flat again.** Recommended/Other section headers removed.
- **Strikethrough on offer prices** stops at the last digit. The dollar amount lives in `<span class="offer-amt-strike">`; the unit (`/mo`) sits in a sibling span with no decoration.
- **Comparison filter chip order:** `Recommended · All · <categories>`. Recommended is the default active chip.
- **Status pill simplification.** All non-connected integrations render a single `NOT CONNECTED` chip with the same red treatment — no more `MISSING` vs `SIMULATED` split.
- **Resend and ElevenLabs are required.** Status reads `NOT CONNECTED` until linked, matching Anthropic.
- **Bills row subheader** is just the last activity (`8 minutes ago`). Patient name + date prefix removed.
- **Removed the price-score column** from the Bills table — was conflating score with negotiation status.
- **Stop on a mock bill flips the chip immediately.** `rowStatusChip()` now consults `getMockPaused()` so the Bills page reflects drawer state without a refresh.
- **Home tagline:** `Drop any bill. We get you the lowest price possible.` ("while you sleep" trimmed).
- **File input** is now just a styled `Choose files` button — native border + filename text are visually hidden.
- **BBB removed** from the aggressive-tone help text and from the contractor/legal opportunities prompt rule. New copy reads `regulatory complaints, retention threats` and `state licensing-board or bar complaint leverage`.
- **Anthropic API key validation** is placeholder-aware. Keys ending in `...` (e.g. the `sk-ant-...` onboarding placeholder) report as `NOT CONNECTED` instead of `CONNECTED`.
- **Floor pricing concept removed** from the user-facing surface. The agent always pushes for the lowest price; counters always require human approval. `FLOOR HIT` outcome tag becomes `LOWEST PRICE`; persistent-run meta line drops the `Floor: $X` field.

### Fixed
- **Drawer wouldn't open** after the Awaiting-wide change due to a duplicate `const drawer` declaration in `openBillDrawer`. Reusing the function-scoped const fixes it.
- **Stop/Start drawer state was out of sync with Bills page** for some mock flows. The Stop handler now also clears `row.lifecycle` and `row.attentionReason` and calls `renderBills()` + `updateNavCounts()` so the chip and badge update in lockstep.
- Compare modal was clamped to ~420px because the generic `.confirm-modal` rule outranked `.cmp-modal` (defined earlier in the file). Doubled the selector to `.confirm-modal.cmp-modal` so 1080px applies. Same fix for `.intg-modal`.

### Removed
- **Twilio (SMS) integration** end-to-end. Dropped from the Settings integrations list; channels reduced to Email + Call.
- **Messages drawer tab** — the conversation surface lives inside Activity; chat lives inside the Needs-attention tab.
- **`floor_pct` and floor-related copy** from the Tune surface and approval cards.

## [0.1.0.0] - 2026-04-24

### Added
- **Profile tab** in the sidebar with First/Last name, Email, Mobile, Address, Date of birth, SSN (last 4), and Driver's license. Includes a single blanket authorization checkbox; ticking it reveals an inline HIPAA Authorization (45 CFR § 164.508) panel with its own acknowledgment checkbox. Both consents are timestamped — and the timestamps only advance on a transition into authorized, so the displayed "Signed: <date>" reflects when consent was actually given, not the last save click.
- **Tune your agent** controls in Settings: tone (polite / firm / aggressive), per-channel toggles for email / SMS / voice, and the existing weekly digest + real-time alert switches.
- **Feedback drives the next round.** When you give feedback like "stop being aggressive, only email, no calls" while the agent is paused, the resume now parses it deterministically: channel toggles get gated, tone gets overridden, and free-form notes get prepended to the email and SMS negotiator system prompts. The agent honors what you said instead of marching through email → SMS → voice on autopilot.
- **Export all data** as a single JSON file (profile, tune, every pending bill, every report, every appeal letter).
- **Delete account** with a confirmation modal that requires you to type `DELETE`. Server requires the same string in the request body, so a tab from another origin can't drive-by wipe your data. Wipes pending runs, reports, appeals, every transcript directory (`out/threads`, `out/sms-threads`, `out/offers`), uploads, and `user-settings.json`.
- 26 unit tests covering `feedback-parser.ts` exclusivity, negation, tone classification, and tone-guidance content.

### Changed
- Settings page now ends with a single Save button at the very bottom, separated by a top border. The "Saved ✓" status fades out after 3 seconds instead of lingering.
- Page-header titles across the app no longer end with a period.
- Profile and Tune copy is generic across all bill types (medical, utility, subscription, financial, etc.) rather than medical-specific.
- Mobile field on Profile is documented as "only used for real-time alerts."

### Removed
- **Telegram integration**, end to end. Deleted `src/telegram/{bot,client,notify,route-message}.ts` (over 700 lines), removed every call site in `src/server.ts`, dropped the settings card and integrations row, and stripped `TELEGRAM_*` from `.env.example`.
- Target discount slider from the Tune card.
