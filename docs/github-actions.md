# GitHub Actions integration

Flaught is designed to run in CI. This page has three ready-to-use workflows and guidance on exit code handling.

## Minimal — deterministic tools only (no API key needed)

Runs Semgrep, your linter, and vulnerability scanner with zero LLM cost. Test inversion and scope-creep heuristics still work.

```yaml
# .github/workflows/adversarial-review.yml
name: Adversarial Review

on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          fetch-depth: 0

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22

      - name: Install Flaught
        run: npm install -g @flaught/core

      - name: Install Semgrep
        run: pip install semgrep

      - name: Install dependencies
        run: npm ci

      - name: Run adversarial review (deterministic only)
        env:
          PR_BASE_REF: ${{ github.base_ref }}
          PR_TITLE: ${{ github.event.pull_request.title }}
        run: |
          flaught review \
            --base "origin/${PR_BASE_REF}" \
            --head HEAD \
            --no-llm \
            --output findings.json \
            --pr-description "${PR_TITLE}" \
            --quiet
        continue-on-error: true

      - name: Upload findings
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: flaught-findings
          path: findings.json

      - name: Comment on PR
        if: always()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_BASE_REF: ${{ github.base_ref }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          PR_TITLE: ${{ github.event.pull_request.title }}
        run: |
          if [ -f findings.json ]; then
            BODY=$(flaught review \
              --base "origin/${PR_BASE_REF}" \
              --head HEAD \
              --no-llm \
              --pr-description "${PR_TITLE}" \
              --quiet 2>/dev/null)
            echo "$BODY" | gh pr comment "${PR_NUMBER}" --body-file -
          fi
```

Actions are pinned to commit SHA (supply-chain integrity) and every `github.*` expression is passed through `env:` rather than interpolated directly into the shell — interpolating a PR title straight into a `run:` block lets an attacker execute arbitrary shell code via the PR title. This is the same pattern this repo's own [dogfooding workflow](../.github/workflows/adversarial-review.yml) uses.

## Full — with LLM adversarial pass

```yaml
# .github/workflows/adversarial-review.yml
name: Adversarial Review

on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          fetch-depth: 0

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22

      - name: Install Flaught
        run: npm install -g @flaught/core

      - name: Install Semgrep
        run: pip install semgrep

      - name: Install dependencies
        run: npm ci

      - name: Run adversarial review
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          PR_BASE_REF: ${{ github.base_ref }}
          PR_TITLE: ${{ github.event.pull_request.title }}
        run: |
          flaught review \
            --base "origin/${PR_BASE_REF}" \
            --head HEAD \
            --output findings.json \
            --pr-description "${PR_TITLE}" \
            --quiet
        continue-on-error: true

      - name: Upload findings
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: flaught-findings
          path: findings.json

      - name: Comment on PR
        if: always()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_BASE_REF: ${{ github.base_ref }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          PR_TITLE: ${{ github.event.pull_request.title }}
        run: |
          if [ -f findings.json ]; then
            BODY=$(flaught review \
              --base "origin/${PR_BASE_REF}" \
              --head HEAD \
              --no-llm \
              --pr-description "${PR_TITLE}" \
              --quiet 2>/dev/null)
            echo "$BODY" | gh pr comment "${PR_NUMBER}" --body-file -
          fi
```

Add `OPENAI_API_KEY` to your repository secrets (Settings → Secrets and variables → Actions).

**Note on the "Comment on PR" step:** it re-runs `flaught review` a second time to get markdown for the comment body, since `--output` only writes the JSON artifact — there's no "render markdown from an existing artifact" command yet. That second run uses `--no-llm` deliberately: running it *without* `--no-llm` would call the LLM API a second time per PR (doubling cost/latency) just to reproduce a report. The tradeoff is that the posted comment only reflects deterministic/test-inversion/scope-creep findings, not the LLM pass — the uploaded `findings.json` artifact from the first (full) run is the source of truth for LLM findings. This matches the pattern used in this repo's own [dogfooding workflow](../.github/workflows/adversarial-review.yml).

### Using Claude instead of OpenAI

Set `provider: anthropic` and `model: claude-sonnet-5` (or `claude-opus-5`, `claude-haiku-4-5`) in `.advreview.yml`, then swap the secret in the step above:

```yaml
      - name: Run adversarial review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          PR_BASE_REF: ${{ github.base_ref }}
          PR_TITLE: ${{ github.event.pull_request.title }}
        run: |
          flaught review \
            --base "origin/${PR_BASE_REF}" \
            --head HEAD \
            --output findings.json \
            --pr-description "${PR_TITLE}" \
            --quiet
        continue-on-error: true
```

