# Flaught

> Adversarial governance tooling for AI-assisted development.

**Flaught** produces a structured, timestamped record that independent adversarial scrutiny occurred on every PR — what was checked, what was flagged, what was dismissed and by whom. It's named after Monsignor Flaught, the *advocatus diaboli* (devil's advocate) in *A Canticle for Leibowitz* — the Church's designated skeptic, whose job is to build the strongest possible case against something everyone else wants to approve.

⚠️ **Honest caveat:** The JSON output is evidence that *scrutiny occurred*, not evidence that findings are *correct*. If the LLM hallucinates a finding, the artifact faithfully preserves a hallucination. No existing compliance framework has a named control this satisfies.

## Install

```bash
npm install -g @flaught/core
```

## Quick start

```bash
# Initialize config
flaught init

# Run adversarial review on current branch vs main
flaught review

# Review a specific diff
flaught review --base main --head feature-branch
```

## Configuration

Create `.advreview.yml` in your repo root (or run `flaught init` to scaffold one):

```yaml
version: 1

llm:
  provider: openai
  model: gpt-4o
  api_key_env: OPENAI_API_KEY

severity_gate:
  fail_on: high  # exit 1 on any undismissed high+ finding
```

See the [full configuration reference](docs/configuration.md) for all options.

## How it works

Flaught runs in CI against any PR/branch through six stages:

1. **Context assembly** — diff + one-hop dependency neighborhood (blast radius, not just filenames)
2. **LLM adversarial pass** — structured skeptical review (architecture, security, scope-creep, test quality)
3. **Deterministic tool integration** — semgrep, linters, vulnerability scanners as grounding context
4. **Test-inversion check** — run tests against pre-change code; passing on both sides means the test doesn't test the change
5. **Scope-creep detection** — flag diff hunks that don't serve the stated PR intent
6. **Optional Lighthouse** — frontend performance (degrades cleanly when unavailable)

Output is a Markdown PR comment + a versioned, self-describing JSON artifact for trend tracking.

## Findings schema

Every finding carries a `source_type` field distinguishing **deterministic** (tool-asserted) from **LLM-asserted** evidence. Dismissal is structured data (`dismissed_by`, `dismissed_at`, `dismissal_reason`), not free-text. The schema is versioned from day one.

See [`src/schemas/findings.ts`](src/schemas/findings.ts) for the full type definitions.

## Status

**Pre-alpha.** Stage 1 (context assembly) is implemented. Stages 2–6 are in progress.

## License

MIT