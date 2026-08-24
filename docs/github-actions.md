# GitHub Actions integration

Flaught is designed to run in CI. This page has three ready-to-use workflows and guidance on exit code handling.

> **If you want findings to block merge, don't stop at copy-pasting an example below.** The Minimal, Ollama Cloud, and self-hosted Ollama workflows use `continue-on-error: true`, which never fails the job — not on exit 1 (real findings) and not on exit 2 (tool/LLM error). The "Full" workflow below is the one exception: it already uses the exit-code-split pattern from [Exit code handling](#exit-code-handling), so real findings block merge while a Groq outage only warns. If you hand-modify any of these to make findings block merge (e.g. by just dropping `continue-on-error: true`), you will also make tool/LLM errors block merge unless you re-derive the split — that's exactly the bug [Exit code handling](#exit-code-handling) exists to prevent.

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

This workflow blocks merge on real findings (exit 1) but fails open on a tool/LLM error (exit 2, e.g. a Groq outage) — see [Exit code handling](#exit-code-handling) for why that split matters. It's the same pattern this repo's own [dogfooding workflow](../.github/workflows/adversarial-review.yml) uses.

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
        id: review
        env:
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
          PR_BASE_REF: ${{ github.base_ref }}
          PR_TITLE: ${{ github.event.pull_request.title }}
        # set +e / explicit exit 0: this step's own pass/fail no longer
        # gates the job — the two Check steps below do that, branching on
        # exit_code so exit 1 (findings) and exit 2 (tool/LLM error) are
        # handled differently instead of alike.
        run: |
          set +e
          flaught review \
            --base "origin/${PR_BASE_REF}" \
            --head HEAD \
            --output findings.json \
            --pr-description "${PR_TITLE}" \
            --quiet
          echo "exit_code=$?" >> "$GITHUB_OUTPUT"
          exit 0

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

      - name: Check severity gate
        if: steps.review.outputs.exit_code == '1'
        run: |
          echo "::error::Flaught found findings that exceed the severity gate threshold"
          exit 1

      - name: Check for errors
        if: steps.review.outputs.exit_code == '2'
        run: |
          echo "::warning::Flaught encountered an error (config, API, or runtime) and could not complete the review. This does NOT block merge — an LLM/infra outage is not evidence of a real code problem. Check the workflow logs and consider re-running."
```

Add `GROQ_API_KEY` to your repository secrets (Settings → Secrets and variables → Actions). This matches the default `.advreview.yml` that `flaught init` generates (`provider: groq`, `api_key_env: GROQ_API_KEY`) — no config changes needed.

**Note on the "Comment on PR" step:** it re-runs `flaught review` a second time to get markdown for the comment body, since `--output` only writes the JSON artifact — there's no "render markdown from an existing artifact" command yet. That second run uses `--no-llm` deliberately: running it *without* `--no-llm` would call the LLM API a second time per PR (doubling cost/latency) just to reproduce a report. The tradeoff is that the posted comment only reflects deterministic/test-inversion/scope-creep findings, not the LLM pass — the uploaded `findings.json` artifact from the first (full) run is the source of truth for LLM findings.

### Comments on fork PRs need a second workflow

The single-workflow examples above post the comment from the same `pull_request` job that runs the review. That works for PRs from branches **in the same repo**, but **breaks for PRs from forks** with:

```
GraphQL: Resource not accessible by integration (addComment)
```

This is by design, not a Flaught bug. For `pull_request` events from forks, GitHub restricts the auto-generated `GITHUB_TOKEN` to **read-only** and **withholds repository secrets** — so `pull-requests: write` in the `permissions:` block does not grant comment access, and a PAT or App token stored as a secret would be empty there too (secrets are not passed to fork-PR workflows at all). The review itself runs fine and produces `findings.json`; only the comment step fails.

The fix is the canonical **two-workflow (pwn-request prevention) pattern**: an unprivileged `pull_request` workflow runs the review on the fork's code (read-only token, no secrets) and uploads the rendered comment body + PR number as artifacts, then a privileged `workflow_run` workflow — which runs in the base-repo context with a write-capable token and access to secrets — downloads those artifacts and posts the comment. The privileged workflow **never checks out or executes the fork's code**; it only forwards data.

This repo dogfoods exactly that split, **extended so fork PRs also get the LLM adversarial pass** (not just the comment):

- [`.github/workflows/adversarial-review.yml`](https://github.com/flaught/core/blob/main/.github/workflows/adversarial-review.yml) — unprivileged `pull_request`. Two paths selected by whether `GROQ_API_KEY` is present: **same-repo PR** runs the full LLM review inline + renders the comment; **fork PR** (no secret) runs `flaught review --no-llm --emit-context context.json --output findings.json` — deterministic only, plus a **context bundle** (the diff + file contents as data). Enforces the severity gate (exit 1 blocks merge) on the findings it has.
- [`.github/workflows/adversarial-review-comment.yml`](https://github.com/flaught/core/blob/main/.github/workflows/adversarial-review-comment.yml) — privileged `workflow_run` (write token + secrets, base-repo context). For a fork PR it **checks out the trusted `main` branch** (never the fork), builds Flaught, and runs `flaught review --only-llm --context context.json --findings findings.json` — the LLM + refute pass runs against the diff carried as **data** on the bundle, with `GROQ_API_KEY` used only as the `Authorization:` header (never shown to the LLM). The rendered markdown becomes the comment. For a same-repo PR it just posts the pre-rendered comment body.

**Security invariant:** the secret is used to *call* the LLM, never *shown* to it. The only untrusted input the LLM sees is the diff text, so a malicious fork can't exfiltrate the key via prompt injection — worst case is comment-content social-engineering (text on a PR). The privileged workflow never checks out or executes the fork's code.

**Severity gate on fork PRs:** the unprivileged run's `Adversarial Review` check gates on *deterministic* findings; the privileged `workflow_run` posts a separate **`Adversarial Review (LLM)`** commit status on the fork PR's head SHA — `failure` when the `--only-llm` exit code is 1 (LLM findings exceed the severity threshold), `success` otherwise. Same-repo PRs post the same status from the unprivileged run (full review exit code). Add `Adversarial Review (LLM)` to main's required status checks (Settings → Branches → Branch protection) so LLM findings block merge on fork PRs too. (The status is also `success` on a tool/LLM error — exit 2 — so a Groq outage never blocks merge.)

#### The CLI flags behind the split

- `flaught review --no-llm --emit-context <path> --output <path>` — the unprivileged half: assemble context + run deterministic tools, then write the context bundle (`context.json` = diff + file contents + raw deterministic findings) and the partial findings artifact. Pairs `--no-llm` with `--emit-context`.
- `flaught review --only-llm --context <path> --findings <path> --output <path>` — the privileged half: load the context bundle + partial findings as data, run the LLM + refute pass, finalize (scope-creep enforcement, dismissals, noise budget), and write the final artifact. Zero repo/checkout access beyond a trusted base-branch checkout for `.advreview.yml` and the dismissal store.

If your repo accepts fork PRs and you want the review comment (and, with the split, the LLM review) to land on them, copy both workflow files. The single-workflow examples above remain correct for repos that only take same-repo PRs.

### Using OpenAI, Claude, or another provider instead of Groq

Set `provider`/`model`/`api_key_env` in `.advreview.yml` for whichever provider you want (see [Configuration](configuration.md#llm-providers) for the full list), then swap the secret in the step above. For example, Claude:

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

No other workflow changes needed — just make sure `.advreview.yml` sets `llm.provider: anthropic` and `llm.api_key_env: ANTHROPIC_API_KEY` (the config default is `provider: groq` / `api_key_env: GROQ_API_KEY`, so this must be set explicitly for any other provider) and the `env:` var above matches it.

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
| `2` | Error — config problem, missing API key, LLM failure | Warns; does **not** fail the job (recommended — see below) |

**Do not treat exit 2 like exit 1.** A Groq outage, a rate limit, or a malformed LLM response is a tool fault, not evidence of a problem in the PR. If your workflow fails the job on any nonzero exit code (the naive `run: flaught review ...` form below), every PR becomes unmergeable whenever the LLM provider has a bad five minutes — a denial-of-service vector against your own repo. Always branch on the exit code explicitly and fail-open on `2`.

### Gating example (naive — do not use for exit 2)

```yaml
- name: Run adversarial review
  env:
    PR_BASE_REF: ${{ github.base_ref }}
  run: flaught review --base "origin/${PR_BASE_REF}" --quiet
  # BEWARE: any nonzero exit fails this step, including exit 2 (LLM/infra
  # error) — this blocks merge on provider outages. Use the fail-open
  # pattern below instead.
```

### Recommended pattern — fails open on errors

Capture the exit code with `set +e` and an explicit `exit 0` (the step's own pass/fail no longer gates the job), then branch in two follow-up steps: block on `1`, warn (don't block) on `2`. This is exactly what the [Full workflow](#full--with-llm-adversarial-pass) above does — see that section for the complete, working version (including the PR comment step), or [`.github/workflows/adversarial-review.yml`](https://github.com/flaught/core/blob/main/.github/workflows/adversarial-review.yml) in this repo, which Flaught dogfoods on itself.

```yaml
- name: Run adversarial review
  id: review
  env:
    PR_BASE_REF: ${{ github.base_ref }}
  run: |
    set +e
    flaught review --base "origin/${PR_BASE_REF}" --output findings.json --quiet
    echo "exit_code=$?" >> "$GITHUB_OUTPUT"
    exit 0

- name: Check severity gate
  if: steps.review.outputs.exit_code == '1'
  run: echo "::error::Findings exceed severity gate threshold" && exit 1

- name: Check for errors
  if: steps.review.outputs.exit_code == '2'
  run: echo "::warning::Flaught could not complete the review (config, API, or runtime error). Not blocking merge — check the workflow logs."
  # No `exit 1` here — this step intentionally warns and passes.
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