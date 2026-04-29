# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.33.0] - 2026-04-29

### Added
- **Sign in with Google.** Continue with Google button on the SPA's auth screen runs an OAuth 2.0 authorization-code flow against Google's OpenID Connect endpoints — three branches in the callback: log in if we've seen the Google `sub` before, auto-link to an existing password account if the email matches (Google verifies emails so the takeover risk is bounded), otherwise create a fresh account with email already verified and terms auto-accepted via the consent screen. New `users.google_sub` column with a partial unique index. Server-only client_secret, HttpOnly+SameSite=Lax state cookie for CSRF, rejects unverified Google emails. Env vars `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` are optional — server boots without them and the SPA hides the button via `/api/public-config`'s new `google_oauth_enabled` flag.
- **Tab-aware landing CTAs.** "Sign up" / "Get started" buttons on the landing page now pass `?auth=signup` so the SPA opens directly on the sign-up tab instead of always defaulting to log-in. The query param is stripped after the tab switches so a refresh doesn't re-force it.

### Changed
- **"Log in" → "Sign in"** in the SPA auth tabs and submit button to align with the verb on the Continue with Google button (and the landing nav).
- **Profile and Settings tabs merged into one Settings tab.** Order on the page: Personal details → Agent personalization (was "Negotiation style") → Account → Authorization (moved to the bottom because the legal copy is heavy). One unified Save button at the bottom POSTs profile + tune in parallel; the per-card "Save profile" is gone. Account section reordered with Delete at the top and Log out at the bottom. Per-card baselines so saving one section doesn't silently drop the other's pending edits.
- **Tighter Settings copy.** Email → "Inbound replies from companies route here." Address → "Used on appeal letters and dispute correspondence." DOB → "Some accounts require this to verify your identity." SSN → "Some accounts require this to pull your record. It's securely stored."

### Fixed
- **"Bonsai is thinking" indicator now actually visible.** The chat bubbles have always rendered `<span class="dots"><span></span><span></span><span></span></span>` while waiting for a reply, but the CSS only animated opacity on three empty spans — nothing to draw, so the indicator was invisible. Empty spans now get a 6×6 circle background scoped via `:has(span:empty)` so the timeline / extract-screen variant (which uses literal `.` characters) still renders unchanged.
- **Cancelling a bill upload no longer shows "Something went wrong."** When the user removed a staged file mid-audit, `runPhasedFromPrefetch` was treating the resulting null promise like a thrown error and routing it to the error view with body "Audit cancelled". Now null (cancellation) returns silently to the upload screen; only `__error` (a real failure) surfaces the error block.

## [0.1.32.2] - 2026-04-29

### Changed
- **Landing page polish.** Top-right CTA renamed from "Get started" to "Sign up" so the nav has both auth verbs (Sign in / Sign up) instead of one auth verb and one product verb. Hero badge "Now in preview" → "Now in beta", and the meta line + FAQ answer follow suit. The `$1,313.24 saved across 12 bills audited so far` line is gone — small-N social proof was undercutting more than it was selling.
- **Smooth-scroll on nav anchors.** Clicking Features / How it works / FAQ now animates to the section instead of jumping. Added `scroll-margin-top: 72px` so the section heading clears the sticky nav after the scroll completes.

### Fixed
- **Marquee no longer shows an empty gap on wide screens.** The category track (Insurance · Utilities · Medical · …) had two copies of the list animating to `translateX(-50%)` for the loop. On viewports wider than one copy (~1450px — basically every laptop), the right edge of the screen ran out of content at the loop point and snapped. Now four copies animating to `-25%`: copies 2-4 always trail right of the viewport, so the loop is seamless on any screen size. Same scroll speed as before.

### Added
- **`SECURITY.md`** — security policy for the OSS launch. Supported versions (latest only, beta), private reporting via `gcahill@firebaystudios.com`, in-scope (auth bypass, RCE, cross-user data exposure, secret extraction) vs. out-of-scope (rate-limit bypass, social engineering, brute force without lockout), and a standard 90-day coordinated disclosure timeline.
- **GitHub Actions CI workflow** at `.github/workflows/ci.yml`. Runs on every PR to `main` and every push to `main`: `bun install --frozen-lockfile` → `bun run typecheck` → `bun run test`. `oven-sh/setup-bun@v2` handles Bun deps caching automatically. Any non-zero exit fails the workflow — no warn-only steps.

### Changed
- **Scrubbed personal email from v0.1.21.1 changelog entry.** Replaced `edward@firebaystudios.com` with the RFC 2606 `user@example.com` example domain. The original was a contact-card paste used to illustrate the bug repro and didn't need to ship to a public repo.
- **CONTRIBUTING.md gained a "Post-clone polish" section** documenting the social-preview image upload (`public/og-image.png` → GitHub Settings → Social preview), since GitHub doesn't expose that setting via CLI.
- **Repo metadata via `gh repo edit`:** homepage set to `https://bonsai.firebaystudios.com`, dropped the `healthcare` topic, added `bill-negotiation`, `personal-finance`, and `cost-optimization` topics — Bonsai is general-purpose personal-bill cost optimization, not medical-only.

## [0.1.32.0] - 2026-04-26

