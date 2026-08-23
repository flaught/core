# Contributing to Flaught

Flaught is adversarial code review that runs in CI on its own PRs. That sentence is also the contribution model: anything you send in will be read by a skeptic that is not you. The notes below tell you how to set up, what the gates are, and what we expect in a change before it lands.

## Setting up

You need Node 18 or newer (the `engines` field in `package.json` is the source of truth) and git.

```bash
git clone https://github.com/flaught/core.git
cd core
npm ci            # install dependencies
npm run build     # compile TypeScript → dist/
```

Sanity check that everything is green before you start:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src/
npm test            # vitest run (full suite, ~20–30s; some tests use a git worktree)
```

If you only changed non-review code and want a faster loop, the unit subset skips the slow integration tests:

```bash
npm run test:unit
```

## The review loop

Run Flaught locally before pushing, the same way CI will:

```bash
npm run build
npm link
flaught review --base main          # full review vs the merge-base with main
flaught review --no-llm             # deterministic tools only, no API key needed
```

For the LLM pass you need a provider key. The repo's default is Groq (`GROQ_API_KEY`); see the [configuration docs](docs/configuration.md#llm-providers) to point at another provider. `--no-llm` is enough to catch most deterministic findings without any key.

If Flaught flags something you believe is a false positive, dismiss it with a reason rather than editing it away — the dismissal is fingerprinted and persists across runs:

```bash
flaught dismiss D-0002 --artifact findings.json --reason "semgrep rule X does not apply to this context"
```

See the [Dismissals docs](docs/dismissals.md) for how fingerprints stay stable.

## Sending a PR

1. Branch off `main`. Keep one logical change per branch.
2. Write commits in [Conventional Commits](https://www.conventionalcommits.org/) form: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`, `ci:`, `prompt:`. The history feeds the changelog, so the type and summary matter.
3. Open the PR against `main`.
4. CI runs the **Adversarial Review** workflow on your PR. Flaught builds from your branch source (so changes to its own review logic are reflected in its own run), posts a comment, and uploads a `findings.json` artifact.
5. Exit code `1` (findings exceed the severity gate) blocks merge. Exit code `2` (config/API/LLM fault) does **not** block merge — a tool outage is not evidence of a code problem. See the [exit codes](README.md#exit-codes) table.

You don't have to get to zero findings to merge, but each non-dismissed finding above the gate needs to be either fixed or dismissed with a real reason. "I disagree" is not a reason.

## Commit conventions

- Conventional Commits, lowercase type, imperative summary: `fix: guard renderMarkdownReport against a missing tools_executed field`.
- Scope is optional but useful: `feat(test-inversion): skip for docs-only diffs`.
- Breaking changes go under a `BREAKING CHANGE:` footer or a `!` after the type.
- Keep the summary under ~72 characters; put detail in the body, wrapped.

## What lands

A change is ready when it builds, passes the test suite and linter, and either passes the review gate or has its findings honestly dismissed. We are not trying to defeat the reviewer; we are trying to make the change survive a skeptical reading it did not write. That is the whole point of the project.