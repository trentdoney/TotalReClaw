# Security Policy

## Supported Versions

This repository is source-first and currently maintained on the default branch. Security fixes are made there first.

## Reporting a Vulnerability

Do not open public issues for suspected vulnerabilities.

Report security problems through GitHub private vulnerability reporting:

- `https://github.com/SynapseGrid-Labs/TotalReClaw/security/advisories/new`

Include:

- a short summary
- affected file paths or commands
- reproduction steps
- impact assessment
- any suggested remediation

I aim to acknowledge new reports within 5 business days and will share remediation status as the issue is triaged.

## Scope

This project stores operational memory, review drafts, and accepted summaries. High-priority security issues include:

- secrets or tokens written to drafts or durable storage
- unsafe remote-command execution paths
- prompt or tool injection paths that bypass operator intent
- unintended disclosure of local filesystem paths, hostnames, or credentials in published artifacts

## Handling Sensitive Data

TotalReClaw must never persist:

- raw secrets
- API keys
- tokens
- private keys
- cookies
- `.env` values
- credential-bearing URLs

The capture flow redacts known secret patterns before draft creation and before durable writes. Review accepted records before sharing stores across machines or publishing derived examples.