### Added
- **Click-to-edit bill name in the drawer.** The drawer header title is now contenteditable. Click → cursor appears in place; click away (or hit Enter) autosaves; Escape reverts. Backed by a new idempotent `/api/bill-rename` endpoint that sets/clears `PendingRun.display_name`. Empty rename clears the override; the original analyzer-detected provider name comes back. The Bills row + drawer title both prefer `display_name` when present; the audit's evidence chain stays untouched on the report.
- **Currency formatter on the Switch modal's amount input.** Switched the field from `<input type=number>` to text + a small `formatCurrencyInput` helper that strips invalid characters, caps the decimal at 2 digits, inserts thousands separators, and prefixes "$". Default value renders as `$59.99` instead of raw `59.99`. Blur normalizes `$59` → `$59.00`. Submit reuses the same parser so `$1,234.56` round-trips to 1234.56.

### Fixed
- **Drawer "Current" price now reflects a completed Comparison switch.** The previous v0.1.31.0 fix updated the Bills list row vendor + balance from `completed_switches[-1]`, but the drawer's stat grid didn't recompute. Two layered fixes: (1) `findUpdatedRowAfterRefresh` recomputes vendor + balance off the fresh audit so reopening the drawer after a switch shows the new provider + amount; (2) `renderDrawerStats` directly reads the latest switch entry for the "Current" stat, falling back to `summary.final_balance` only when no switch is recorded. Original stays pinned to the audit's pre-switch balance.

## [0.1.31.0] - 2026-04-26

### Fixed
- **Comparison didn't refresh after deleting bills.** The optimistic-delete path updated the local bills cache + re-rendered the Bills list, but never touched `offersCache`. If the user was on the Comparison tab when they deleted the last bill, the offers stayed visible until the next page nav. Now the post-delete handler also calls `loadOffers()` and re-renders the Comparison view if it's currently active. v0.1.27.0's strict-filter does the heavy lifting on the server side; this is just the SPA wire-up that was missing.

### Changed
- **Switch modal now picks which bill the switch is for.** The previous flow read `drawerState.row.audit.run_id`, which only worked if the user had a bill drawer open. Clicking Switch from the top-level Comparison nav (the most common entry) hit a "Couldn't find the bill this offer belongs to" error. New flow:
  - Bill dropdown populated from `historyCache.audits`, defaulting to the open drawer row → analyzer-provider match → first bill.
  - Editable monthly-amount input pre-filled with the offer's recommended price (the user can override if their actual signup price differs).
  - Single primary "Switch completed" button. On submit, posts the chosen `run_id` + new amount + provider to `/api/switch-complete`.
- **Bills list reflects the latest completed switch.** After a switch is recorded, the row's vendor + balance read from `completed_switches[-1].new_provider` / `.new_amount` so the Negotiation tab shows what the user is actually paying now, not the stale pre-switch values. Audit-time data is still preserved on the report — display layer only.

## [0.1.30.0] - 2026-04-26

### Changed
- **Comparison Recommended view collapses to one tile per bill.** Multiple alternative offers can exist for the same baseline (different pharmacies for one Rx; different ISPs for one cable bill). The Recommended filter now keeps the single highest-saving recommendation per `baseline.current_provider` so the page doesn't drown in near-duplicates. The All view still shows every alternative for users who want to compare them directly.
- **Switch modal collapses to one button.** The two-step Dismiss/Complete → Back/Save-switch flow had four buttons spread across two views. Replaced with a single primary "Switch completed" button — the user already saw the recommended monthly price on the offer card, so the new amount is logged from `offer.offered` instead of asking them to re-type it.
- **Tile action buttons align across cards.** `.offer-actions` now sets `margin-top: auto` so Dismiss/Compare/Switch buttons stick to the bottom of each tile regardless of how long the "Why it fits" body runs. Cards next to each other in the grid line up cleanly.

## [0.1.29.0] - 2026-04-26

