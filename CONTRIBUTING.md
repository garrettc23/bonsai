# Contributing to Bonsai

Thanks for your interest. Bonsai is a small, opinionated codebase — the goal is agents that quietly save people money on every recurring bill, not a generic platform. Contributions that move that mission forward are very welcome.

## Prerequisites

- **Bun ≥ 1.1** — package manager + test runner + TypeScript loader. Install from [bun.sh](https://bun.sh).
- **Anthropic API key** with a paid plan. Bonsai uses Claude Opus 4.7 for analysis, appeal, and negotiation; the model isn't available on the free tier.
- A modern macOS or Linux shell. Windows hasn't been tested.

## Local setup

```bash
git clone https://github.com/<your-fork>/bonsai.git
cd bonsai
bun install
cp .env.example .env
# Open .env and fill in ANTHROPIC_API_KEY + BONSAI_PUBLIC_DOMAIN.
bun run make-pdfs   # builds the synthetic fixture PDFs
bun run serve       # http://localhost:3333
```

Bonsai will refuse to start if `ANTHROPIC_API_KEY` or `BONSAI_PUBLIC_DOMAIN` are missing. That's intentional — see `src/env.ts`.

## Running tests

```bash
bun run test         # unit + integration tests
bun run typecheck    # strict TypeScript
```

Tests don't require any API keys. They use synthetic fixtures and mocks.

## Submitting a PR

- Branch from `main`.
- Keep commits atomic — one logical change each.
- Title format mirrors recent history: `fix:`, `feat:`, `chore:`, optionally with a scope (e.g. `fix(comparison): ...`).
- Fill in the PR template's **Summary**, **Why**, and **Test plan** sections.
- For UI changes, paste a before/after screenshot.

CI runs `bun run typecheck` and `bun run test` on every PR. Both must be green before review.

## What we're looking for

Pull requests in any of these areas are pre-approved in spirit — open one without asking:

- **New offer-source integrations** for the comparison agent: utilities, telecom, insurance brokers, lines of credit.
- **New analyzer rules** for bill categories Bonsai doesn't handle yet (rent, taxes, subscriptions).
- **IVR navigation** improvements for the voice agent — better DTMF handling, smarter hold-listening.
- **Accessibility** — keyboard nav, screen reader labels, high-contrast review.
- **Bug fixes** with a failing test attached.

## Out of scope without a design doc first

Open a discussion before opening a PR for any of these:

- Changes to the **grounding contract** (every dispute must quote the source verbatim — this is core to Bonsai's correctness story).
- Model swaps to anything below Opus 4.7. The negotiation and appeal loops are tuned for that capability tier and silently degrade on smaller models.
- Architectural rewrites of the five-agent orchestration.

## Code style

- TypeScript strict mode, no `any`.
- Comments only when the *why* is non-obvious. Don't restate the code.
- Prefer reading existing patterns over inventing new ones.

## Post-clone polish (maintainers only)

Some repo settings can't be set via CLI. After forking or setting up a fresh maintainer environment:

- Upload `public/og-image.png` (1280×640) at GitHub → Settings → Social preview.

## Questions

Open a [Discussion](https://github.com/<your-fork>/bonsai/discussions) or file an issue. Bonsai is volunteer-maintained — replies may take a few days.
