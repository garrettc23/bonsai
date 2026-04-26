# Security Policy

## Supported Versions

Bonsai is pre-1.0 (beta). Only the latest released version receives security
updates. Older versions are unsupported — please update before reporting.

| Version       | Supported          |
| ------------- | ------------------ |
| latest        | :white_check_mark: |
| anything else | :x:                |

## Reporting a Vulnerability

**Email:** [gcahill@firebaystudios.com](mailto:gcahill@firebaystudios.com)

Please report vulnerabilities **privately** by email. Do not open public
GitHub issues or pull requests for security reports — public disclosure
before a fix ships puts users at risk.

In your report, include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof-of-concept.
- The affected version (commit SHA or release tag).
- Your name / handle for credit, if you'd like to be acknowledged.

You'll get an initial response within **72 hours** acknowledging receipt and
a triage assessment.

## In Scope

We treat the following as security issues and will prioritize them:

- Authentication or authorization bypass.
- Remote code execution (RCE) on the server.
- Data exposure across user accounts (one user reading another's bills,
  contacts, or run history).
- Secret extraction from the server runtime (API keys, session tokens,
  environment variables).

## Out of Scope

The following are **not** considered security vulnerabilities for this
project at its current stage:

- Rate-limit bypass on public endpoints.
- Social engineering of maintainers or users.
- Brute force against accounts that don't have a lockout policy (we don't
  yet enforce account-level lockouts).
- Reports from automated scanners without a working proof-of-concept.
- Self-XSS or attacks requiring physical access to the victim's device.

## Disclosure Timeline

We follow a standard **90-day** coordinated disclosure timeline:

- **Day 0** — Report received, acknowledged within 72 hours.
- **Day 0–7** — Triage and severity assessment.
- **Day 7–80** — Fix developed, reviewed, and deployed.
- **Day 90** — Public disclosure (advisory + credit), even if a fix is not
  yet shipped, unless we've agreed to an extension with the reporter.

We're happy to coordinate on timing if a longer embargo is genuinely needed
(e.g., dependent ecosystem fixes).