### Fixed
- **Comparison banner cap was producing impossible totals.** The v0.1.28.0 math multiplied per-baseline currents by 12 — wrong for one-time bills (a $6k hospital charge isn't recurring) and wrong for multi-baseline single bills where the analyzer derived overlapping slices (an ER visit + an X-ray + a hospital balance are slices of the same bill, not additive). For the sample bill that produced **$99,246 displayed savings on a $6,372 bill**. Fixed by dropping the ×12 multiplier and capping at the cumulative `original_balance` across every attached bill in `historyCache`. Eyebrow is now "Potential savings if you switch to all recommended" — annual was the wrong frame.
- **Comparison persisted offers after every bill was deleted.** v0.1.27.0's strict-filter for `projectOfferHistory` had an exception for legacy offer files (no `run_id`) so deploying didn't surprise-empty the UI. The exception leaked stale demos through after delete-all. Strict mode is now actually strict: when `activeRunIds` is provided, every file must have a `run_id` matching the set. Legacy files without one are dropped.
- **Sample-bill fixture simplified to one baseline.** v0.1.28.0 shipped three baselines (urgent_care + imaging + hospital_bill) for the same hospital bill, which double-counted in the banner sum. Reduced to one baseline (the bill total) with two real alternatives — the hospital's federally-mandated financial-assistance program and the Dollar For nonprofit advocate. The math no longer overlaps with itself.

## [0.1.28.0] - 2026-04-26

### Added
- **Curated alternatives ship with the sample bill.** New `fixtures/bill-001.offers.json` provides three vetted alternative-provider entries (MinuteClinic, RadiologyAssist, hospital financial-assistance program) instead of relying on a live agent run that could surface bill-negotiation competitors. `runOfferHuntsForRun` detects this fixture by `<fixture_name>.offers.json` and copies the entries straight into the user's offers dir with the run_id stamped — saves a managed-agent invocation on every "Try a sample" click and makes the demo deterministic.

### Changed
- **Comparison banner shows annual savings, capped to current annual spend.** "Annual savings if you switch to all recommended" now actually multiplies by 12 (it was rendering monthly previously) and groups recommended offers by baseline (provider + category) so multiple alternatives for the same bill don't double-count. The displayed figure is hard-capped at the cumulative annual amount the user is paying TODAY across the recommended baselines — Bonsai can't claim to save more than the user is spending.

## [0.1.27.0] - 2026-04-26

### Changed
- **Comparison view follows Negotiation.** Offer-hunt files are now tagged with their owning `run_id`. When a bill is deleted, `delete-bill` sweeps every offer file belonging to that run (matching by filename fragment first, falling back to a JSON read for legacy files). At projection time, `projectOfferHistory` accepts an `activeRunIds` set and drops offers whose run no longer exists — so any orphan files missed by cleanup also disappear from the UI. When all bills are deleted, Comparison goes empty.
- **Offer-hunt agent re-grounded on the goal.** System prompt now opens with "Find cheaper alternative providers of the same service the user is already buying" and explicitly enumerates what counts (other ISPs, other pharmacies, other insurers, etc.) versus what doesn't (bill-management, bill-negotiation, subscription-tracking apps — Bonsai itself). Block-list in the prompt expanded to BillTrim, BillCutterz, Hiatus, Buddy, Subby, Bobby, MoneyLion, Chime Bill Pay, Quicken Bills on top of the original eight.
- **`COMPETITOR_BLOCKLIST` server-side check expanded** to the same set so the rejection at `coerceRecordOffer` time matches what the prompt asks for. `projectOfferHistory`'s competitor filter inherits this automatically — older offer files surfacing one of the new entries get hidden too.

## [0.1.26.0] - 2026-04-26

### Added
- **Comparison Switch flow finishes the loop.** The Switch modal now leads with a primary Complete + ghost Dismiss. Complete prompts for the new monthly amount you negotiated with the recommended provider, then writes a row into the bill's activity log: "Switched from <previous> → <new> · now paying $X/mo on <date>." New `/api/switch-complete` endpoint persists the entry on `PendingRun.completed_switches`; the drawer's Activity tab reads it back via `/api/history`.
- **Visible feedback when you Stop a negotiation.** The drawer's agent button optimistically flips to "Stopping…" the instant you click, the bills list re-renders even when you're not on the Bills tab, and a toast confirms "Negotiation stopped. You can resume anytime." The "Paused by you" status pill was already there — this surrounds it with the click feedback that was missing.

### Changed
- **Audit headline savings can never exceed what the user owes.** When the per-strategy estimates sum to more than the bill's max-savings cap (overlapping tactics that all attack the same defensible amount), individual estimates are now pro-rated at init time so the sum equals the cap. Dismissing one still drops the headline by exactly the displayed amount — both invariants hold by construction. Reverses the v0.1.25.0 raw-sum-with-qualifier approach now that the cap is a hard constraint.
- **Comparison stops surfacing duplicates and competitors.** Server-side `coerceRecordOffer` rejects (a) any provider already recorded in the same hunt session and (b) bill-negotiation competitors (Goodbill, Trim, BillFixers, Truebill, Resolve, Billshark, Cushion, Rocket Money). `projectOfferHistory` re-runs the same dedup + competitor filter at projection time so older offer files on disk also stay clean. Offer-hunt agent system prompt updated to teach the agent the same rules (defense in depth).

### Removed
- **"Accept all recommended" bulk hunt button.** The button kicked off offer-hunt across every recommended baseline, but Bonsai isn't actually switching services for users — Comparison is informational. The dead `runOfferHuntForCard` + `renderHuntPanel` SPA functions and their CSS are gone with it.

## [0.1.25.0] - 2026-04-26

### Fixed
- **Dismissing an opportunity now drops the headline savings figure 1:1.** The opportunity total was being clamped to the bill's max-savings cap, so dismissing a $200 opp off a $7,000 raw total kept showing $5,000 (the cap) until raw fell below cap — users perceived the dismiss as broken. The headline now shows the raw sum of visible opportunity estimates with a small "estimated" qualifier next to it. The post-resolution Receipts page keeps its per-receipt clamp since real-world saved can't exceed the bill amount.
- **Phone-only contacts now route to voice instead of email.** Falls out of the new chooseChannel rules; covered by a regression test.

### Changed
- **"Switch for me" button → "Switch" + instructions modal.** The card-level Switch button (and the matching button inside the Compare modal) used to re-fire the offer-hunt agent on click — wrong, because Bonsai doesn't actually sign users up for new services. Both buttons now open a static three-step instructions modal: sign up at the recommended provider, match your current plan tier, cancel the existing service after the new one is active. Step copy adapts to the offer category (Rx, insurance, internet/telecom, utility/energy).
- **Channel routing is now contact-aware, not amount-aware.** The old rule (`balance_billing && total ≥ $1500 → voice`) was a medical-only relic from the v0.1.x era. New auto rules: email-only contact → email, phone-only → voice, both on file → persistent (email first, escalate to voice after 24 working hours of no reply). The choice is re-evaluated at approve time so contact edits between audit and approve actually take effect.

### Added
- **24-working-hour voice escalation in persistent mode.** When both email and phone are on file, Bonsai now sends the appeal via email and waits for a reply. If the rep goes silent for 24 working hours (Mon-Fri 9-17 in `America/Los_Angeles` by default), the next `/api/history` poll triggers a real ElevenLabs call to the same provider. New helper `src/lib/business-hours.ts` (`workingHoursElapsed`) handles tz-correct idle math; new `src/server/persistent-advance.ts` is the idempotent escalation pass with a per-user 5-minute throttle hooked into `handleHistory`.
- **Persistent-mode `NegotiationState` carries `email_outbound_sent_at`, `last_inbound_received_at`, `escalated_to_voice_at`, and `run_id`** so the advance pass can correlate stale email threads back to their bill run for voice dialing without scanning every run on disk.

## [0.1.24.0] - 2026-04-26

### Added
- **MIT license + governance scaffolding for OSS launch.** Adds `LICENSE` (MIT, copyright "Bonsai contributors"), `CONTRIBUTING.md` (prerequisites, local setup, PR style, what's welcome, what's out-of-scope without a design doc), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1 by reference), and `.github/{ISSUE_TEMPLATE/{bug,feature}.md, PULL_REQUEST_TEMPLATE.md}`. `package.json` gains `"license": "MIT"`.
- **`validateRequiredEnv()` on startup.** New exported helper in `src/env.ts` that exits 1 with a readable error if `ANTHROPIC_API_KEY` or `BONSAI_PUBLIC_DOMAIN` is missing or empty. Wired into `src/server.ts`, `scripts/run-bonsai.ts`, and each of `scripts/day1-poc.ts` through `day5-voice-call.ts`. Tests skip the call (passive `.env` loader is unchanged), so `bun run test` continues to work without keys set. Verified: `env -i bun run scripts/run-bonsai.ts` exits 1 with the readable error, no stack trace.
- **Mock-mode warning when Resend env is unset.** `autoEmailClient()` now logs a one-time `console.warn` when `RESEND_API_KEY`/`RESEND_FROM` aren't configured, so a fork operator notices they're in `MockEmailClient` mode instead of silently writing threads to disk forever.

