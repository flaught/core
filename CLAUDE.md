# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc)
npm test             # Full test suite (251 tests, ~20s)
npm run test:unit   # Unit tests only (220 tests, ~3s) — what pre-commit runs
npm run dev          # Watch mode for development
npm run review       # Run Flaught against local changes
```

Pre-commit hook runs `npm run test:unit` (skips integration tests that create temp git repos).
CI runs the full suite + Flaught review (builds from source).

## Architecture Overview

Flaught is an adversarial PR/code review tool with a deterministic-first pipeline:

```
Config → Context Assembly → Deterministic Tools (semgrep/linter/npm audit)
  → LLM Adversarial Review → Refute/Skeptic Pass
  → Test Inversion → Scope-Creep Detection → Noise Budget → Severity Gate
```

Key modules:
- `src/llm/` — LLM provider abstraction (OpenAI-compatible, Anthropic, Groq, Gemini, Ollama)
- `src/refute/` — Skeptic pass that tries to refute LLM findings (confirmed/refuted/uncertain)
- `src/tools/` — Deterministic tool runner (semgrep, linter, vuln scanner)
- `src/test-inversion/` — Runs tests on pre-change code to detect missing coverage
- `src/scope-creep/` — Flags PR changes outside stated intent
- `src/report/` — Markdown and JSON report renderers
- `src/dismissals/` — Persistent finding dismissals with fingerprinting
- `src/schemas/` — Zod schemas for config, findings, dismissals
- `src/review.ts` — Main orchestrator that wires the pipeline together
- `src/cli.ts` — Commander CLI entry point

Key config files:
- `.advreview.yml` — Project config (model, tools, noise budget, severity gate)
- `.flaught-dismissals.json` — Persisted dismissals with reasons and expiry
- `.flaught-prompt/` — User prompt overrides (system.md, userAppend.md)

The default LLM is `openai/gpt-oss-20b` on Groq. The refute pass uses the same
provider by default but supports a separate provider/model for anti-correlation.

## Conventions & Patterns

- **Adversarial stance**: Flaught's job is to find problems, not confirm solutions. LLM findings are marked `source_type: "llm"` to distinguish from deterministic findings.
- **Honest caveat**: Every report includes `_caveat` warning that findings may be hallucinations.
- **Deterministic-first**: Semgrep/linter/vuln-scanner run BEFORE the LLM, grounding the review in facts.
- **Test inversion**: Running tests on pre-change code detects tests that pass on both sides (insufficient coverage).
- **Refute pass**: Every LLM finding goes through a skeptic that tries to knock it down. Deterministic and test-inversion findings are exempt.
- **Dismissals**: Finding fingerprints survive rephrasing. Dismissals persist in `.flaught-dismissals.json` with who/when/why.
- **TypeScript strict**: `strict: true`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`.
- **Zod schemas**: All config and artifact shapes are validated with Zod. If adding a new config field, add it to `src/schemas/config.ts` with a default.
- **Integration tests**: Tests that create temp git repos (`review.test.ts`, `test-inversion/runner.test.ts`) are excluded from pre-commit hooks but run in CI.
- **Model volatility**: Groq's model catalog changes frequently. Always validate model availability. Default is `openai/gpt-oss-20b` (confirmed available).
