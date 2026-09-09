# Flaught

[![npm](https://img.shields.io/npm/v/@flaught/core)](https://www.npmjs.com/package/@flaught/core) [![CI](https://img.shields.io/github/actions/workflow/status/flaught/core/adversarial-review.yml?label=CI)](https://github.com/flaught/core/actions/workflows/adversarial-review.yml) [![license](https://img.shields.io/npm/l/@flaught/core?label=license)](https://github.com/flaught/core/blob/main/LICENSE) [![node](https://img.shields.io/node/v/@flaught/core)](https://www.npmjs.com/package/@flaught/core)

> Your PR's designated skeptic.

**The reviewer should not be the author.** A model reviewing code it wrote itself tends to agree with its own choices: same blind spots, same rationalizations. Flaught decouples the two. Point it at any LLM provider, independent of whatever wrote the code, and you get a genuinely adversarial second opinion instead of an echo.

**Flaught** runs adversarial code review in CI: structured, skeptical scrutiny that produces a timestamped JSON artifact on every PR. Named after Monsignor Flaught, the devil's advocate in *A Canticle for Leibowitz*.

Every finding is tagged **deterministic** or **LLM-asserted** so you know what came from a tool and what came from a model. An honest `_caveat` is baked into every artifact: this is evidence that scrutiny *occurred*, not that findings are *correct*.

## What it does

Flaught runs a five-stage pipeline on every PR:

```
Config → Context assembly → Deterministic tools → LLM adversarial pass → Test inversion → Scope-creep detection
                                                                                              ↓
                                                                              Noise budget → Severity gate → Exit code
```

| Stage                     | What it does                                                                    |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Context assembly**      | Diff, changed files, one-hop dependency neighborhood (blast radius)              |
| **Deterministic tools**   | Semgrep, linter, vuln scanner, plus the built-in test-weakening check: findings tagged `source_type: "deterministic"`    |
| **LLM adversarial pass**  | Structured skeptical review: security, architecture, scope-creep, test quality   |
| **Test inversion**        | Runs the changed tests against pre- and post-change code; flags tests that pass on *both* sides — i.e., tests that can't fail and therefore don't actually verify the change                 |
| **Scope-creep detection** | Heuristic plus LLM: flags hunks unrelated to the PR's stated intent              |

Output: **Markdown PR comment** plus a **versioned JSON artifact** for trend tracking.

## Install

```
npm install -g @flaught/core
```

## Quick start

A progression of prompts to paste into your AI coding agent (Claude Code, Codex, Cursor, pi). Each stage produces meaningful data before you move to the next. Run them in order on a branch with changes you want reviewed.

The discipline is the same at every stage: fix only findings that are real and mechanical, re-run to confirm, **stop after two passes**, and report whatever is still open verbatim. **Never run `flaught dismiss` from a prompt** — suppressing a false positive is a human decision.

### 1. Run it locally — deterministic checks first (no API key)

**Prompt:**

```
Install Flaught and run its deterministic review on this branch:
  npm install -g @flaught/core
  flaught init                       # scaffold .advreview.yml + .flaught-prompt/
  flaught review --base main --no-llm --output findings.json --quiet

Then read findings.json. Fix only findings that are real and mechanical
(a lint failure, a missing null check, an obvious off-by-one); leave
anything involving auth, architecture, or ambiguous intent for a human.
Re-run the same command to confirm each fix. Repeat fix-and-rerun at most
twice, then STOP and report every finding still open, verbatim.
Do not run `flaught dismiss`.
```

This runs Semgrep, your linter, the vuln scanner, test inversion, and scope-creep heuristics against your branch — zero LLM cost, no API key. You get a `findings.json` artifact and a markdown report immediately.

### 2. Add the LLM adversarial pass

**Prompt:**

```
Enable the full LLM review on this branch:
  export GROQ_API_KEY=gsk_...   # free key from https://console.groq.com/keys
  flaught review --base main --output findings.json --quiet

Read the new findings with source_type "llm" and the skeptic/refute
verdicts. Note the token-usage line in the report so you know what the
pass cost. Same discipline as stage 1: fix only mechanical, real
findings; re-run to confirm; STOP after two passes and report the rest
verbatim. Do not dismiss anything.
```

Now the full five-stage pipeline runs: deterministic tools plus a separate LLM reviewer that scrutinizes security, architecture, scope, and test quality, then a skeptic pass that independently re-derives what the change should do. Using OpenAI, Gemini, Anthropic, or Ollama instead of Groq? See [LLM providers](#llm-providers-review-with-a-different-model-than-the-one-that-wrote-the-code) below.

### 3. Review and manage findings

**Prompt:**

```
Help me triage the findings from the last review:
  - Summarize findings.json: group by severity and source_type
    (deterministic vs llm), and list the skeptic verdicts
    (confirm / refute / uncertain).
  - For each finding I decide is a false positive, run (only when I tell
    you to, and I supply the reason):
        flaught dismiss <finding-id> --artifact findings.json \
          --reason "..." --expires 90d
    (finding-id is the run-local id, e.g. D-0001)
  - Re-run: flaught review --base main --output findings.json --quiet
    to confirm the gate is clean and the dismissal persisted.
  - Run `flaught dismissals list` so I can see what's suppressed, and
    `flaught dismissals audit` to flag any that expired.
```

Dismissals persist across runs via stable fingerprints, so a suppressed false positive stays suppressed without re-triaging it every time. `flaught dismissals audit` flags expired dismissals so nothing stays hidden forever. See [Dismissals](docs/dismissals.md) for the full store.

### 4. Block merge in CI

**Prompt:**

```
Add a GitHub Actions workflow that runs Flaught on every PR and blocks
merge on real findings, without blocking on a provider outage:
  - Create .github/workflows/adversarial-review.yml using the "Full"
    workflow from docs/github-actions.md. It branches on the exit code:
    exit 1 (findings exceed the gate) fails the job; exit 2
    (config/API/LLM error) warns but does not block.
  - Add GROQ_API_KEY to the repo secrets
    (Settings → Secrets and variables → Actions).
  - Commit the workflow, push, open a PR, and show me the review job
    output and the posted PR comment.
```

Then enable branch protection: require the "Adversarial Review" status check before merge. The [GitHub Actions guide](docs/github-actions.md) has the full workflow YAML, fork-PR handling, and the exit-code split that fails open on `2`.

### 5. Track trends with the dashboard

**Prompt:**

```
Build a trends dashboard from this repo's CI review artifacts:
  - Download recent findings artifacts from GitHub Actions runs into
    ./ci-artifacts (use `gh run download` targeting the flaught-findings
    artifact from the Adversarial Review workflow).
  - Run: flaught dashboard --input ./ci-artifacts --output dashboard.html
  - Open dashboard.html and summarize what it shows: findings over time
    by severity, the per-run LLM/deterministic split, skeptic
    confirm/refute/uncertain counts, dismissals, and token usage.
```

Each CI run's `findings.json` is a snapshot; the dashboard stitches them into a self-contained HTML page so you can see whether review is getting cleaner or noisier over time. See [Trends dashboard](#trends-dashboard) below.

### Not using an agent?

```
flaught init                    # scaffold .advreview.yml + .flaught-prompt/
flaught review                  # full adversarial review vs the merge-base with main/master (falls back to HEAD~1)
flaught review --base main      # review against main
flaught review --no-llm         # deterministic tools only (no API key)
flaught review --output findings.json --quiet   # CI mode
flaught dismiss D-0002 --artifact findings.json --reason "..." # suppress a false positive, persisted across runs
flaught dismissals list         # show suppressed findings
flaught dismissals audit        # flag expired dismissals
flaught dashboard --input ./ci-artifacts --output dashboard.html
```

`--no-llm` still runs dependency sanity on newly added `package.json` packages.
That check queries the public npm registry (`registry.npmjs.org` / `api.npmjs.org`)
by default. Set `tools.dependency_sanity.enabled: false` to keep reviews fully offline.

For zero-question setup, use `flaught init --paranoid` instead of plain `init`.
It writes explicit settings for all deterministic tools, test inversion,
scope-creep detection, a high-severity gate, and persistent dismissals, with
links explaining each setting. See the [paranoid preset](docs/configuration.md#paranoid-preset)
for prerequisites and how it relates to the normal defaults.

### Customize the reviewer

```
# The simplest customization: add team-specific rules
cp .flaught-prompt/system-append.md.example .flaught-prompt/system-append.md
```

```
<!-- .flaught-prompt/system-append.md -->
## Our Rules

- Flag any use of eval() - never allowed in our codebase
- All API endpoints must validate input with a schema library
- Database queries must use parameterized statements, never string interpolation
```

You can also override the reviewer's posture, categories, severity definitions, or the entire prompt. **See [Prompt Templates](https://github.com/flaught/core/blob/main/docs/prompt-templates.md)** for the full guide.

## Exit codes

| Code | Meaning                                 |
| ---- | ---------------------------------------- |
| `0`  | Clean: no findings above severity gate  |
| `1`  | Gated: findings exceed threshold        |
| `2`  | Error: invalid input or config/API/LLM problem — a tool fault, not a code problem. Recommended CI handling: warn, don't block merge. See [exit code handling](https://github.com/flaught/core/blob/main/docs/github-actions.md#exit-code-handling). |

## Trends dashboard

Each CI run's `findings.json` artifact is a snapshot. To see trends across runs, point `flaught dashboard` at a directory of downloaded artifacts (e.g. via `gh run download`) and it renders a self-contained static HTML page — findings-over-time chart by severity, plus a per-run table (LLM/deterministic split, skeptic confirm/refute/uncertain counts, dismissals, LLM failures):

```bash
flaught dashboard --input ./ci-artifacts --output dashboard.html
```

If the input tree contains no valid findings artifacts, the command exits with
code `2` and does not create or overwrite the output file. The error names the
resolved input directory and shows the `gh run download` command used to
populate it.

## LLM providers: review with a different model than the one that wrote the code

Self-review is the weak spot in AI-assisted development. The model that wrote your PR is primed to defend it. Flaught breaks that correlation. Swap reviewers with zero code changes, just update `.advreview.yml`:

| Provider               | Config                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------|
| **Groq** (default)     | `provider: groq`, `model: groq/compound-mini`                                                            |
| **OpenAI**              | `provider: openai`, `model: gpt-4o`                                                                      |
| **Gemini**              | `provider: gemini`, `model: gemini-1.5-pro`                                                              |
| **Anthropic (Claude)**  | `provider: anthropic`, `model: claude-sonnet-5`                                                          |
| **Ollama** (local)      | `provider: ollama`, `model: codellama`                                                                   |
| **Ollama Cloud**        | `provider: ollama`, `model: glm-5.2:cloud`, `base_url: https://ollama.com`, `api_key_env: OLLAMA_API_KEY`|

**A sane pairing:** coding with Claude, review with GPT-4o or Groq. Coding with Copilot or GPT, review with Claude. Coding with anything, review with a different anything.

Any OpenAI-compatible endpoint works via `base_url`. Anthropic has its own native adapter, since its Messages API isn't OpenAI-compatible. `model` and `base_url` are both free-form, so any current or future Claude model, or any Messages-API-compatible proxy, works without a code change. Ollama Cloud reuses the same local adapter (same `/api/chat` shape) with an added `Authorization: Bearer` header: no GPU, no container, just a hosted API call.

## Documentation

- **[Architecture](https://github.com/flaught/core/blob/main/docs/architecture.md)**: the review pipeline, component map, and single-run sequence (mermaid + ASCII)
- **[Configuration](https://github.com/flaught/core/blob/main/docs/configuration.md)**: full `.advreview.yml` reference, LLM providers, noise budget, severity gate, tools, test inversion, scope-creep
- **[Prompt Templates](https://github.com/flaught/core/blob/main/docs/prompt-templates.md)**: override or extend the LLM reviewer's posture, categories, rules, and context via `.flaught-prompt/`
- **[Trends dashboard](https://github.com/flaught/core/blob/main/docs/dashboard.md)**: download historical findings artifacts and render a self-contained HTML trends report
- **[Findings schema](https://github.com/flaught/core/blob/main/docs/findings-schema.md)**: artifact structure, field definitions, severity levels, categories, dismissal, blast radius
- **[Dismissals](https://github.com/flaught/core/blob/main/docs/dismissals.md)**: persisting false-positive suppressions across runs via stable fingerprints, `flaught dismiss`/`dismissals` CLI
- **[Roadmap](https://github.com/flaught/core/blob/main/docs/roadmap.md)**: the curated public roadmap, by theme
- **[GitHub Actions](https://github.com/flaught/core/blob/main/docs/github-actions.md)**: three ready-to-use workflows (minimal, full, Ollama) plus exit code handling
- **[Programmatic API](https://github.com/flaught/core/blob/main/docs/api.md)**: use Flaught as a library in Node.js
- **[Troubleshooting](https://github.com/flaught/core/blob/main/docs/troubleshooting.md)**: every error message, what it means, how to fix it
- **[Git hygiene](https://github.com/flaught/core/blob/main/docs/git-hygiene.md)**: non-negotiable branch/commit/PR discipline (applies to the maintainer too)
- **[Website](https://flaught.github.io)**: the Flaught project site

## Honest caveat

The JSON artifact is evidence that *scrutiny occurred*, not evidence that findings are *correct*. LLM-asserted findings may include hallucinations. Deterministic-tool findings have their own false-positive rates. Treat this as a prompt for human review, not audit-truth.

On a large PR the LLM prompt may be truncated to fit a size cap; every artifact carries an `analysis_completeness` field recording what the LLM actually saw (`full` vs `partial`, and what was dropped) — so "Flaught completed" is never mistaken for "Flaught comprehensively reviewed this." See the [findings schema](docs/findings-schema.md#analysis-completeness).

## Acknowledgments

Flaught's design draws on observed practice in adversarial code review and
agent-assisted testing. In particular, the **test-inversion** stage, the
**test-quality scrutiny** guidance in the default review prompt, and the
**skeptic re-derivation** instruction are grounded in [Dan Luu's research on how
well agents use test and verification techniques](https://danluu.com/agentic-testing/).

That work documents that agents routinely write tests that *cannot fail* —
symmetric/palindromic inputs that can't distinguish a bug from its fix,
assertions that bake in the implementation's current (buggy) output as
"correct," and tests that exercise only the happy/no-panic path. Test
inversion catches the structural version of this failure (a test that passes
identically before and after a change is not testing the change); the default
review prompt now directs the reviewer to look for the semantic version. The
skeptic/refute pass is similarly instructed to independently re-derive what
the code *should* do from the PR's stated intent, rather than only checking
whether a finding's claim is visible in the code — reflecting the finding that
an independent, fresh-context re-derivation beats re-stating the original
reasoning.

## License

MIT
