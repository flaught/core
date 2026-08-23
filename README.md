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
| **Deterministic tools**   | Semgrep, linter, vuln scanner: findings tagged `source_type: "deterministic"`    |
| **LLM adversarial pass**  | Structured skeptical review: security, architecture, scope-creep, test quality   |
| **Test inversion**        | Runs tests on pre-change code; flags tests passing on both sides                 |
| **Scope-creep detection** | Heuristic plus LLM: flags hunks unrelated to the PR's stated intent              |

Output: **Markdown PR comment** plus a **versioned JSON artifact** for trend tracking.

## Install

```
npm install -g @flaught/core
```

## Quick start

Pick your environment and paste:

### Any AI coding agent (Claude Code, Codex, Cursor, pi, etc.)

**Prompt:**

```
Install and run Flaught (adversarial code review) on this project:
npm install -g @flaught/core, then `flaught init` to scaffold config,
then `flaught review --no-llm` to run deterministic checks — no API
key needed. Fix anything it flags and re-run until clean.

For the full LLM adversarial pass, set an API key (GROQ_API_KEY by
default; for another provider, also set llm.provider/api_key_env in
.advreview.yml) and drop --no-llm.
```

### Manual

```
flaught init                    # scaffold .advreview.yml + .flaught-prompt/
flaught review                  # full adversarial review vs the merge-base with main/master (falls back to HEAD~1)
flaught review --base main      # review against main
flaught review --no-llm         # deterministic tools only (no API key)
flaught review --output findings.json --quiet   # CI mode
flaught dismiss D-0002 --artifact findings.json --reason "..." # suppress a false positive, persisted across runs
```

### API key

`flaught init` defaults to Groq. Generate a free key at [console.groq.com/keys](https://console.groq.com/keys), then:

```bash
export GROQ_API_KEY=gsk_...
flaught review
```

Using OpenAI, Gemini, Anthropic (Claude), or Ollama instead? See [LLM providers](https://github.com/flaught/core/blob/main/docs/configuration.md#llm-providers) for the full config reference.

### GitHub Actions

Add `.github/workflows/adversarial-review.yml`. See the [GitHub Actions docs](https://github.com/flaught/core/blob/main/docs/github-actions.md) for the full workflow, or start with the minimal version.

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
| `2`  | Error: config/API/LLM problem — a tool fault, not a code problem. Recommended CI handling: warn, don't block merge. See [exit code handling](https://github.com/flaught/core/blob/main/docs/github-actions.md#exit-code-handling). |

## Trends dashboard

Each CI run's `findings.json` artifact is a snapshot. To see trends across runs, point `flaught dashboard` at a directory of downloaded artifacts (e.g. via `gh run download`) and it renders a self-contained static HTML page — findings-over-time chart by severity, plus a per-run table (LLM/deterministic split, skeptic confirm/refute/uncertain counts, dismissals, LLM failures):

```bash
flaught dashboard --input ./ci-artifacts --output dashboard.html
```

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

- **[Configuration](https://github.com/flaught/core/blob/main/docs/configuration.md)**: full `.advreview.yml` reference, LLM providers, noise budget, severity gate, tools, test inversion, scope-creep
- **[Prompt Templates](https://github.com/flaught/core/blob/main/docs/prompt-templates.md)**: override or extend the LLM reviewer's posture, categories, rules, and context via `.flaught-prompt/`
- **[Findings schema](https://github.com/flaught/core/blob/main/docs/findings-schema.md)**: artifact structure, field definitions, severity levels, categories, dismissal, blast radius
- **[Dismissals](https://github.com/flaught/core/blob/main/docs/dismissals.md)**: persisting false-positive suppressions across runs via stable fingerprints, `flaught dismiss`/`dismissals` CLI
- **[GitHub Actions](https://github.com/flaught/core/blob/main/docs/github-actions.md)**: three ready-to-use workflows (minimal, full, Ollama) plus exit code handling
- **[Programmatic API](https://github.com/flaught/core/blob/main/docs/api.md)**: use Flaught as a library in Node.js
- **[Troubleshooting](https://github.com/flaught/core/blob/main/docs/troubleshooting.md)**: every error message, what it means, how to fix it

## Honest caveat

The JSON artifact is evidence that *scrutiny occurred*, not evidence that findings are *correct*. LLM-asserted findings may include hallucinations. Deterministic-tool findings have their own false-positive rates. Treat this as a prompt for human review, not audit-truth.

## License

MIT
