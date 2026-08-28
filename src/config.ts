/**
 * Config loader — reads and validates .advreview.yml
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { FlaughtConfigSchema, type FlaughtConfig, mergeWithDefaults } from "./schemas/config.js";

const CONFIG_FILENAMES = [".advreview.yml", ".advreview.yaml"];

/**
 * Search for the config file starting from cwd and walking up to repo root.
 */
export function findConfigFile(startDir: string): string | null {
  let dir = startDir;

  for (let i = 0; i < 10; i++) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = path.join(dir, filename);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return null;
}

/**
 * Load and validate the config file.
 *
 * If no config file is found, returns defaults.
 * If a config file is found, merges it with defaults and validates with Zod.
 *
 * Search order: `configPath`'s directory, else `repoPath` (e.g. from
 * `--repo`/`ReviewOptions.repoPath`), else `process.cwd()`. Without this,
 * `flaught review --repo /some/other/repo` run from an unrelated cwd would
 * silently fall back to defaults instead of that repo's .advreview.yml.
 */
export async function loadConfig(
  configPath?: string,
  repoPath?: string,
): Promise<FlaughtConfig> {
  const searchDir = configPath
    ? path.dirname(configPath)
    : (repoPath ?? process.cwd());

  const filePath = configPath ?? findConfigFile(searchDir);

  if (!filePath) {
    return FlaughtConfigSchema.parse({});
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const raw = yaml.load(content, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;

  return mergeWithDefaults(raw);
}

/**
 * Initialize a new .advreview.yml with commented defaults.
 */
export function initConfig(targetDir: string): string {
  const filePath = path.join(targetDir, ".advreview.yml");
  const template = `# Flaught adversarial review configuration
# See https://github.com/flaught/core for full documentation
#
# IMPORTANT: every commented-out block below (tools, test_inversion,
# scope_creep, noise_budget, severity_gate, dismissals) shows this schema's
# ACTUAL DEFAULT, already in effect whether or not you uncomment it —
# including tools.semgrep/linter/vuln_scanner/dependency_sanity, all enabled by default.
# Commenting a block back out does NOT disable it; only an explicit
# \`enabled: false\` (or other overriding value) changes behavior. Uncomment
# a block to inspect or override its default, not to "turn it on."

version: 1

# ── Stack declaration ──────────────────────────────────────
# Omit to auto-detect from repo contents (package.json, requirements.txt, etc.)
# stack:
#   languages: [python, typescript]
#   frameworks: [fastapi, react]
#   runtime: node  # node | python | mixed | auto

# ── LLM provider ───────────────────────────────────────────
llm:
  provider: groq            # openai | groq | gemini | anthropic | ollama
  model: openai/gpt-oss-20b # good balance of speed and quality; also try: openai/gpt-oss-120b
  api_key_env: GROQ_API_KEY # e.g. OPENAI_API_KEY for openai, ANTHROPIC_API_KEY for anthropic
  # base_url: null          # override for OpenAI-compatible endpoints, or an
                             # Anthropic Messages-API-compatible proxy/gateway
  temperature: 0.2
  max_tokens: 4096
  timeout_seconds: 120     # timeout for LLM API calls
  # reasoning_effort: medium # low | medium | high — for GPT-OSS / o-series models that support it;

# ── Deterministic tools ────────────────────────────────────
# tools:
#   semgrep:
#     enabled: true
#     # config: path/to/semgrep-rules.yml
#   linter:
#     enabled: true
#     # command: eslint  # override auto-detected linter
#   vuln_scanner:
#     enabled: true
#     # command: npm audit  # override auto-detected scanner
#   dependency_sanity:
#     enabled: true
#     min_age_days: 30
#     min_weekly_downloads: 10
#     typosquat_max_distance: 1

# ── Test inversion ──────────────────────────────────────────
# test_inversion:
#   enabled: true
#   # command: pytest  # override auto-detected test command
#   scope_to_blast_radius: true  # only flag tests in the diff's changed/blast-radius files
#   skip_docs_only_diffs: true   # skip entirely when every changed file is documentation

# ── Scope-creep detection ─────────────────────────────────
# scope_creep:
#   enabled: true
#   intent_source: pr_description  # pr_description | linked_issue | both
#   # Paths that are never scored as scope creep (e.g. an ADR accompanying
#   # the change it documents), regardless of the PR's stated intent.
#   exclude_paths: []
#   #   - "docs/adr/**"

# ── Lighthouse (optional, degrades cleanly) ─────────────────
# lighthouse:
#   enabled: false
#   # preview_url: https://deploy-preview-42.example.com

# ── Noise budget ───────────────────────────────────────────
# noise_budget:
#   critical: 5
#   high: 10
#   medium: 15
#   low: 20
#   info: 25

# ── Severity gate ──────────────────────────────────────────
# severity_gate:
#   fail_on: high  # none | critical | high | medium

# ── Dismissals ───────────────────────────────────────────────
# Findings matching an entry in the dismissal store (see \`flaught dismiss\`)
# are auto-marked dismissed on every subsequent run and excluded from the
# severity gate.
# dismissals:
#   enabled: true
#   path: .flaught-dismissals.json

# ── Refute pass (skeptic) ─────────────────────────────────────────────────
# After the LLM review, a second pass challenges each LLM-asserted finding.
# This is Flaught's core differentiator: a finding must survive a skeptic to
# be trusted. Deterministic findings (Semgrep, linters) are ground truth
# and are never refuted.
#
# By default the same model is used for both passes; for anti-correlation,
# point the skeptic at a different provider/model (e.g. code with Claude,
# review with GPT-4o). See the README's LLM provider table for all options.
# refute:
#   enabled: true
#   # provider: anthropic    # separate provider for the skeptic (null = same as main LLM)
#   # model: claude-sonnet-5  # separate model for the skeptic (null = same as main LLM)
#   # api_key_env: ANTHROPIC_API_KEY  # separate API key (null = same as main LLM)
#   # base_url: null            # separate base URL (null = same as main LLM)
#   temperature: 0.3     # slightly higher than the reviewer's 0.2 for creative doubt
#   max_tokens: 2048     # skeptic needs less output than the initial review
#   max_batch_size: 20   # max findings per skeptic batch

# ── Prompt templates ────────────────────────────────────────
# Override or extend the LLM prompts by dropping files into .flaught-prompt/
# See https://github.com/flaught/core for the full list of template files.
# prompt:
#   enabled: true
#   path: .flaught-prompt

# ── Exclusions ─────────────────────────────────────────────
# exclude:
#   paths:
#     - "node_modules/**"
#     - "vendor/**"
#     - "**/*.min.js"
#     - "**/*.min.css"
#     - "**/*.generated.*"
#   patterns: []
`;

  fs.writeFileSync(filePath, template, "utf-8");
  return filePath;
}