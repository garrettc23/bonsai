# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