No other workflow changes needed — just make sure `.advreview.yml` sets `llm.api_key_env: ANTHROPIC_API_KEY` (the config default is `OPENAI_API_KEY` regardless of provider, so this must be set explicitly) and the `env:` var above matches it.

## Using Ollama Cloud in CI

The simplest option if you want Ollama's model catalog without running anything yourself. Ollama Cloud (`:cloud`-tagged models) is a plain hosted HTTPS API — no `services:` container, no health check, no model pull step, no GPU/CPU limits to worry about on the runner:

```yaml
# .github/workflows/adversarial-review.yml
name: Adversarial Review (Ollama Cloud)

on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          fetch-depth: 0

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22

      - name: Install Flaught
        run: npm install -g @flaught/core

      - name: Install Semgrep
        run: pip install semgrep

      - name: Run adversarial review
        env:
          OLLAMA_API_KEY: ${{ secrets.OLLAMA_API_KEY }}
          PR_BASE_REF: ${{ github.base_ref }}
          PR_TITLE: ${{ github.event.pull_request.title }}
        run: |
          flaught review \
            --base "origin/${PR_BASE_REF}" \
            --head HEAD \
            --output findings.json \
            --pr-description "${PR_TITLE}" \
            --quiet
        continue-on-error: true

      - name: Upload findings
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: flaught-findings
          path: findings.json
```

With this `.advreview.yml`:

```yaml
version: 1
llm:
  provider: ollama
  model: glm-5.2:cloud
  base_url: https://ollama.com
  api_key_env: OLLAMA_API_KEY
```

Generate the key at `ollama.com/settings/keys` and add it as the `OLLAMA_API_KEY` repository secret (Settings → Secrets and variables → Actions).

## Using self-hosted Ollama in CI

For teams that want LLM review without sending code to *any* external API — including Ollama's own cloud — by running the model in a container on the runner itself:

```yaml
# .github/workflows/adversarial-review.yml
name: Adversarial Review (Ollama)

on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
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
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          fetch-depth: 0

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22

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
        env:
          OLLAMA_HOST: http://localhost:11434
          PR_BASE_REF: ${{ github.base_ref }}
          PR_TITLE: ${{ github.event.pull_request.title }}
        run: |
          flaught review \
            --base "origin/${PR_BASE_REF}" \
            --head HEAD \
            --output findings.json \
            --pr-description "${PR_TITLE}" \
            --quiet
        continue-on-error: true

      - name: Upload findings
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
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

## Exit code handling

Flaught's exit codes are designed for CI gating:

| Code | Meaning | CI behavior |
|---|---|---|
| `0` | Clean — no findings at or above severity gate | Workflow passes |
| `1` | Gated — undismissed findings exceed threshold | Workflow fails (or continues if `continue-on-error: true`) |
| `2` | Error — config problem, missing API key, LLM failure | Workflow fails |

### Gating example

```yaml
- name: Run adversarial review
  env:
    PR_BASE_REF: ${{ github.base_ref }}
  run: flaught review --base "origin/${PR_BASE_REF}" --quiet
  # exit 0 = clean, exit 1 = findings exceed gate, exit 2 = error
```

### Comment-then-gate example

Use `continue-on-error: true` if you want to post a comment even when findings are found, then check the exit code:

```yaml
- name: Run adversarial review
  id: review
  env:
    PR_BASE_REF: ${{ github.base_ref }}
  run: |
    flaught review --base "origin/${PR_BASE_REF}" --output findings.json --quiet || echo "exit_code=$?" >> "$GITHUB_OUTPUT"
  continue-on-error: true

- name: Check severity gate
  if: steps.review.outputs.exit_code == '1'
  run: echo "Findings exceed severity gate threshold" && exit 1

- name: Comment on PR
  if: always()
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    PR_BASE_REF: ${{ github.base_ref }}
    PR_NUMBER: ${{ github.event.pull_request.number }}
  run: |
    BODY=$(flaught review --base "origin/${PR_BASE_REF}" --quiet 2>/dev/null)
    echo "$BODY" | gh pr comment "${PR_NUMBER}" --body-file -
```

## PR description for scope-creep detection

Pass the PR title or body via `--pr-description` to enable scope-creep detection. Route it through `env:` rather than interpolating it directly into `run:` — a PR title is attacker-controlled text, and inlining it into a shell command is a shell-injection risk:

```yaml
env:
  PR_TITLE: ${{ github.event.pull_request.title }}
  PR_BODY: ${{ github.event.pull_request.body }}
run: |
  # Just the title:
  flaught review --pr-description "${PR_TITLE}" --quiet

  # Title + body:
  flaught review --pr-description "${PR_TITLE}: ${PR_BODY}" --quiet
```

The PR description serves as the "intent anchor" — Flaught flags hunks that appear unrelated to it.