### Changed
- **README repositioned for general-purpose framing.** Drops the medical-only hero ("Medical bill audit + negotiation, end-to-end" + Devpost line) and leads with **"Agents to manage personal bills."** New "Why this exists" + "The five agents" sections cover the canonical product vocabulary: analyzer / appeal / contact resolver / negotiation / comparison. Adds MIT + Bun version badges, a Configuration table for every env var, and Contributing pointers. Backups section preserved from 0.1.23.0.
- **`.env.example` restructured into REQUIRED + OPTIONAL sections.** `BONSAI_PUBLIC_DOMAIN` is now REQUIRED — a forcing function so a fresh fork can't accidentally ship with the original operator's domain in any rendered URL. Documents `BONSAI_AUDIT_DAILY_LIMIT` (verified wired in `src/server.ts`), `SENTRY_DSN` (reserved), and the `BACKUP_S3_*` vars introduced in 0.1.23.0.
- **`package.json` description.** Replaced "Agent that finds errors in medical bills and drafts appeal letters" with the v0.1.24 framing covering insurance, utilities, medical, credit, and subscription costs.

### Fixed
- **Operator personal info scrubbed from public assets and code comments.** Replaced every occurrence of `bonsai.firebaystudios.com`, `gcahill@firebaystudios.com`, `garrett@cointracker.com`, and the operator's name in OG meta blocks (`public/{index,landing,terms,privacy}.html`), the OG image SVG footer, the landing-page footer mailto, `scripts/resend-inbound-smoke.sh`, `scripts/test-resend.ts` JSDoc + example error messages, and `src/clients/email-resend.ts` comments. Test fixtures using the IETF-reserved `@example.com` TLD are intentionally untouched.
- **Hardcoded `https://bonsai.app/` removed from inbound-reply user notifications.** `src/server/webhooks.ts:133` now reads `BONSAI_PUBLIC_DOMAIN` (with a `your-bonsai-domain.com` fallback string) so a fork operator's reply emails point at their own domain instead of an unrelated host.

## [0.1.23.0] - 2026-04-26

### Added
- **Configurable support email.** New `BONSAI_SUPPORT_EMAIL` and `BONSAI_PUBLIC_DOMAIN` env vars surfaced via an unauthenticated `GET /api/public-config` endpoint. Landing page footer, Settings → Help, and the new branded error pages all render the operator's address from this — no more hardcoded `mailto:hello@bonsai.firebaystudios.com` in the source. OSS forks and the canonical deployment configure independently per-deploy.
- **Branded 404 and 500 pages.** Replaced bare-text `"Not found"` and stack-trace-leaking JSON 500 with full-bleed centered cards using the brand wordmark, Instrument Serif typography, and the existing CSS tokens. `/api/*` and `/webhooks/*` routes still return JSON 500s for callers that expect them; only HTML page navigations get the rendered page. Stack traces stay server-side and log with a `[500]` prefix + path so Railway logs are searchable.
- **Nightly volume backup.** Optional tarball backup of `BONSAI_DATA_DIR` to any S3-compatible object store (Backblaze B2 recommended — ~6× cheaper than S3). Gated on four `BACKUP_S3_*` env vars; with any unset the scheduler logs `[backup] disabled` and the server runs without backups. On boot, fires a catch-up run if the last successful backup is missing or > 25h old, then re-fires every 24h. Streams `tar -czf -` directly to S3 via `@aws-sdk/lib-storage` (multipart-aware), keys objects as `bonsai-backups/YYYY-MM-DD.tar.gz` (one per UTC day, idempotent), and prunes anything older than 30 days. Failures are non-fatal — they log and the next nightly retries. New `scripts/restore-backup.ts` validates a backup's contents and prints the exact `tar -xzf` command for a manual restore (never auto-extracts).

