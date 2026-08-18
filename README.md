# Flaught

> Your PR's designated skeptic.

**Flaught** runs adversarial code review in CI — structured, skeptical scrutiny that produces a timestamped JSON artifact on every PR. Named after Monsignor Flaught, the devil's advocate in *A Canticle for Leibowitz*.

Every finding is tagged **deterministic** or **LLM-asserted** so you know what came from a tool and what came from a model. An honest `_caveat` is baked into every artifact: this is evidence that scrutiny *occurred*, not that findings are *correct*.

## What it does

Flaught runs a five-stage pipeline on every PR:

```
Config → Context assembly → Deterministic tools → LLM adversarial pass → Test inversion → Scope-creep detection
                                                                                              ↓
                                                                              Noise budget → Severity gate → Exit code
```

| Stage | What it does |
|---|---|
| **Context assembly** | Diff, changed files, one-hop dependency neighborhood (blast radius) |
| **Deterministic tools** | Semgrep, linter, vuln scanner — findings tagged `source_type: "deterministic"` |
| **LLM adversarial pass** | Structured skeptical review — security, architecture, scope-creep, test quality |
| **Test inversion** | Runs tests on pre-change code; flags tests passing on both sides |
| **Scope-creep detection** | Heuristic + LLM — flags hunks unrelated to the PR's stated intent |

Output: **Markdown PR comment** + **versioned JSON artifact** for trend tracking.

## Install

```bash
npm install -g @flaught/core
```

## Quick start

```bash
flaught init                    # scaffold .advreview.yml
flaught review                  # full adversarial review vs HEAD~1
flaught review --base main      # review against main
flaught review --no-llm         # deterministic tools only (no API key)
flaught review --output findings.json --quiet   # CI mode
flaught dismiss D-0002 --artifact findings.json --reason "..." # suppress a false positive, persisted across runs
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean — no findings above severity gate |
| `1` | Gated — findings exceed threshold |
| `2` | Error — config/API problem |

## LLM providers

Switch with zero code changes — just update `.advreview.yml`:

| Provider | Config |
|---|---|
| **OpenAI** | `provider: openai`, `model: gpt-4o` |
| **Groq** | `provider: groq`, `model: llama-3.1-70b-versatile` |
| **Gemini** | `provider: gemini`, `model: gemini-1.5-pro` |
| **Anthropic (Claude)** | `provider: anthropic`, `model: claude-sonnet-5` |
| **Ollama** | `provider: ollama`, `model: codellama` |

Any OpenAI-compatible endpoint works via `base_url`. Anthropic has its own native adapter (its Messages API isn't OpenAI-compatible) — `model` and `base_url` are both free-form, so any current/future Claude model or Messages-API-compatible proxy works without a code change.

## Documentation

- **[Configuration](docs/configuration.md)** — full `.advreview.yml` reference, LLM providers, noise budget, severity gate, tools, test inversion, scope-creep
- **[Findings schema](docs/findings-schema.md)** — artifact structure, field definitions, severity levels, categories, dismissal, blast radius
- **[Dismissals](docs/dismissals.md)** — persisting false-positive suppressions across runs via stable fingerprints, `flaught dismiss`/`dismissals` CLI
- **[GitHub Actions](docs/github-actions.md)** — three ready-to-use workflows (minimal, full, Ollama) + exit code handling
- **[Programmatic API](docs/api.md)** — use Flaught as a library in Node.js
- **[Troubleshooting](docs/troubleshooting.md)** — every error message, what it means, how to fix it

## ⚠️ Honest caveat

The JSON artifact is evidence that *scrutiny occurred*, not evidence that findings are *correct*. LLM-asserted findings may include hallucinations. Deterministic-tool findings have their own false-positive rates. Treat this as a prompt for human review, not audit-truth.

## License

MIT