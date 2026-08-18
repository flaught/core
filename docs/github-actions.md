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

## Full — with LLM adversarial pass

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

Add `OPENAI_API_KEY` to your repository secrets (Settings → Secrets and variables → Actions).

## Using Ollama in CI

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
  run: flaught review --base origin/${{ github.base_ref }} --quiet
  # exit 0 = clean, exit 1 = findings exceed gate, exit 2 = error
```

### Comment-then-gate example

Use `continue-on-error: true` if you want to post a comment even when findings are found, then check the exit code:

```yaml
- name: Run adversarial review
  id: review
  run: |
    flaught review --base origin/${{ github.base_ref }} --output findings.json --quiet || echo "exit_code=$?" >> "$GITHUB_OUTPUT"
  continue-on-error: true

- name: Check severity gate
  if: steps.review.outputs.exit_code == '1'
  run: echo "Findings exceed severity gate threshold" && exit 1

- name: Comment on PR
  if: always()
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    BODY=$(flaught review --base origin/${{ github.base_ref }} --quiet 2>/dev/null)
    gh pr comment ${{ github.event.pull_request.number }} --body "$BODY"
```

## PR description for scope-creep detection

Pass the PR title or body via `--pr-description` to enable scope-creep detection:

```yaml
# Just the title:
--pr-description "${{ github.event.pull_request.title }}"

# Title + body:
--pr-description "${{ github.event.pull_request.title }}: ${{ github.event.pull_request.body }}"
```

The PR description serves as the "intent anchor" — Flaught flags hunks that appear unrelated to it.