## [0.1.22.0] - 2026-04-26

### Changed
- **Offer hunt now fires on approve too, not just on audit.** Previously the comparison agent ran exactly once at audit time, and `mapBillKindToCategory` returned `null` for every real `BillKind` value (`medical`/`telecom`/`utility`/...) — none matched the `OfferCategory` enum (`prescription`/`lab_work`/`hospital_bill`/...). Net effect: the audit-time hunt almost always silently no-op'd, and a user who accepted the appeal but never visited Comparison saw no offers. Multi-category `deriveOfferBaselines` (replaces single-baseline `deriveBaselineFromAudit`) inspects `provider_name` regex (Walgreens/CVS → prescription, Quest/LabCorp → lab_work, hospital + balance > $1500 → hospital_bill, etc.), `bill_kind`, and error `line_quote` drug-name patterns to emit one `Baseline` per detected category. Both `/api/audit` and `/api/approve` fire the new `runOfferHuntsForRun` helper.
- **Comparison nav pulse now follows the live server-side hunt instead of a fixed 10s window.** New `GET /api/offer-hunt/status/:run_id` endpoint reports `{in_flight, baselines_total, baselines_done, started_at, ended_at}` from a new `offer_hunt` field on `PendingRun` (disk-persisted, survives restart). The Comparison nav pulses while any tracked run is in_flight, capped at 5 minutes — accepting an appeal and walking away to another tab still shows the pulse and refreshes offers when the hunt lands. Replaces the prior tab-active-only 10s pulse that gave up before real 30–90s managed-agent hunts could complete.

## [0.1.21.2] - 2026-04-26

### Fixed
- **Typecheck regression on main.** `src/orchestrator.ts:39` imported only `loadConversationMeta` from `./lib/call-store.ts`, but line 467 calls `saveConversationMeta(meta)` — `bun run typecheck` has been red since v0.1.13.0 (real ElevenLabs voice). Added `saveConversationMeta` to the import. The function exists and is exported (`src/lib/call-store.ts:76`) and is correctly imported in both `src/server/voice-dial.ts` and `src/server/voice-webhooks.ts` — orchestrator was the only callsite missing it.

## [0.1.21.1] - 2026-04-26

### Fixed
- **Contact-card poll no longer overwrites a typed billing-dept email (continued).** v0.1.12.0 patched the wipe-to-empty in `applyContactStatus`'s lookup-failed branch but missed the parallel hazard in the success branch — `if (document.activeElement !== emailEl) emailEl.value = c.email ?? ""` ran on every poll tick (every 2.5s) and clobbered the user's input the moment focus moved to the Accept button. So a user who pasted `user@example.com`, watched the "Manually entered by the user." note appear, and then clicked "Accept & lower my bill" could still hit the missing_contact warning if a poll fired in the focus-shift window. Same `!emailEl.value` guard now applies to both branches: empty fields populate from the polled contact, non-empty fields are left alone. Phone field gets the same treatment.
- **`approveAndRun`'s pre-flight contact save now surfaces HTTP errors instead of swallowing them.** The save was wrapped in a try/catch that only handled network errors — a 4xx/5xx response from `/api/contact/override` would resolve normally, the code would proceed to `/api/approve` with stale `run.contact`, and the user would see the missing_contact warning even though the autosave "didn't fail" from the client's perspective. Now we check `saveRes.ok`, surface the server's error message in `#contact-save-status`, highlight the contact card, and abort before approve fires.

## [0.1.21.0] - 2026-04-26

### Removed
- **"Connected accounts" section in Settings is gone entirely.** v0.1.20.0 emptied the integrations array on `/api/settings`, but `mkIntegrationsCard` still rendered the section header + a "No integrations configured / Nothing to connect yet" empty-state row. Now `renderSettings` doesn't append the integrations card at all — the Settings page is just **Tune** and **Account**. Every integration (Anthropic, Resend, ElevenLabs) is operator-owned via Railway env vars; users have nothing to configure here, so showing them an empty section was confusing dead chrome.

The `mkIntegrationsCard` function, the `intg-modal` HTML, the CSS classes, and the `/api/settings/integrations` write surface all stay on disk untouched — cheap insurance in case we ever want a per-user "Connect ..." UI back. They're just not surfaced.

## [0.1.20.0] - 2026-04-26

### Removed
- **"ElevenLabs (call)" card in Settings → Connected accounts.** Voice is now operator-owned in the same shape as Anthropic and Resend — the `ELEVENLABS_*` env vars on Railway are the source of truth, every user shares the operator's account/number/minutes, and there's nothing for an end user to configure. The card was a leftover from when voice was per-user-optional and added a confusing "do I need to do something here?" hurdle. `handleSettings` in `src/server.ts` now returns `integrations: []` (Anthropic and Resend were already hidden — they had moved to operator-owned in v0.1.x).

The storage plumbing (`IntegrationsConfig.elevenlabs_*` fields, `applyIntegrationsToEnv` mapping, `/api/settings/integrations` accepting `elevenlabs_*` writes) is fully intact — ready to repower a per-user "Connect ElevenLabs" UI later if/when we want users to bring their own account. Just not surfaced today.

## [0.1.19.0] - 2026-04-26

