# Flaught

> Adversarial governance tooling for AI-assisted development.

**Flaught** produces a structured, timestamped record that independent adversarial scrutiny occurred on every PR — what was checked, what was flagged, what was dismissed and by whom. Named after Monsignor Flaught, the *advocatus diaboli* (devil's advocate) in *A Canticle for Leibowitz*.

⚠️ **Honest caveat:** The JSON output is evidence that *scrutiny occurred*, not evidence that findings are *correct*. LLM-asserted findings may include hallucinations. Deterministic-tool findings have their own false-positive rates. Treat this as a prompt for human review, not audit-truth.

---

## Install

```bash
npm install -g @flaught/core
```

Or use without installing:

```bash
npx @flaught/core review --base main
```

## Quick start

```bash
# Initialize config (creates .advreview.yml with defaults)
flaught init

# Run full adversarial review on current branch vs main
flaught review

# Review a specific diff
flaught review --base main --head feature-branch

# Skip LLM, run deterministic tools only
flaught review --no-llm

# Write JSON artifact to file
flaught review --output findings.json

# Suppress progress output (for CI)
flaught review --quiet --output findings.json
```

## How it works

Flaught runs a five-stage pipeline against any PR or branch diff:

| Stage | What it does |
|---|---|
| **1. Context assembly** | Extracts the diff, identifies changed files, builds a one-hop dependency neighborhood (blast radius), reads file contents |
| **2. Deterministic tools** | Runs Semgrep, linters, and vulnerability scanners. Findings are tagged `source_type: "deterministic"` and injected as grounding context for the LLM |
| **3. LLM adversarial pass** | Structured skeptical review — architecture, security, scope-creep, test quality, performance, maintainability. Findings tagged `source_type: "llm"` |
| **4. Test inversion** | Runs the test suite on both base (pre-change) and head (post-change). Tests passing on both sides are flagged as not verifying the change — cheap mutation testing |
| **5. Scope-creep detection** | Heuristic pre-filter (config files, formatting-only changes) + LLM scope-creep findings merged. PR description serves as the intent anchor |

Output is a **Markdown PR comment** + a **versioned, self-describing JSON artifact** for trend tracking.

## Pipeline flow

```
┌──────────────────┐
│  Config + CLI    │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  1. Context       │  diff, changed files, dependency neighborhood
│     assembly      │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  2. Deterministic │  semgrep → linter → vuln scanner
│     tools         │  (all optional, degrade gracefully)
└────────┬─────────┘
         │
┌────────▼─────────┐
│  3. LLM adversarial│  grounded by deterministic findings
│     pass          │  + scope-creep heuristic context
└────────┬─────────┘
         │
┌────────▼─────────┐
│  4. Test          │  git worktree at base SHA → run tests
│     inversion     │  flag tests passing on both sides
└────────┬─────────┘
         │
┌────────▼─────────┐
│  5. Scope-creep   │  heuristic + LLM findings merged
│     detection     │  PR description = intent anchor
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Noise budget     │  cap findings per severity tier
│  + severity gate  │  exit 1 if threshold breached
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Output           │  Markdown report (stdout)
│                   │  JSON artifact (--output)
│                   │  Exit code (0=clean, 1=gated, 2=error)
└──────────────────┘
```

## CLI reference

```
Usage: flaught [options] [command]

Options:
  -V, --version     output the version number
  -h, --help        display help for command

Commands:
  init              Scaffold .advreview.yml with commented defaults
  review            Run adversarial review on a diff

Review options:
  -r, --repo <path>            Path to git repo (default: cwd)
  -b, --base <ref>             Base ref (branch, tag, or SHA)
  -h, --head <ref>             Head ref (default: HEAD)
  -c, --config <path>          Path to .advreview.yml
  --json                       Output full context as JSON (debugging)
  --output <path>              Write JSON artifact to file
  --no-llm                     Skip LLM review (deterministic only)
  --pr-description <text>      PR description for scope-creep detection
  --quiet                      Suppress progress output
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean — no findings at or above the severity gate |
| `1` | Gated — undismissed findings at or above the severity gate threshold |
| `2` | Error — config problem, missing API key, LLM failure |

## Configuration

Create `.advreview.yml` in your repo root, or run `flaught init` to generate one with commented defaults.

### Full configuration reference

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

### LLM providers

Flaught supports four providers. Switch with zero code changes — just update `.advreview.yml`:

#### OpenAI

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

#### Groq

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

#### Google Gemini

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

#### Ollama (local models)

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

Any OpenAI-compatible endpoint can be used by setting `base_url`:

```yaml
llm:
  provider: openai
  model: my-custom-model
  base_url: https://my-llm-gateway.example.com/v1
  api_key_env: MY_GATEWAY_KEY
```

### Severity gate

The severity gate controls whether Flaught exits with code 1 (findings exceed threshold) or 0 (clean):

| `fail_on` | Exits 1 when |
|---|---|
| `none` | Never (always exits 0) |
| `critical` | Any undismissed critical finding |
| `high` | Any undismissed high or critical finding |
| `medium` | Any undismissed medium, high, or critical finding |

### Noise budget

Each severity tier has a maximum number of findings. Lower-severity findings are dropped first when the budget is exceeded. This prevents alert fatigue:

```yaml
noise_budget:
  critical: 5     # max 5 critical findings
  high: 10        # max 10 high findings
  medium: 15      # max 15 medium findings
  low: 20         # max 20 low findings
  info: 25        # max 25 info findings
```

### Deterministic tools

Flaught auto-detects which tools to run based on your repo contents:

| Tool | Auto-detect | Config override |
|---|---|---|
| **Semgrep** | Always tries; skips gracefully if not installed | `tools.semgrep.enabled`, `tools.semgrep.config` |
| **Linter** | `eslint` (JS/TS), `ruff`/`flake8` (Python), `go vet` (Go) | `tools.linter.enabled`, `tools.linter.command` |
| **Vuln scanner** | `npm audit` (JS), `pip-audit` (Python), `govulncheck` (Go) | `tools.vuln_scanner.enabled`, `tools.vuln_scanner.command` |

All tools degrade gracefully — if a tool isn't installed, Flaught skips it and continues.

## Findings schema

Every finding carries a `source_type` field that distinguishes **deterministic** (tool-asserted) from **LLM-asserted** evidence. This is the governance-critical field.

### Finding structure

```json
{
  "id": "D-0001",
  "severity": "high",
  "category": "security",
  "title": "SQL injection vulnerability",
  "description": "semgrep found: SQL injection vulnerability (sql-injection)",
  "evidence": {
    "file": "src/db/queries.ts",
    "line_start": 42,
    "line_end": 42,
    "snippet": "const result = db.query(`SELECT * FROM users WHERE id = ${userId}`)",
    "blast_radius": ["src/api/users.ts:15", "src/middleware/auth.ts:8"]
  },
  "source": "semgrep",
  "source_type": "deterministic",
  "confidence": 1.0,
  "references": ["https://semgrep.dev/r/sql-injection"],
  "dismissed": false,
  "dismissed_by": null,
  "dismissed_at": null,
  "dismissal_reason": null
}
```

### ID prefixes

| Prefix | Source |
|---|---|
| `D-` | Deterministic tool finding (semgrep, linter, vuln scanner, test inversion) |
| `F-` | LLM-asserted finding |

### Severity levels

| Level | Meaning |
|---|---|
| `critical` | Must fix before merge (security vulnerabilities, data loss) |
| `high` | Should fix before merge (logic errors, missing auth) |
| `medium` | Worth discussing (test quality, minor scope creep) |
| `low` | Cosmetic or style issue |
| `info` | Informational note, no action required |

### Categories

| Category | What it catches |
|---|---|
| `security` | Vulnerabilities, auth issues, injection |
| `architecture` | Design problems, coupling, abstraction issues |
| `scope-creep` | Changes unrelated to the stated PR intent |
| `test-quality` | Tests that don't verify the change |
| `performance` | N+1 queries, unnecessary allocations |
| `maintainability` | Readability, naming, dead code |

### Dismissal fields

Findings are never deleted — they're dismissed with structured disposition data:

```json
{
  "dismissed": true,
  "dismissed_by": "jane@example.com",
  "dismissed_at": "2025-01-15T10:30:00Z",
  "dismissal_reason": "False positive — the input is sanitized upstream"
}
```

### Artifact structure

The full JSON artifact (`--output findings.json`) contains:

```json
{
  "$schema": "https://flaught.dev/schemas/findings/v1.schema.json",
  "schema_version": 1,
  "_caveat": "This artifact is evidence that adversarial scrutiny occurred on this PR. ...",
  "generated_at": "2025-01-15T10:25:00Z",
  "flaught_version": "0.1.0",
  "repository": {
    "name": "my-repo",
    "url": "",
    "branch": ""
  },
  "pull_request": {
    "number": null,
    "url": null,
    "title": null,
    "description": null,
    "base_sha": "abc123...",
    "head_sha": "def456..."
  },
  "run": {
    "id": "flaught-1705315500-a3b2c1",
    "ci_url": null,
    "duration_seconds": 45
  },
  "tools_executed": [
    { "tool": "semgrep", "version": "1.60.0", "exit_code": 0, "raw_findings_count": 2, "command": "semgrep --json ..." }
  ],
  "findings": [ ... ],
  "test_inversion": {
    "command": "npm test",
    "base_passed": ["test A", "test B"],
    "head_passed": ["test A", "test B"],
    "flagged": [
      { "test": "test A", "reason": "Passes on both base and head — doesn't test the change" }
    ]
  },
  "scope_creep": {
    "pr_intent": "Fix login redirect bug",
    "flagged_hunks": [
      { "file": ".eslintrc.json", "lines": "1-5", "reason": "Linter configuration change unrelated to stated PR intent" }
    ]
  },
  "noise_budget": {
    "critical": { "limit": 5, "used": 0 },
    "high": { "limit": 10, "used": 1 },
    "medium": { "limit": 15, "used": 3 },
    "low": { "limit": 20, "used": 0 },
    "info": { "limit": 25, "used": 0 }
  },
  "summary": {
    "total_findings": 4,
    "by_severity": { "critical": 0, "high": 1, "medium": 3, "low": 0, "info": 0 },
    "by_source_type": { "deterministic": 2, "llm": 2 },
    "by_category": { "security": 1, "test-quality": 1, "maintainability": 2 },
    "dismissed_count": 0
  }
}
```

## GitHub Actions integration

### Minimal — deterministic tools only (no API key needed)

This runs Semgrep, your linter, and vulnerability scanner with zero LLM cost. Test inversion and scope-creep heuristics still run.

```yaml
# .github/workflows/adversarial-review.yml
name: Adversarial Review

on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Flaught
        run: npm install -g @flaught/core

      - name: Install Semgrep
        run: pip install semgrep

      - name: Install dependencies
        run: npm ci

      - name: Run adversarial review (deterministic only)
        run: |
          flaught review \
            --base origin/${{ github.base_ref }} \
            --head HEAD \
            --no-llm \
            --output findings.json \
            --pr-description "${{ github.event.pull_request.title }}" \
            --quiet
        continue-on-error: true

      - name: Upload findings
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: flaught-findings
          path: findings.json

      - name: Comment on PR
        if: always()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          if [ -f findings.json ]; then
            BODY=$(flaught review \
              --base origin/${{ github.base_ref }} \
              --head HEAD \
              --no-llm \
              --pr-description "${{ github.event.pull_request.title }}" \
              --quiet 2>/dev/null)
            gh pr comment ${{ github.event.pull_request.number }} --body "$BODY"
          fi
```

### Full — with LLM adversarial pass

```yaml
# .github/workflows/adversarial-review.yml
name: Adversarial Review

on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Flaught
        run: npm install -g @flaught/core

      - name: Install Semgrep
        run: pip install semgrep

      - name: Install dependencies
        run: npm ci

      - name: Run adversarial review
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: |
          flaught review \
            --base origin/${{ github.base_ref }} \
            --head HEAD \
            --output findings.json \
            --pr-description "${{ github.event.pull_request.title }}" \
            --quiet
        continue-on-error: true

      - name: Upload findings
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: flaught-findings
          path: findings.json

      - name: Comment on PR
        if: always()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          if [ -f findings.json ]; then
            BODY=$(flaught review \
              --base origin/${{ github.base_ref }} \
              --head HEAD \
              --pr-description "${{ github.event.pull_request.title }}" \
              --quiet 2>/dev/null)
            gh pr comment ${{ github.event.pull_request.number }} --body "$BODY"
          fi
```

### Using Ollama in CI

For teams that want LLM review without sending code to external APIs:

```yaml
# .github/workflows/adversarial-review.yml
name: Adversarial Review (Ollama)

on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    services:
      ollama:
        image: ollama/ollama:latest
        ports:
          - 11434:11434
        options: >-
          --health-cmd "curl http://localhost:11434/api/tags"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Flaught
        run: npm install -g @flaught/core

      - name: Install Semgrep
        run: pip install semgrep

      - name: Pull Ollama model
        run: |
          curl http://localhost:11434/api/pull -d '{"name":"codellama"}'

      - name: Install dependencies
        run: npm ci

      - name: Run adversarial review
        run: |
          flaught review \
            --base origin/${{ github.base_ref }} \
            --head HEAD \
            --output findings.json \
            --pr-description "${{ github.event.pull_request.title }}" \
            --quiet
        continue-on-error: true
        env:
          OLLAMA_HOST: http://localhost:11434

      - name: Upload findings
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: flaught-findings
          path: findings.json
```

With this `.advreview.yml`:

```yaml
version: 1
llm:
  provider: ollama
  model: codellama
  base_url: http://localhost:11434
```

### Exit code handling in CI

Flaught's exit code is designed for CI gating:

```yaml
- name: Run adversarial review
  run: flaught review --base origin/${{ github.base_ref }} --quiet
  # exit 0 = clean (no findings at/above severity gate)
  # exit 1 = gated (findings exceed severity gate threshold)
  # exit 2 = error (config/API problem)
```

Use `continue-on-error: true` if you want the workflow to continue even when findings are found (e.g., to post a comment), then check the exit code in a subsequent step.

## Programmatic API

Flaught can also be used as a library:

```typescript
import { runReview } from "@flaught/core";

const result = await runReview({
  repoPath: "/path/to/repo",
  baseRef: "main",
  headRef: "feature-branch",
  prDescription: "Fix login redirect bug",
  skipLlm: false,
  onProgress: (msg) => console.error(msg),
});

console.log(result.markdown);   // Markdown report
console.log(result.json);       // JSON artifact string
console.log(result.exitCode);   // 0, 1, or 2
console.log(result.artifact);   // Full FindingsArtifact object

// Access structured results
result.artifact.findings.forEach((f) => {
  console.log(`${f.id} [${f.severity}] ${f.title} (${f.source_type})`);
});

// Test inversion results
if (result.artifact.test_inversion) {
  result.artifact.test_inversion.flagged.forEach((t) => {
    console.log(`⚠ Test doesn't verify the change: ${t.test}`);
  });
}

// Scope-creep results
if (result.artifact.scope_creep) {
  result.artifact.scope_creep.flagged_hunks.forEach((h) => {
    console.log(`⚠ Scope creep: ${h.file} (${h.lines}): ${h.reason}`);
  });
}
```

### Programmatic context assembly

If you only need the diff context (stage 1):

```typescript
import { assembleContext, contextToJSON } from "@flaught/core";

const context = await assembleContext({
  repoPath: "/path/to/repo",
  baseRef: "main",
  headRef: "feature-branch",
});

console.log(contextToJSON(context));
// { changedFiles: [...], neighborhoodFiles: [...], dependencyGraph: ..., ... }
```

## Troubleshooting

### Missing API key

```
❌ Missing API key. Set the OPENAI_API_KEY environment variable to use the OpenAI provider.

Options:
  1. Set the key: export OPENAI_API_KEY=sk-...
  2. Use a different provider in .advreview.yml:
       llm:
         provider: ollama
         model: codellama
  3. Skip the LLM review entirely: flaught review --no-llm
```

Every LLM error message includes actionable suggestions. The `--no-llm` flag is always offered as an escape hatch.

### LLM timeout

If the diff is large or the model is slow:

```yaml
llm:
  timeout_seconds: 300  # increase from default 120s
```

Or use a faster model (Groq with `llama-3.1-70b-versatile` is ~5x faster than OpenAI).

### Ollama not running

```
❌ Could not reach Ollama at http://localhost:11434.

This usually means:
  • The model name is misspelled in .advreview.yml
  • Ollama is not running — start it with: ollama serve
  • The base_url in your config is wrong

Run with --no-llm to skip the LLM review entirely.
```

### Test inversion failures

Test inversion creates a temporary git worktree at the base SHA and installs dependencies there. If this fails:

- Ensure `git` is available in your environment
- For JS projects, `npm ci` must succeed in the worktree
- You can disable test inversion: `test_inversion: { enabled: false }`
- Or override the test command: `test_inversion: { command: "npm run test:ci" }`

## Architecture

```
src/
├── cli.ts                      # CLI entry point (Commander.js)
├── config.ts                   # Config loader (.advreview.yml → Zod → defaults)
├── review.ts                   # Orchestrator: config → context → tools → LLM → findings → reports
├── index.ts                    # Public API exports
├── context/
│   ├── assembler.ts            # Diff extraction, file detection, neighborhood builder
│   └── neighborhood.ts        # Import parser + dependency graph (JS/TS/Python/Go)
├── llm/
│   ├── provider.ts            # LLMProvider interface, OpenAI/Ollama adapters, error handling
│   └── prompt.ts               # System/user prompt builders, 100K char truncation
├── tools/
│   └── runner.ts               # Semgrep, linter, vuln scanner runners + parsers
├── test-inversion/
│   └── runner.ts               # Git worktree, pre/post test comparison
├── scope-creep/
│   └── detector.ts             # Heuristic + LLM scope-creep detection
├── report/
│   ├── markdown.ts             # Markdown PR comment renderer
│   └── json.ts                 # JSON artifact renderer
└── schemas/
    ├── config.ts                # Zod-validated config schema with all defaults
    └── findings.ts              # Versioned findings schema, types, constants
```

## License

MIT