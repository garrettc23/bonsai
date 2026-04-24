# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
