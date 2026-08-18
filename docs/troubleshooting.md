# Troubleshooting

## Missing API key

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

Every LLM error message includes three actionable suggestions. The `--no-llm` flag is always offered as an escape hatch.

**Quick fixes:**
- Set the env var: `export OPENAI_API_KEY=sk-...`
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
  • Set the key: export OPENAI_API_KEY=sk-...
  • Check that the key in .advreview.yml (llm.api_key_env) points to a set env var
  • Switch to a different provider in .advreview.yml (e.g., groq, anthropic, ollama)
  • Run with --no-llm to skip the LLM review entirely
```

Flaught never guesses about billing — the error message always says "key not configured or not valid" because that covers the most common cases.

## 429 rate limiting

```
❌ API key not configured or not valid for gpt-4o.

This usually means your API key is missing, on a free tier with no credits, or being rate-limited.
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
git worktree remove .flaught-worktree-<sha>
```

## Deterministic tool issues

### Semgrep not found

Semgrep is optional. If it's not installed, Flaught skips it:

```
Running deterministic tools...
  Running semgrep...
    semgrep: not installed — skipping
```

Install it: `pip install semgrep`

### Linter not found

Flaught auto-detects your linter. If it can't find one:

```
  Running linter...
    linter: no linter detected — skipping
```

Override in config: `tools.linter.command: eslint`

### Vulnerability scanner

Same pattern — auto-detects `npm audit`, `pip-audit`, or `govulncheck`. Override with `tools.vuln_scanner.command`.

## Config validation errors

Flaught validates `.advreview.yml` with Zod. If your config is invalid:

```
❌ Invalid config: [
  {
    "code": "invalid_enum_value",
    "path": ["llm", "provider"],
    "message": "Expected 'openai' | 'groq' | 'gemini' | 'ollama', received 'anthropic'"
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