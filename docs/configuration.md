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
  provider: openai          # openai | groq | gemini | ollama
  model: gpt-4o
  api_key_env: OPENAI_API_KEY
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

### Groq

```yaml
llm:
  provider: groq
  model: llama-3.1-70b-versatile
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

### Custom OpenAI-compatible endpoint

Any OpenAI-compatible API can be used by setting `base_url`:

```yaml
llm:
  provider: openai
  model: my-custom-model
  base_url: https://my-llm-gateway.example.com/v1
  api_key_env: MY_GATEWAY_KEY
```

## Severity gate

Controls whether Flaught exits with code 1 (findings exceed threshold) or 0 (clean):

| `fail_on` | Exits 1 when |
|---|---|
| `none` | Never (always exits 0) |
| `critical` | Any undismissed critical finding |
| `high` | Any undismissed high or critical finding |
| `medium` | Any undismissed medium, high, or critical finding |

Default: `high`.

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
  command: pytest   # override auto-detected test command
```

Auto-detection rules:
- JS/TS: `npm test` (if `package.json` has a `test` script)
- Python: `pytest` (if `pytest` is installed)
- Go: `go test ./...`
- Rust: `cargo test`

Test inversion creates a temporary git worktree at the base SHA, installs dependencies there, and runs the test command. The worktree is cleaned up automatically.

## Scope-creep detection

Compares each changed file/hunk against the PR description (the "intent anchor"). Heuristics flag config files, formatting-only changes, and files outside the PR's domain. LLM findings are merged in, deduped by file path.

```yaml
scope_creep:
  enabled: true
  intent_source: pr_description   # pr_description | linked_issue | both
```

Pass the PR description via `--pr-description` on the CLI. Without a PR description, only heuristic detection runs.