### Changed
- **Comparison nav pulses while the hunt is in flight, so users know something's happening even before they navigate to that tab.** Previously, the comparison agent fired in the background after each audit (`handleAudit` → `runOfferHunt`) but the only visible signal was on the Comparison page itself — and most users were still on the review screen reading audit findings. Now `runPhasedFromUpload` / `runPhasedFromSample` / `runPhasedFromPrefetch` each call `markComparisonHuntStarted()` after the audit response lands, which stamps `comparisonHuntStartedAt = Date.now()`. `updateNavCounts` toggles `is-hunting` on the Comparison nav while `Date.now() - comparisonHuntStartedAt < OFFERS_POLL_CAP_MS`. CSS drives a soft 1.4s fade on the icon + label (45% opacity at the trough) so the activity reads as ambient rather than alert-y. The class clears when offers actually arrive (`loadOffers` calls `updateNavCounts` after every fetch) or when the 10s window expires (a delayed `setTimeout` re-runs `updateNavCounts`).
- **Hunt poll cap and copy: 30s → 10s.** `OFFERS_POLL_CAP_MS` is now `10 * 1000`, and the hunting hero body reads "This usually takes under 10 seconds." Real hunts that succeed return inside that window; past it the user sees the offer-shaped "You're with the best provider" card rather than continued spinning.

## [0.1.18.0] - 2026-04-26

### Fixed
- **Duplicate bill names get Finder-style "(1)" / "(2)" suffixes.** Auditing the same provider twice used to leave two indistinguishable rows on the Bills list and the Receipts hero. Render-time only — stored `provider_name` is untouched. Oldest entry keeps the bare name, newer dupes pick up suffixes. Case-insensitive grouping; trailing whitespace doesn't split groups; placeholders ("Unknown provider", null) are never suffixed.
- **Delete bill is now instant.** Removing a bill no longer parks the row in a "waiting" state while the network roundtrip happens. The drawer closes and the row vanishes immediately; the server delete fires in the background. The server endpoint is also idempotent now — a missing pending record returns 200 instead of 404, so a race with another tab or a stale handle doesn't paint an error toast over a successful local delete.
- **Discard-confirmation modal no longer fires for staged-but-not-yet-audited files.** `hasInFlightAuditWork()` was treating any file in the dropzone as in-flight work, so dropping a bill on the home page and clicking any other tab popped "Discard the bill you're about to upload?" — and the same check fired between "Accept and lower my bill" and the Bills view. Staged files are cheap to re-drop; the discard guard now only fires for the audit progress view, the review screen with a live audit, or a complaint draft. Inline highlight on the contact card for missing email/phone is unchanged (it's not a modal), and `showApproveBlocker` still surfaces the `email_not_configured` 503 (correct prod behavior — that fires when `RESEND_API_KEY` / `RESEND_FROM` aren't set).

### Changed
- `handleDeleteBill` logic moved out of `src/server.ts` into `src/lib/delete-bill.ts` with injected dependencies, so the new `test/delete-bill-completed.test.ts` exercises it without booting Bun.serve. Path-prefix guard on `bill_paths` unlinks is preserved and tested.

## [0.1.17.0] - 2026-04-26

### Changed
- **"You're with the best provider" now renders as an offer-shaped card.** Previously it used the giant `.empty-hero-card` visual language — display font, 56px padding, centered max-width. The result felt like an alert overlay sitting on top of an empty page, not part of the Comparison surface. New `buildBestProviderCard` builds a real `.offer-card` (1px line border, 10px radius, 20px padding, check icon in the head, "Why we think so" sub-section) so the user sees the same card chrome they'd see if Bonsai HAD found an alternative — minus the price row and Switch/Compare/Dismiss actions. Spans both grid columns via a thin `.offer-card-best { grid-column: 1 / -1; }` rule so it doesn't sit lopsided next to an empty cell.
- **Comparison polling no longer activates when the user has no negotiations.** `pollOffersUntilFresh` now early-returns when `historyCache.audits.length === 0`. The comparison agent only runs server-side on audit completion (`handleAudit` in `src/server.ts`), so without any audits there's nothing in flight to wait on — polling the empty state and eventually surfacing "You're with the best provider" was misleading. New users with no bills uploaded see the idle "No alternatives yet — Go to Home" hero (already shipped in 0.1.15.0); the spinner and the timed-out card are reserved for users whose audits actually triggered a hunt.

## [0.1.16.0] - 2026-04-26

### Changed
- **Hunting hero copy + live elapsed-time counter.** Body text now reads "Searching the web for cheaper providers to lower your recurring expenses. This usually takes under 30 seconds. Xs elapsed" — was "...that match your recent audit." The "Xs elapsed" now ticks every second via a 1s `setInterval` that targets `.empty-hero.hunting .hunt-elapsed` directly. The interval self-clears when the hero leaves the DOM (chrome restored, user navigated away, hero replaced), so callers don't need explicit teardown.
- **Hunt poll cap dropped from 5 minutes to 30 seconds, with a "You're with the best provider" empty state.** Real hunts that succeed almost always return inside 30s — keeping the spinner up for 5 minutes was a liveness lie. After 30s the page now flips to the regular Comparison chrome (banner hidden, "Recommended" / "All" filter chips) and renders a centered "You're with the best provider" card inside the grid: "Bonsai searched the web for cheaper alternatives and didn't find one. We'll check again the next time you upload a bill." A new offer-hunt run on a subsequent audit (or a "Switch for me" click) clears the timed-out flag and re-polls normally. The card reuses the `.empty-hero-card` visual language (1.5px ink-32% border, 12px radius, display font for the title) so the timed-out state and the idle "No alternatives yet" hero feel like the same family.

