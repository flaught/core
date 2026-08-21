# Troubleshooting

## Missing API key

```
❌ Missing API key. Set the GROQ_API_KEY environment variable to use the Groq provider.

Options:
  1. Set the key: export GROQ_API_KEY=<your-api-key>
  2. Use a different provider in .advreview.yml:
       llm:
         provider: ollama
         model: codellama
  3. Skip the LLM review entirely: flaught review --no-llm
```

This is the default provider's version of the message (`flaught init` sets `provider: groq`) — the wording adapts to whatever `llm.provider`/`llm.api_key_env` your config actually has.

Every LLM error message includes three actionable suggestions. The `--no-llm` flag is always offered as an escape hatch.

**Quick fixes:**
- Set the env var: `export GROQ_API_KEY=<your-api-key>` (or the key for whichever provider your config uses)
- Switch providers in `.advreview.yml` (see [configuration](configuration.md))
- Skip the LLM: `flaught review --no-llm`

## LLM timeout

If the diff is large or the model is slow:

```
❌ Request to gpt-4o timed out after 120s.

This usually means the diff is too large or the model is slow to respond.

Options:
  • Increase timeout in .advreview.yml: llm.timeout_seconds: 300
  • Use a faster model (e.g., groq with llama-3.1-70b)
  • Run with --no-llm to skip the LLM review entirely
```

**Quick fixes:**
- Increase timeout: `llm.timeout_seconds: 300` in `.advreview.yml`
- Use a faster model (Groq is ~5x faster than OpenAI)
- Prompt size is automatically truncated at ~25K tokens; if you're still timing out, the model is too slow

## Ollama not running

```
❌ Could not reach Ollama at http://localhost:11434.

This usually means:
  • The model name is misspelled in .advreview.yml
  • Ollama is not running — start it with: ollama serve
  • The base_url in your config is wrong

Run with --no-llm to skip the LLM review entirely.
```

**Quick fixes:**
- Start Ollama: `ollama serve`
- Pull the model: `ollama pull codellama`
- Verify it's running: `curl http://localhost:11434/api/tags`
- If using a custom port, set `base_url` in `.advreview.yml`

## 401/403 errors

```
❌ API key not configured or not valid for gpt-4o.

This usually means the key is missing, empty, expired, or invalid.

Options:
  • Set the key: export OPENAI_API_KEY=...
  • Check that the key in .advreview.yml (llm.api_key_env) points to a set env var
  • Switch to a different provider in .advreview.yml (e.g., groq, anthropic, ollama)
  • Run with --no-llm to skip the LLM review entirely
```

Flaught never guesses about billing — the error message always says "key not configured or not valid" because that covers the most common cases.

## 429 rate limiting

```
❌ Rate limited by openai for model "gpt-4o".

This means you've hit the rate limit on your plan (free tier: 30 RPM, 6K TPM).

Options:
  • Wait a minute and retry
  • Upgrade your OpenAI plan for higher limits
  • Switch to a different provider in .advreview.yml (e.g., groq, anthropic, ollama)
  • Run with --no-llm to skip the LLM review entirely
```

**Quick fixes:**
- Check your API key has credits
- Use `groq` provider (free tier with generous limits)
- Use `ollama` provider (local, no rate limits)

## Model not found (404)

```
❌ Model "gpt-4o-mini" not found.

This usually means the model name in your .advreview.yml is misspelled or deprecated.
```

**Quick fixes:**
- Check the model name in `.advreview.yml`
- For Ollama: run `ollama list` to see installed models
- For OpenAI: check the [models page](https://platform.openai.com/docs/models)

## Test inversion failures

Test inversion creates a temporary git worktree at the base SHA and installs dependencies there. If this fails:

- Ensure `git` is available (Flaught uses `git worktree`)
- For JS projects, `npm ci` must succeed in the worktree — make sure `package-lock.json` is committed
- For Python projects, ensure your test runner is installed
- Override the test command: `test_inversion: { command: "npm run test:ci" }`
- Disable it: `test_inversion: { enabled: false }`

### Worktree cleanup

If a Flaught run is killed mid-test-inversion, the worktree may be left behind. Clean up manually:

```bash
git worktree list
git worktree remove .flaught-worktree-<timestamp>
```

(Worktrees are named `.flaught-worktree-<epoch-ms>`, not by SHA — use `git worktree list` to find the exact path.)

### Too many / unrelated tests flagged

`test_inversion.scope_to_blast_radius` (default `true`) limits flagged findings to tests whose file is a changed file or in its one-hop dependency blast radius — a test file the diff couldn't possibly have affected passing unchanged isn't a quality signal about *this* PR.

This is best-effort: which file a test belongs to is extracted from the test runner's own output. Some shapes don't expose it — Go and Rust's default output has no file info at all, and a slow-running JS/TS test file that your reporter expands into individual per-test lines (rather than one per-file summary line) loses the file association for those individual lines too. In both cases the test is kept **unscoped** rather than silently dropped — a false positive you re-triage is safer than a real issue that quietly disappears — so you may still see some findings for files well outside the diff. If it's still too noisy for your test runner's output format, set `scope_to_blast_radius: false` to go back to flagging everything, or `test_inversion.enabled: false` to disable the check entirely.

## Deterministic tool issues

### Semgrep not found

Semgrep is optional. If it's not installed, the command fails silently and Flaught just reports 0 findings for that tool — it doesn't block the review:

```
Running deterministic tools...
  Running semgrep...
    semgrep: 0 findings (12ms)
```

Install it: `pip install semgrep`

### Linter not found

Flaught auto-detects your linter based on repo contents (`.eslintrc*`/`eslint.config.*` for JS/TS, `ruff`/`flake8` for Python, `go vet` for Go). If none of those markers are found and no `tools.linter.command` is set, the linter step reports 0 findings:

```
  Running linter...
    linter: 0 findings (0ms)
```

Override in config: `tools.linter.command: eslint`

### Vulnerability scanner

Same pattern — auto-detects `npm audit`, `pip-audit`, or `govulncheck`. Override with `tools.vuln_scanner.command`.

## Config validation errors

Flaught validates `.advreview.yml` with Zod. If your config is invalid:

```
❌ [
  {
    "received": "azure",
    "code": "invalid_enum_value",
    "options": ["openai", "groq", "gemini", "ollama", "anthropic"],
    "path": ["llm", "provider"],
    "message": "Invalid enum value. Expected 'openai' | 'groq' | 'gemini' | 'ollama' | 'anthropic', received 'azure'"
  }
]
```

Run `flaught init` to regenerate a valid config with defaults.

## No changes detected

```
No changes detected. Nothing to review.
```

This means the diff between `--base` and `--head` is empty. Common causes:
- `--base` and `--head` point to the same commit
- All changes are in excluded paths
- Working tree has uncommitted changes but you're comparing two refs

Try: `flaught review --base HEAD~1 --head HEAD`