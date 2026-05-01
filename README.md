# TotalReClaw

[![CI](https://github.com/SynapseGrid-Labs/TotalReClaw/actions/workflows/ci.yml/badge.svg)](https://github.com/SynapseGrid-Labs/TotalReClaw/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/SynapseGrid-Labs/TotalReClaw)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.14.0-339933?logo=nodedotjs&logoColor=white)](package.json)

![TotalReClaw header](docs/images/totalreclaw-header-vip.svg)

TotalReClaw is an OpenClaw plugin plus skill that gives an agent durable operational memory. It recalls prior fixes, decisions, procedures, blockers, environment state, and accepted session summaries before work repeats itself.

OpenClaw is a tool-using agent runtime that can load local skills and plugins, so TotalReClaw is designed to sit directly in the operator loop instead of acting as a separate memory service.

It is built for operator workflows where "what did we already learn?" matters as much as the next command.

Status: public alpha. The install path, storage model, commands, historical-session import, and automatic hooks are in place. Expect breaking changes before `1.0.0` while the project broadens host validation and release coverage.

## Purpose

TotalReClaw is built for practical operations work: install history, debugging context, host state, reusable procedures, and decisions that should be visible before an agent repeats a risky step.

## What it does

- injects relevant prior context before a risky operational prompt
- captures new operational records as reviewable drafts instead of silently writing memory
- accumulates live session context and turns it into a review draft on session close
- imports historical OpenClaw conversations so old session context can become durable recall
- stores accepted memory in local SQLite and keeps drafts/session buffers in plain JSON
- explains why a recommendation was surfaced and flags conflicting memory instead of hiding it

## What ships in this repo

- `TotalReClaw` user-invocable skill with `/totalreclaw ...` commands
- `totalreclaw` OpenClaw plugin with automatic recall and session capture hooks
- local storage engine for accepted records and session summaries
- remote install and verification scripts for an SSH-managed OpenClaw host

## Quick start

Prerequisites:

- OpenClaw with TypeScript-aware extension loading
- OpenClaw `2026.4.24+`
- Node `22.14.0+`
- SSH access to the target host if you want to install remotely

Local verification:

```bash
npm ci
npm run verify
```

Remote install:

These scripts are opinionated admin helpers with real operational blast radius. Use them only for paths and hosts that TotalReClaw is meant to own.

- `rsync --delete` is used against the managed extension and skill directories
- `~/.openclaw/openclaw.json` is rewritten after a timestamped backup is created
- the remote OpenClaw gateway is restarted as part of install

```bash
REMOTE_HOST=my-openclaw-host ./scripts/install-remote.sh
REMOTE_HOST=my-openclaw-host ./scripts/verify-remote.sh
```

The installer updates the remote OpenClaw config, ensures the skill and plugin paths exist, and restarts the remote gateway.

Expected result after remote verify:

- the plugin is present under `~/.openclaw/extensions/totalreclaw`
- the skill is visible to OpenClaw as `TotalReClaw`
- the OpenClaw gateway loads the plugin without config errors
- `/totalreclaw demo` and `/totalreclaw recall "..."` return normal command output

## Core commands

```text
/totalreclaw check "<task>"
/totalreclaw recall "<query>"
/totalreclaw sessions [<query>]
/totalreclaw summary --latest|--session <id>
/totalreclaw timeline --session <id>|"<query>"
/totalreclaw session close [--current|--session <id>]
/totalreclaw session import [--db <path>] [--limit <n>] [--conversation <id>|--session <id>] [--accept]
/totalreclaw capture --file <path>
/totalreclaw capture --stdin "<summary>"
/totalreclaw capture --accept <draft-id>
/totalreclaw explain "<query>"
/totalreclaw resolve "<query>" [--action keep-newer|keep-older|merge|defer] [--left <record-id> --right <record-id>]
/totalreclaw demo
```

Operational verdicts returned by `check` and `recall`:

- `prior_fix_found`
- `context_found`
- `no_match`
- `conflicting_memory`

## When to use what

Use `check` or `recall` before:

- an install or reinstall
- a config change
- a restart or recovery step
- a repeated failure investigation

Use `capture` when you have a durable lesson worth keeping:

- a root cause and fix
- a decision that changes future work
- a procedure that should be reused
- an environment fact that keeps tripping operators

Use `session close` when a working session produced useful context and you want a reviewable summary draft instead of losing it.

## Visual overview

![TotalReClaw architecture](docs/images/totalreclaw-architecture-vip.svg)

![TotalReClaw workflow](docs/images/totalreclaw-workflow-vip.svg)

## Example workflows

Recall before a risky change:

```text
/totalreclaw check "fix missing plugin skill after install"
```

Typical outcome:

```text
Verdict: prior_fix_found
Recommended next step: review the prior fix and validate it against the current host state before repeating it.
```

Capture a new record from notes:

```text
/totalreclaw capture --stdin "Category: decision
Summary: Keep accepted memory in SQLite
Details: Durable records live in SQLite. Drafts stay JSON so they remain reviewable and easy to inspect."
```

Then accept the draft after review:

```text
/totalreclaw capture --accept draft_abc123
```

Close the current session into a draft:

```text
/totalreclaw session close --current
```

Backfill historical OpenClaw sessions into durable memory:

```text
/totalreclaw session import --accept --limit 25
```

Inspect accepted session memory later:

```text
/totalreclaw sessions plugin install
/totalreclaw summary --latest
/totalreclaw timeline --session session_abc123
```

## How it works

TotalReClaw uses three automatic plugin hooks:

- `before_prompt_build`: reads current prompt text, checks whether it looks operational, and prepends a small reference-only recall block when there is a useful match
- `before_message_write`: accumulates session context as messages are written so a later `session close` can turn it into a review draft
- `before_reset`: finalizes the matching accumulated session into a review draft before a reset discards it

Memory is never blindly auto-accepted. The automatic path only creates context or drafts. Durable records require an explicit accept step.

Historical import follows the same model unless you explicitly pass `--accept`. That makes it safe to review imported drafts first, or to fast-track an existing OpenClaw history backfill when you need a live demo.

## Configuration

TotalReClaw is configured through the OpenClaw plugin config. The plugin fails open on hook problems and keeps recall bounded by time and token budget.

`~` is expanded in configured paths before TotalReClaw opens storage.

Example:

```json
{
  "plugins": {
    "totalreclaw": {
      "enabled": true,
      "enableAutoRecall": true,
      "enableAutoCapture": true,
      "dbPath": "~/.openclaw/totalreclaw/totalreclaw.db",
      "draftPath": "~/.openclaw/totalreclaw/review",
      "sessionStatePath": "~/.openclaw/totalreclaw/state/sessions",
      "hookTimeoutMs": 800,
      "priorFixThreshold": 0.65,
      "conflictWindow": 0.1,
      "maxRecordsInjected": 3,
      "maxTokensInjected": 500,
      "summaryModel": "deterministic"
    }
  }
}
```

Default behavior:

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch |
| `enableAutoRecall` | `true` | Enables pre-prompt recall injection |
| `enableAutoCheck` | `true` | Alias of `enableAutoRecall` for older config |
| `enableAutoCapture` | `true` | Enables session accumulation from OpenClaw message-write and reset hooks |
| `dbPath` | `~/.openclaw/totalreclaw/totalreclaw.db` | Accepted records and accepted session summaries |
| `storePath` | `~/.openclaw/totalreclaw/lessons.jsonl` | Legacy one-time import path |
| `draftPath` | `~/.openclaw/totalreclaw/review` | Reviewable capture and session drafts |
| `sessionStatePath` | `~/.openclaw/totalreclaw/state/sessions` | In-flight session accumulators |
| `hookTimeoutMs` | `800` | Bounded hook runtime, clamped to `50-1500` |
| `summaryModel` | `"deterministic"` | Keeps summary generation local and predictable |
| `priorFixThreshold` | `0.65` | Confidence required for a fix-style recommendation |
| `noMatchThreshold` | `0.4` | Lower bound for useful recall |
| `conflictWindow` | `0.1` | Similar-score window that triggers conflict handling |
| `maxRecordsInjected` | `3` | Hard cap on injected matched items |
| `maxTokensInjected` | `500` | Approximate token budget for injected context |

## Storage and privacy

Accepted memory is stored locally. TotalReClaw does not require a cloud database.

Storage layout:

- SQLite database: `~/.openclaw/totalreclaw/totalreclaw.db`
- review drafts: `~/.openclaw/totalreclaw/review/`
- live session buffers: `~/.openclaw/totalreclaw/state/sessions/`
- optional legacy import file: `~/.openclaw/totalreclaw/lessons.jsonl`

Important behavior:

- captured records remain drafts until you accept them
- session summaries also land as drafts first
- sensitive material is redacted before a draft is written
- automatic recall is reference-only context, not executable instruction
- you can disable automatic capture or automatic recall independently

## Compatibility and scope

TotalReClaw currently assumes:

- Node `22.14.0+` because it uses `node:sqlite`
- OpenClaw `2026.4.24+`
- OpenClaw can load TypeScript extensions directly from `index.ts`
- OpenClaw honors plugin-declared bundled skills from `openclaw.plugin.json`

On Node builds where `node:sqlite` is still marked experimental, tests and demo execution may emit an `ExperimentalWarning`. That warning does not indicate a failing build.

This repo is aimed at operational use, not consumer chat memory. It is designed for host operations, install history, debugging context, and reusable procedures.

## Development

Install dependencies:

```bash
npm ci
```

Run the full local verification pass:

```bash
npm run verify
```

That runs:

- `tsc --noEmit`
- `vitest run`
- `npm pack --dry-run` package-asset check via `npm run pack:check`

For a deeper implementation overview, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repo layout

```text
index.ts                      OpenClaw plugin entrypoint
src/                          command handling, config, engine, store, redaction
skills/TotalReClaw/           skill definition, tool, and workflow docs
scripts/install-remote.sh     remote install helper
scripts/verify-remote.sh      remote verification helper
examples/demo-lessons.jsonl   local demo seed data
test/                         unit tests
```

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

1. Read the existing command and storage behavior before changing it.
2. Keep scope narrow. Avoid unrelated refactors.
3. Add or update tests for any command, hook, storage, or redaction behavior you touch.
4. Run `npm run verify` before opening a PR.
5. Treat README, SECURITY, and install scripts as public-facing operator docs, not internal notes.

## Security

Please use [SECURITY.md](SECURITY.md) for vulnerability reporting. Do not open public issues for security-sensitive findings.

## Code of Conduct

Contributors are expected to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Status

TotalReClaw is in active alpha release. The command surface, storage model, and remote install path are in place, with broader host validation and compatibility coverage still expanding ahead of `1.0.0`.