## [0.1.15.0] - 2026-04-26

### Fixed
- **Comparison page no longer says "Comparison is in beta".** When the feature shipped in v0.1.13.0, `renderEarlyAccessHero` was left in place as the fallback for users with no offers cached — so a fresh user landing on Comparison still saw the old gating hero with "Sign up for early access". Replaced with `renderHeroEmptyView({title: "No alternatives yet", body: "Bonsai hunts for cheaper providers across your recurring costs every time you upload a bill. Drop one on the Home tab to kick off your first audit — Comparison populates automatically once it's done.", cta: "Go to Home"})`, which matches the empty-state pattern used on the Bills tab and routes the CTA to `/overview`.
- **Polling spinner no longer destroys the offer-grid chrome.** The spinner branch in `renderOffers` was using `view.innerHTML = ...` which nuked `#offers-grid`, `#offers-banner`, and `#offers-filters`. Once that happened, the cards branch couldn't find those elements on the next render and silently no-op'd — so even when offers arrived after a poll cycle they never appeared on screen. New `renderComparisonHuntingHero` uses the same stash-and-swap pattern as `renderHeroEmptyView`, and `renderOffers` calls `restoreViewChildren(view)` before rendering cards to bring the chrome back from the stash.

The `/api/early-access` endpoint and `users.early_access_at` column are left intact — users who opted in during the beta still have that record, even though the UI no longer surfaces a way to add new signups.

## [0.1.14.0] - 2026-04-26

### Added
- **Real ElevenLabs voice negotiation, end-to-end.** The orchestrator now places real outbound calls when all four `ELEVENLABS_*` env vars are set; with any missing it falls back to the existing dual-Claude simulator. The simulator path is unchanged, so day-to-day dev never spends Twilio minutes. Full setup steps live in the new "Voice setup" section of the README.
- **`POST /api/voice/dial` endpoint.** Auth-gated, takes `{run_id}`, looks up the run's resolved provider phone, gets-or-creates a per-user ElevenLabs agent, and either places the call via `client.startOutboundCall` or short-circuits when `VOICE_DRY_RUN=true`. Returns `{conversation_id, dry_run, agent_id, agent_cached}` to the SPA.
- **Six unauthenticated webhook routes at `/webhooks/voice/<tool>`.** ElevenLabs server tools post here (`get_disputed_line`, `confirm_eob_amount`, `propose_general_discount`, `record_negotiated_amount`, `request_human_handoff`, `end_call`). Each route verifies the Bearer token via constant-time compare against `ELEVENLABS_WEBHOOK_SECRET`, validates the `conversation_id` against an ASCII allowlist (path-traversal hardening), takes the per-conversation lock, dispatches into the existing `tool-handlers.dispatchToolCall` (same code the simulator uses), and appends a transcript turn. Late-arriving tool calls after `end_call` no longer mutate the finalized envelope.
- **Per-user ElevenLabs agent cache.** New `voice_agents` SQLite table keyed on `user_id` with an SHA-256 of the agent config; identical bills reuse the same agent across calls, mutated configs (different patient, floor, webhook base, etc.) bust the cache and create a fresh agent.
- **Operator-wide daily voice budget.** New `voice_spend` table (one row per UTC day) plus `BONSAI_VOICE_DAILY_BUDGET_USD` (default $50). The dial endpoint refuses to place a call when `(today_spend + max_estimate) > cap`. `end_call` debits the actual cost.
- **Per-user daily voice quota.** `BONSAI_VOICE_DAILY_LIMIT` (default 5 calls / 24h sliding window) returns 429 with a user-readable "Daily voice call limit hit." message.
- **Pre-call confirmation modal.** New `voice-confirm-modal` in `public/index.html`; `dialVoiceWithConfirm({runId, providerName, providerPhone})` exposed on `window` in `public/assets/app.js`. Fetches `/api/voice/cost` to populate the price range and only fires the dial on Confirm.
- **`scripts/voice-smoke.ts`.** Operator-driven end-to-end smoke against a test number; polls the per-user transcript file until `end_call` lands and prints the final state.
- **`VOICE_DRY_RUN=true` flag.** `/api/voice/dial` logs the call it would place and returns a synthetic `dryrun_*` conversation_id without invoking ElevenLabs — lets agents and the smoke script exercise the wiring without burning Twilio minutes.

### Changed
- `src/orchestrator.ts` voice branch routes to a new in-process `dialVoiceForUser` helper when env is configured; polls the conversation meta file until the agent's `end_call` webhook flips status to `"ended"`. On a 30-min timeout the meta is marked `"failed"` and a degraded transcript is returned instead of throwing — so a stuck call doesn't lose the partial transcript or leak a "negotiating" run forever.
- `BonsaiReport.voice_call.source` now tags `"real" | "simulator"` so the SPA can badge which path produced the transcript.
- `.env.example` documents the four `ELEVENLABS_*` vars plus the three cost knobs (`BONSAI_VOICE_DAILY_LIMIT`, `BONSAI_VOICE_DAILY_BUDGET_USD`, `VOICE_DRY_RUN`).

