# Configuration

Flaught is configured via `.advreview.yml` in your repo root. Run `flaught init` to generate one with commented defaults.

Everything has sensible defaults — a repo can run with zero config. Override only what you need.

## Full reference

```yaml
version: 1

# ── Stack declaration ──────────────────────────────────────
# Omit to auto-detect from repo contents (package.json, requirements.txt, etc.)
# stack:
#   languages: [python, typescript]   # or "auto"
#   frameworks: [fastapi, react]
#   runtime: node                      # node | python | mixed | auto

# ── LLM provider ───────────────────────────────────────────
llm:
  provider: groq             # openai | groq | gemini | anthropic | ollama
  model: groq/compound-mini
  api_key_env: GROQ_API_KEY
  # base_url: null          # override for OpenAI-compatible endpoints
  temperature: 0.2           # 0.0–1.0 (lower = more deterministic)
  max_tokens: 4096           # max response length
  timeout_seconds: 120       # timeout for LLM API calls

# ── Deterministic tools ────────────────────────────────────
# tools:
#   semgrep:
#     enabled: true
#     config: path/to/semgrep-rules.yml    # optional custom rules
#   linter:
#     enabled: true
#     command: eslint                        # override auto-detected linter
#   vuln_scanner:
#     enabled: true
#     command: npm audit                     # override auto-detected scanner

# ── Test inversion ─────────────────────────────────────────
# test_inversion:
#   enabled: true
#   command: pytest                          # override auto-detected test command

# ── Scope-creep detection ─────────────────────────────────
# scope_creep:
#   enabled: true
#   intent_source: pr_description            # pr_description | linked_issue | both

# ── Lighthouse (optional, degrades cleanly) ────────────────
# lighthouse:
#   enabled: false
#   preview_url: https://deploy-preview-42.example.com

# ── Noise budget ───────────────────────────────────────────
# noise_budget:
#   critical: 5
#   high: 10
#   medium: 15
#   low: 20
#   info: 25

# ── Severity gate ──────────────────────────────────────────
# severity_gate:
#   fail_on: high     # none | critical | high | medium

# ── Dismissals ─────────────────────────────────────────────
# See docs/dismissals.md for the full workflow (`flaught dismiss`, etc).
# dismissals:
#   enabled: true
#   path: .flaught-dismissals.json

# ── Exclusions ─────────────────────────────────────────────
# exclude:
#   paths:
#     - "node_modules/**"
#     - "vendor/**"
#     - "**/*.min.js"
#     - "**/*.min.css"
#     - "**/*.generated.*"
#   patterns: []
```

## LLM providers

Switch providers with zero code changes — just update `.advreview.yml`.

### OpenAI

```yaml
llm:
  provider: openai
  model: gpt-4o
  api_key_env: OPENAI_API_KEY
```

```bash
export OPENAI_API_KEY=sk-...
flaught review
```

### Groq (default)

```yaml
llm:
  provider: groq
  model: groq/compound-mini
  api_key_env: GROQ_API_KEY
```

```bash
export GROQ_API_KEY=gsk_...
flaught review
```

### Google Gemini

```yaml
llm:
  provider: gemini
  model: gemini-1.5-pro
  api_key_env: GEMINI_API_KEY
```

```bash
export GEMINI_API_KEY=...
flaught review
```

### Anthropic (Claude)

Native support — this is **not** routed through the OpenAI-compatible adapter. Anthropic's Messages API has a genuinely different wire shape (system prompt as a top-level field, `x-api-key`/`anthropic-version` headers instead of `Authorization: Bearer`, `usage.input_tokens`/`output_tokens` instead of `prompt_tokens`/`completion_tokens`), so it has its own adapter (`AnthropicProvider`).

```yaml
llm:
  provider: anthropic
  model: claude-sonnet-5          # any current or future Claude model id — not hardcoded
  api_key_env: ANTHROPIC_API_KEY
  # base_url: https://api.anthropic.com/v1   # default; override to point at a proxy/gateway
```

```bash
export ANTHROPIC_API_KEY=sk-ant-...
flaught review
```

