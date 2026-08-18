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
 */
export async function loadConfig(
  configPath?: string,
): Promise<FlaughtConfig> {
  const searchDir = configPath
    ? path.dirname(configPath)
    : process.cwd();

  const filePath = configPath ?? findConfigFile(searchDir);

  if (!filePath) {
    return FlaughtConfigSchema.parse({});
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const raw = yaml.load(content) as Record<string, unknown>;

  return mergeWithDefaults(raw);
}

/**
 * Initialize a new .advreview.yml with commented defaults.
 */
export function initConfig(targetDir: string): string {
  const filePath = path.join(targetDir, ".advreview.yml");
  const template = `# Flaught adversarial review configuration
# See https://github.com/flaught/core for full documentation

version: 1

# ── Stack declaration ──────────────────────────────────────
# Omit to auto-detect from repo contents (package.json, requirements.txt, etc.)
# stack:
#   languages: [python, typescript]
#   frameworks: [fastapi, react]
#   runtime: node  # node | python | mixed | auto

# ── LLM provider ───────────────────────────────────────────
llm:
  provider: openai          # openai | groq | gemini | ollama
  model: gpt-4o
  api_key_env: OPENAI_API_KEY
  # base_url: null          # override for OpenAI-compatible endpoints
  temperature: 0.2
  max_tokens: 4096
  timeout_seconds: 120     # timeout for LLM API calls

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

# ── Test inversion ──────────────────────────────────────────
# test_inversion:
#   enabled: true
#   # command: pytest  # override auto-detected test command

# ── Scope-creep detection ─────────────────────────────────
# scope_creep:
#   enabled: true
#   intent_source: pr_description  # pr_description | linked_issue | both

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

# ── Exclusions ─────────────────────────────────────────────
# exclude:
#   paths:
#     - "node_modules/**"
#     - "vendor/**"
#     - "**/*.min.js"
#   patterns: []
`;

  fs.writeFileSync(filePath, template, "utf-8");
  return filePath;
}