### Tests
- New `test/voice-cost.test.ts` covers estimator math at default / point / zero, the per-user 5-call rate limit triggering on the 6th call, the `BONSAI_VOICE_DAILY_LIMIT` override, the operator budget cap blocking dials, missing-phone 400, and the dry-run synthetic-id path.
- New `test/voice-agent-cache.test.ts` verifies first call creates + writes the row, second call with identical config hits the cache without invoking `createAgent`, and a mutated config busts the cache.
- New `test/voice-webhooks.test.ts` covers Bearer good/bad/malformed/length-mismatch/dev-mode/prod-mode, 401/404/400 paths, all six tool dispatches (parametric), the `withCallLock` mutex serializing 8 concurrent webhooks, the 404 when CallState is missing, and the `end_call` finalization path.
- New `test/voice-spend.test.ts` exercises the spend tracker directly: same-day accumulation, separate UTC-day buckets, no-op behavior on zero/negative/NaN, and the budget env override.
- 35 new voice tests; full suite 269/269 passing post-merge with main.

## [0.1.13.0] - 2026-04-26

### Changed
- **Comparison page now shows real cheaper alternatives instead of an empty hero.** The Comparison tab in the sidebar is no longer a "beta" placeholder — it loads offer cards from `/api/offer-history`, which flattens every persisted offer-hunt run into a single newest-first, savings-first list. When a fresh user lands on Comparison with no runs yet, the page polls every 5 seconds (capped at 5 minutes) so the offers populated by the background hunt that fires on each audit completion appear automatically. Cards drop the placeholder fields the old mock data carried (`confidence`, `friction`, `eta`, `unit`, per-category icons) — every field the UI now displays comes from a real backend value. The Compare modal is simplified accordingly. Switching providers (`Switch for me`) hits the live `/api/offer-hunt` and renders the agent's recorded offers with provider name, price, savings, channel, terms link, and a recommendation flag.
- **Offer hunt is now a real research agent on Anthropic's Managed Agents SDK.** `src/offer-agent.ts` was a hand-rolled tool-use loop that simulated 30+ provider personas (GoodRx, Costco, Lemonade, etc.) via persona prompts with `quote_multiplier_range` hints — none of it was real outreach. The new implementation creates one persistent managed agent (cached by config-hash in a `managed_agents` SQLite table so we don't re-provision on every run) with `agent_toolset_20260401` (web search + web fetch enabled, bash/write/edit disabled) plus two custom tools: `record_offer` and `mark_exhausted`. Each hunt opens a session, streams events, dispatches custom-tool calls back as `user.custom_tool_result` events, and exits cleanly on `session.status_idle` with a terminal `stop_reason` (the bare-idle case is correctly treated as "waiting on a tool result, not done"). Reconnects mid-hunt consolidate via `events.list` + dedupe by event ID so a 30s+ hunt survives a network blip. The session is archived in a `finally` so quota leaks are contained even on errors.
- **Audit completion eagerly kicks off an offer hunt in the background** (`handleAudit` in `src/server.ts`) so by the time the user navigates to Comparison, results are usually waiting. A new `deriveBaselineFromAudit` helper maps the audit's `analyzer.metadata.bill_kind` to an `OfferCategory` and returns `null` when no clean mapping exists — better to render no offers than to burn managed-agent quota on a baseline the agent can't act on.

### Removed
- **All offer-hunt simulator infrastructure** — `SOURCE_DIRECTORY` (lines 74–270 of the old `offer-agent.ts`), the `OfferSource` interface, `queryOneSource()`, `quote_multiplier_range`, the `OFFER_SOURCE_DIRECTORY` export, and the `/api/offer-sources` route. ~250 lines of persona-driven roleplay code is gone; the new agent does real web research via the prebuilt toolset.
- **The `<span class="nav-tbd">beta</span>` chip** next to the Comparison nav item in `public/index.html`. Replaced with the standard `nav-count` badge the other nav items use.

### Added
- **`src/lib/managed-agent-cache.ts`** with `getOrCreateOfferAgent()` — reads the cached `agent_id`/`environment_id` from SQLite, recreates if the SHA-256 hash of the canonical agent config (model + system prompt + tools + environment) drifts. New `managed_agents` table keyed on `purpose` so future managed agents (negotiation, intake) can share the same caching layer.
- **`src/lib/offer-history.ts`** — pure projection logic that flattens persisted `OfferHuntResult` JSONs into the offer-card shape the Comparison UI consumes. Extracted from `server.ts` so it can be unit-tested without booting `Bun.serve`.
- **Three new test files** covering the migration end-to-end: `test/managed-agent-cache.test.ts` (3 tests, verifies caching + config-hash invalidation), `test/offer-agent-managed.test.ts` (4 tests, mocks the SDK at the events.stream boundary and asserts the full offer-hunt loop's state transitions and tool-result dispatch), `test/offer-history-projection.test.ts` (4 tests, verifies projection sort order, malformed file resilience, and stable IDs). Total suite 234 tests passing.

### Tests
- New `test/managed-agent-cache.test.ts`, `test/offer-agent-managed.test.ts`, `test/offer-history-projection.test.ts` — 11 new tests, total suite 234/234.

### Dependencies
- Bumped `@anthropic-ai/sdk` from `^0.40.0` to `^0.91.1` for the Managed Agents `client.beta.{agents,sessions,environments}.*` namespaces. The new SDK strict-types `input_schema.type` as the literal `"object"`, so `OPPS_TOOL` in `src/opps-filter.ts` is now annotated as `Anthropic.Tool` to satisfy the tighter type.

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