`model` is a free-form string — `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, or any future/renamed Claude model, with no code change required. `base_url` is also overridable, so the same adapter reaches a corporate proxy or self-hosted gateway that speaks the Messages API, not just `api.anthropic.com` directly.

### Ollama (local models)

```yaml
llm:
  provider: ollama
  model: codellama
  # base_url: http://localhost:11434   # default
```

```bash
ollama serve   # start the Ollama server
flaught review
```

### Ollama Cloud

Same `ollama` provider, same `/api/chat` request shape — Ollama Cloud (`:cloud`-tagged models, e.g. `glm-5.2:cloud`) just points `base_url` at `https://ollama.com` and adds an `Authorization: Bearer` header via `api_key_env`. No local server, no GPU, no model download — it's a plain hosted API call, same as any other provider.

```yaml
llm:
  provider: ollama
  model: glm-5.2:cloud
  base_url: https://ollama.com
  api_key_env: OLLAMA_API_KEY
```

```bash
export OLLAMA_API_KEY=...   # generate at ollama.com/settings/keys
flaught review
```

`api_key_env` must be set explicitly to enable this — a bare `provider: ollama` with no `api_key_env` never sends an `Authorization` header, even if `GROQ_API_KEY` (the config schema's default) or `OPENAI_API_KEY` happens to be set in your shell. This is deliberate: it stops an ambient key meant for a different provider from silently leaking to whatever `base_url` your Ollama config points at.

### Custom OpenAI-compatible endpoint

Any OpenAI-compatible API can be used by setting `base_url`:

```yaml
llm:
  provider: openai
  model: my-custom-model
  base_url: https://my-llm-gateway.example.com/v1
  api_key_env: MY_GATEWAY_KEY
```

This only works for gateways that speak the OpenAI `/chat/completions` shape. A gateway that speaks Anthropic's Messages API instead — including most enterprise Claude proxies — needs `provider: anthropic` with `base_url` overridden (see above), not `provider: openai`.

## Refute pass (skeptic)

Every LLM finding goes through a second pass where a skeptic model tries to refute it — see [Conventions & Patterns](../CLAUDE.md#conventions--patterns) in the repo root for the design rationale. By default the skeptic runs on the same provider/model as the main review, which means the model that wrote the findings is also grading them. Configure `refute.provider` and/or `refute.model` to break that correlation:

```yaml
refute:
  enabled: true        # default: true
  provider: null        # default: null — inherits llm.provider if unset
  model: null            # default: null — inherits llm.model if unset
  api_key_env: null      # default: null — inherits llm.api_key_env if unset
  base_url: null         # default: null — inherits llm.base_url if unset
  temperature: 0.3       # default: 0.3 — slightly higher than review, encourages creative doubt
  max_tokens: 2048       # default: 2048
  max_batch_size: 20     # default: 20 — findings per skeptic call
```

`provider` and `model` are independent overrides — set one without the other. Two anti-correlation patterns:

**Same-provider, different model** — set only `refute.model`. Cheaper and simpler than a second provider, and often enough: a larger or differently-tuned model on the same API is a genuinely different reviewer, not a rubber stamp.

```yaml
llm:
  provider: groq
  model: openai/gpt-oss-20b
refute:
  model: openai/gpt-oss-120b   # different Groq model reviews the 20b's findings
```

**Cross-provider** — set both `refute.provider` and `refute.model` (plus `refute.api_key_env`/`refute.base_url` if the second provider needs different credentials or an endpoint):

```yaml
llm:
  provider: groq
  model: openai/gpt-oss-20b
refute:
  provider: anthropic
  model: claude-sonnet-5
  api_key_env: ANTHROPIC_API_KEY
```

Set `refute.enabled: false` to skip the skeptic pass entirely (LLM findings are reported with `refute_result: null`), or pass `--no-refute` on the CLI for a one-off run.

## Severity gate

Controls whether Flaught exits with code 1 (findings exceed threshold) or 0 (clean):

| `fail_on` | Exits 1 when |
|---|---|
| `none` | Never (always exits 0) |
| `critical` | Any undismissed critical finding |
| `high` | Any undismissed high or critical finding |
| `medium` | Any undismissed medium, high, or critical finding |

Default: `high`. Dismissed findings (see below) are always excluded, regardless of severity.

## Dismissals

Findings are matched against a persisted, git-tracked dismissal store (`.flaught-dismissals.json` by default) by a stable content-based fingerprint — not the run-local `id`. A finding whose fingerprint has an active (non-expired) entry in the store is automatically marked `dismissed` on every run and excluded from the severity gate.

```yaml
dismissals:
  enabled: true                     # default
  path: .flaught-dismissals.json    # default, relative to repo root
```

See [`docs/dismissals.md`](dismissals.md) for the full workflow, the `flaught dismiss`/`dismissals` CLI, and the fingerprint/store format.

## Noise budget

Each severity tier has a maximum number of findings. When a tier's budget is exceeded, the lowest-confidence findings in that tier are dropped. This prevents alert fatigue:

```yaml
noise_budget:
  critical: 5     # max 5 critical findings
  high: 10        # max 10 high findings
  medium: 15      # max 15 medium findings
  low: 20         # max 20 low findings
  info: 25        # max 25 info findings
```

Default values are shown above. Findings are sorted by severity (critical first), then by confidence (highest first) within each tier.

## Deterministic tools

Flaught auto-detects which tools to run based on your repo contents:

| Tool | Auto-detect | Config override |
|---|---|---|
| **Semgrep** | Always tries; skips gracefully if not installed | `tools.semgrep.enabled`, `tools.semgrep.config` |
| **Linter** | `eslint` (JS/TS), `ruff`/`flake8` (Python), `go vet` (Go) | `tools.linter.enabled`, `tools.linter.command` |
| **Vuln scanner** | `npm audit` (JS), `pip-audit` (Python), `govulncheck` (Go) | `tools.vuln_scanner.enabled`, `tools.vuln_scanner.command` |

All tools degrade gracefully — if a tool isn't installed, Flaught skips it and continues. Findings from deterministic tools are tagged `source_type: "deterministic"` with confidence 1.0.

## Test inversion

Test inversion runs your test suite on both the pre-change (base) and post-change (head) code. Tests that pass on **both** sides are flagged — they don't actually test the change.

```yaml
test_inversion:
  enabled: true
  command: pytest                # override auto-detected test command
  scope_to_blast_radius: true    # only flag tests in the diff's changed/blast-radius files
  skip_docs_only_diffs: true     # skip entirely when every changed file is documentation
```

Auto-detection rules:
- JS/TS: `npm test` (if `package.json` has a `test` script)
- Python: `pytest` (if `pytest` is installed)
- Go: `go test ./...`
- Rust: `cargo test`

Test inversion creates a temporary git worktree at the base SHA, installs dependencies there, and runs the test command. The worktree is cleaned up automatically.

**`scope_to_blast_radius`** (default `true`): the whole test suite still runs on both sides — that's how the comparison works — but only a test whose file is a changed file, or in the changed files' one-hop dependency blast radius (the same graph used for LLM context), is reported as a finding. Without this, every test file the diff didn't happen to touch "passes on both base and head" trivially, because nothing about what it tests changed — which is nearly the entire suite on a small PR. Worse, a different PR touches a different subset of files, so the flagged set is different every time and never converges under [dismissal](dismissals.md): each PR produces a disjoint batch of "new" test-quality findings with fresh fingerprints, forever.

This is best-effort: the file a test belongs to is extracted from the test runner's own output, which some formats (Go, Rust) don't include — and even a well-supported format can lose the file for an individual test when a slow test file gets expanded into per-test lines by the reporter instead of one per-file summary line. When a test's file can't be determined, it's kept unscoped rather than silently dropped — a false positive you re-triage is safer than a real issue that quietly disappears. Set `scope_to_blast_radius: false` to go back to flagging every test in the suite.

**`skip_docs_only_diffs`** (default `true`): when every changed file is documentation (markdown/text, or a common extensionless doc file like `README`/`LICENSE`/`CHANGELOG`), test inversion doesn't run at all. No test can meaningfully "verify" a prose change, so running the whole suite twice just to flag some of it as suspicious is pure noise — and it sidesteps `scope_to_blast_radius`'s per-test-line gap above entirely, rather than relying on scoping to filter the result after the fact. Set to `false` to always run test inversion regardless of what changed.

## Scope-creep detection

Compares each changed file/hunk against the PR description (the "intent anchor"). Heuristics flag config files, formatting-only changes, and files outside the PR's domain. LLM findings are merged in, deduped by file path.

```yaml
scope_creep:
  enabled: true
  intent_source: pr_description   # pr_description | linked_issue | both
  exclude_paths: []                # e.g. ["docs/adr/**"] — never scored as scope creep
```

Pass the PR description via `--pr-description` on the CLI. Without a PR description, only heuristic detection runs.

`exclude_paths` is for paths that are *structurally* expected to ride along with certain changes — most commonly an ADR or design doc that accompanies the change it documents, which would otherwise get flagged every time as "large documentation diff unrelated to the code change." It's enforced twice: as explicit guidance in the LLM prompt, and as a post-hoc filter on the LLM's findings (so it holds even if the LLM ignores the guidance). Same `*`/`**` glob syntax as `exclude.paths`.

This is a proactive alternative to [dismissing](dismissals.md) the same scope-creep theme over and over — dismissal-by-fingerprint only matches a finding whose title is worded identically to a prior one, so an LLM that phrases "large ADR diff" differently on every run will keep re-triggering the gate even after you've dismissed it once. If a path pattern is *always* fine to change alongside anything else, exclude it here instead of dismissing it repeatedly.

## Prompt templates

The LLM prompt — the posture, categories, severity definitions, output format — is the highest-leverage surface in Flaught. The `.flaught-prompt/` directory lets you override or extend any part of it without forking the code.

```bash
flaught init    # creates .advreview.yml AND .flaught-prompt/ with example files
```

The most common customization is `system-append.md` — adding team-specific rules without rewriting the prompt:

```markdown
<!-- .flaught-prompt/system-append.md -->
## Acme Corp Rules

- Flag any use of eval() or Function() — these are never allowed
- All API endpoints must validate input with a schema library (zod, joi, etc.)
- Database queries must use parameterized statements, never string interpolation
- Changes to authentication code must include integration tests
```

### Override vs. append

| File | Mode | What it does |
|---|---|---|
| `system.md` | Override | Replaces the **entire** system prompt (supersedes all other files) |
| `posture.md` | Override | Replaces just the posture/persona section |
| `categories.md` | Override | Replaces the category definitions |
| `severity.md` | Override | Replaces the severity definitions |
| `output-format.md` | Override | Replaces the JSON output format spec |
| `constraints.md` | Override | Replaces the IMPORTANT constraints |
| `system-append.md` | Append | Appended to the system prompt (most common!) |
| `user-append.md` | Append | Appended to the user prompt |

### Template variables

All files support `{{variable}}` interpolation:

| Variable | Produces |
|---|---|
| `{{noise_budget}}` | Formatted noise budget from config (e.g. `"  - critical: max 5 findings\n  - high: max 10 findings"`) |
| `{{categories}}` | Default category definitions (for reference when overriding) |
| `{{severities}}` | Default severity definitions (for reference when overriding) |

### Config

```yaml
prompt:
  enabled: true           # set to false to ignore .flaught-prompt/ entirely
  path: .flaught-prompt   # relative to repo root, or absolute
```

### How it works

1. If `system.md` is present, it **replaces the entire** system prompt (other section overrides are ignored)
2. Otherwise, individual section overrides (`posture.md`, `categories.md`, etc.) replace only their respective sections
3. `system-append.md` is **always** appended, regardless of mode
4. `user-append.md` is **always** appended to the user prompt
5. The noise budget is **always** present — if a full `system.md` override doesn't include it, it's auto-injected

**See [docs/prompt-templates.md](prompt-templates.md) for the complete guide**, including common customizations (security-focused posture, domain-specific categories, project context), full override examples, and the built-in default text.