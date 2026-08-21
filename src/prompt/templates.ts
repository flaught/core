/**
 * Prompt template system — allows users to override or extend the LLM prompts
 * used in adversarial review by dropping template files into `.flaught-prompt/`.
 *
 * Override files (full replacement of a section):
 *   system.md          — replaces the ENTIRE system prompt (supersedes all
 *                        other system-*.md files)
 *   posture.md         — replaces the posture/persona section
 *   categories.md     — replaces the categories definition
 *   severity.md        — replaces the severity definition
 *   output-format.md  — replaces the output format specification
 *   constraints.md     — replaces the IMPORTANT constraints section
 *
 * Append files (additive — appended after built-in or overridden content):
 *   system-append.md   — appended to the system prompt
 *   user-append.md     — appended to the user prompt
 *
 * Template variables (available in all files via {{var}}):
 *   {{noise_budget}}   — formatted noise budget lines (e.g. "  - critical: max 5 findings")
 *   {{categories}}     — default category definitions (for reference when overriding)
 *   {{severities}}     — default severity definitions (for reference when overriding)
 *
 * Discovery:
 *   - Walks up from repo root (like .advreview.yml discovery)
 *   - Path configurable via prompt.path in .advreview.yml
 *   - If no directory is found, built-in defaults are used
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FlaughtConfig } from "../schemas/config.js";

// ─── Template file names ─────────────────────────────────────────────────────

const TEMPLATE_FILES = {
  system: "system.md",
  posture: "posture.md",
  categories: "categories.md",
  severity: "severity.md",
  output_format: "output-format.md",
  constraints: "constraints.md",
  system_append: "system-append.md",
  user_append: "user-append.md",
} as const;

// ─── Default template content ─────────────────────────────────────────────────

export const DEFAULT_POSTURE = `You are Monsignor Flaught — the devil's advocate for code review. Your job is to build the strongest possible case against merging this PR. You are a skeptical senior engineer who didn't write the code and doesn't trust the PR description.

POSTURE:
- Argue against merging. Find reasons this change is dangerous, over-scoped, poorly tested, or architecturally wrong.
- Flag every real risk. Do not hedge or soften findings to be "helpful."
- Distinguish clearly between findings you are certain about and findings you suspect but cannot confirm.
- If the change is genuinely clean, say so briefly — but never rubber-stamp.`;

export const DEFAULT_CATEGORIES = `CATEGORIES (use exactly these):
- security: Vulnerabilities, injection, auth issues, data exposure
- architecture: Coupling, abstraction problems, separation of concerns violations
- scope-creep: Changes that don't serve the stated PR intent
- test-quality: Missing tests, tests that don't verify the change, insufficient coverage
- performance: Algorithmic concerns, N+1 queries, memory leaks
- maintainability: Naming, documentation debt, confusing logic, dead code`;

export const DEFAULT_SEVERITY = `SEVERITY (use exactly these):
- critical: Must fix before merge — data loss, security vulnerability, broken production path
- high: Should fix before merge — significant risk or bug
- medium: Worth discussing — potential issue or improvement
- low: Nitpick or minor style concern
- info: Observation worth noting but not actionable`;

export const DEFAULT_OUTPUT_FORMAT = `OUTPUT FORMAT — respond with valid JSON only. No markdown, no explanation outside the JSON:
{
  "findings": [
    {
      "severity": "high",
      "category": "security",
      "title": "Short imperative title",
      "description": "2-4 sentences explaining the finding, the risk, and why it matters for this specific change. Be specific about the code — reference file names, function names, and line numbers.",
      "file": "path/to/file.ts",
      "line_start": 42,
      "line_end": 45,
      "snippet": "the problematic code line(s)",
      "confidence": 0.85,
      "references": []
    }
  ]
}`;

export const DEFAULT_CONSTRAINTS = `IMPORTANT:
- Rank findings within each severity tier. If you have 8 medium findings and the budget is 5, include only the 5 most important.
- Every finding MUST have file, line_start, line_end, and snippet — no exceptions.
- confidence is 0.0-1.0 — be honest. If you're guessing, say 0.4-0.5. If you're certain, say 0.9+.
- Never fabricate code, line numbers, or file paths that don't exist in the provided context.
- Don't flag a committed config value (provider name, model name, tool choice, version pin, etc.) as "hard-coded" merely because it's checked into version control. Deliberately committed config is often a feature, not a bug: it's reviewable via diff and deterministic across environments, unlike an env var or .env file that can silently drift per machine. Only raise this as a finding when the value in question is an actual secret (a credential, API key, or token) — check whether the secret itself is externalized (e.g. only an env-var *name* is configured, not its value) before concluding it isn't.
- If the code you're about to flag has an adjacent comment, or references a decision record (ADR, RFC, design doc) by name, that already explains why this is a deliberate, accepted tradeoff, don't raise it as a new finding — a human already made and documented that call. Only raise it if the comment's own stated reasoning is flawed on its face, or the code no longer matches what the comment claims it does.
- You are reviewing a repo that uses Flaught (this tool) itself. Flaught's own config keys — including \`dismissals\`, \`prompt\`, and \`severity_gate\` — have sane defaults (e.g. \`dismissals.enabled: true\`, \`dismissals.path: ".flaught-dismissals.json"\`) that apply even when \`.advreview.yml\` never mentions them, commented-out or otherwise. Don't flag a Flaught-related file (\`.flaught-dismissals.json\`, \`.flaught-prompt/\`, etc.) as "added but not referenced/wired up in config" just because \`.advreview.yml\` is silent about it — silence means the default applies, not that the feature is inert.`;

// ─── Template interface ────────────────────────────────────────────────────────

export interface PromptTemplates {
  /** Full system prompt override (null = use built-in assembly) */
  system: string | null;
  /** Posture override (null = use built-in). Ignored when system is set. */
  posture: string | null;
  /** Categories override (null = use built-in). Ignored when system is set. */
  categories: string | null;
  /** Severity override (null = use built-in). Ignored when system is set. */
  severity: string | null;
  /** Output format override (null = use built-in). Ignored when system is set. */
  outputFormat: string | null;
  /** Constraints override (null = use built-in). Ignored when system is set. */
  constraints: string | null;
  /** Appended to system prompt (after built-in or overridden content) */
  systemAppend: string | null;
  /** Appended to user prompt (after built-in or overridden content) */
  userAppend: string | null;
}

export const NO_TEMPLATES: PromptTemplates = {
  system: null,
  posture: null,
  categories: null,
  severity: null,
  outputFormat: null,
  constraints: null,
  systemAppend: null,
  userAppend: null,
};

// ─── Template variable interpolation ──────────────────────────────────────────

export interface TemplateVariables {
  /** Formatted noise budget lines */
  noise_budget: string;
  /** Default category definitions (for reference in overrides) */
  categories: string;
  /** Default severity definitions (for reference in overrides) */
  severities: string;
}

function interpolateVariables(template: string, variables: TemplateVariables): string {
  return template
    .replace(/\{\{noise_budget\}\}/g, variables.noise_budget)
    .replace(/\{\{categories\}\}/g, variables.categories)
    .replace(/\{\{severities\}\}/g, variables.severities);
}

// ─── Build template variables from config ─────────────────────────────────────

export function buildTemplateVariables(config: FlaughtConfig): TemplateVariables {
  return {
    noise_budget: Object.entries(config.noise_budget)
      .map(([severity, limit]) => `  - ${severity}: max ${limit} findings`)
      .join("\n"),
    categories: DEFAULT_CATEGORIES,
    severities: DEFAULT_SEVERITY,
  };
}

// ─── Load templates from directory ────────────────────────────────────────────

/**
 * Discover and load prompt templates from the `.flaught-prompt/` directory.
 *
 * Search order:
 * 1. `prompt.path` from config (if set, resolves relative to repo root)
 * 2. `.flaught-prompt/` at the repo root
 *
 * Returns NO_TEMPLATES (all nulls) if the directory doesn't exist or
 * prompt overrides are disabled.
 */
export function loadTemplates(
  repoRoot: string,
  config: FlaughtConfig,
): PromptTemplates {
  if (!config.prompt.enabled) {
    return NO_TEMPLATES;
  }

  const templatesDir = resolveTemplatesDir(repoRoot, config);

  if (!fs.existsSync(templatesDir)) {
    return NO_TEMPLATES;
  }

  const variables = buildTemplateVariables(config);
  const templates: PromptTemplates = { ...NO_TEMPLATES };

  for (const [key, filename] of Object.entries(TEMPLATE_FILES)) {
    const filePath = path.join(templatesDir, filename);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content.length > 0) {
        const interpolated = interpolateVariables(content, variables);
        // Use type assertion to map from template file key to the PromptTemplates field
        if (key === "system") templates.system = interpolated;
        else if (key === "posture") templates.posture = interpolated;
        else if (key === "categories") templates.categories = interpolated;
        else if (key === "severity") templates.severity = interpolated;
        else if (key === "output_format") templates.outputFormat = interpolated;
        else if (key === "constraints") templates.constraints = interpolated;
        else if (key === "system_append") templates.systemAppend = interpolated;
        else if (key === "user_append") templates.userAppend = interpolated;
      }
    }
  }

  return templates;
}

/**
 * Resolve the templates directory path.
 *
 * If prompt.path is an absolute path, use it directly.
 * Otherwise, resolve relative to repo root.
 */
function resolveTemplatesDir(repoRoot: string, config: FlaughtConfig): string {
  const promptPath = config.prompt.path;
  return path.isAbsolute(promptPath)
    ? promptPath
    : path.resolve(repoRoot, promptPath);
}

// ─── Assemble system prompt from templates ─────────────────────────────────────

/**
 * Build the system prompt using template overrides and built-in defaults.
 *
 * If templates.system is set, it replaces the entire system prompt and
 * individual section overrides (posture, categories, etc.) are ignored.
 *
 * Otherwise, the system prompt is assembled from individual section
 * overrides (or their built-in defaults).
 *
 * system-append.md is always appended, regardless of which mode is used.
 */
export function assembleSystemPrompt(
  config: FlaughtConfig,
  templates: PromptTemplates,
): string {
  const budgetLines = Object.entries(config.noise_budget)
    .map(([severity, limit]) => `  - ${severity}: max ${limit} findings`)
    .join("\n");

  // Full override mode — system.md replaces everything
  if (templates.system) {
    let prompt = templates.system;

    // Ensure noise budget is present (it's config-driven, not template-driven)
    if (!prompt.includes("NOISE BUDGET") && !prompt.includes("noise_budget") && !prompt.includes("{{noise_budget}}")) {
      prompt += `\n\nNOISE BUDGET — you MUST rank and prioritize. Do not dump every finding:\n${budgetLines}`;
    }

    if (templates.systemAppend) {
      prompt += `\n\n---\n\n${templates.systemAppend}`;
    }

    return prompt;
  }

  // Assembly mode — build from individual sections
  const posture = templates.posture ?? DEFAULT_POSTURE;
  const categories = templates.categories ?? DEFAULT_CATEGORIES;
  const severity = templates.severity ?? DEFAULT_SEVERITY;
  const outputFormat = templates.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
  const constraints = templates.constraints ?? DEFAULT_CONSTRAINTS;

  const noiseBudgetSection = `NOISE BUDGET — you MUST rank and prioritize. Do not dump every finding:\n${budgetLines}`;

  let prompt = [
    posture,
    categories,
    severity,
    noiseBudgetSection,
    outputFormat,
    constraints,
  ].join("\n\n");

  if (templates.systemAppend) {
    prompt += `\n\n---\n\n${templates.systemAppend}`;
  }

  return prompt;
}

// ─── Assemble user prompt append ──────────────────────────────────────────────

/**
 * Build the user prompt append section.
 *
 * This is appended after the built-in user prompt sections.
 * It's just the content of user-append.md, if present.
 */
export function assembleUserAppend(templates: PromptTemplates): string | null {
  return templates.userAppend;
}

// ─── Scaffold a .flaught-prompt/ directory ─────────────────────────────────────

/**
 * Create a `.flaught-prompt/` directory with commented template files.
 * Each file documents what it overrides and shows the default content.
 */
export function initPromptTemplates(targetDir: string): string {
  const dirPath = path.join(targetDir, ".flaught-prompt");
  fs.mkdirSync(dirPath, { recursive: true });

  // system.md — full override example (commented out)
  fs.writeFileSync(
    path.join(dirPath, "system.md.example"),
    `# System Prompt Override
#
# If this file is named "system.md" (without .example), it replaces the
# ENTIRE system prompt. Individual section overrides (posture.md, categories.md,
# etc.) are ignored when system.md is present.
#
# Available template variables:
#   {{noise_budget}}  — formatted noise budget lines from config
#   {{categories}}    — default category definitions (for reference)
#   {{severities}}    — default severity definitions (for reference)
#
# Tip: Start by copying the built-in prompt and modifying it, rather than
# writing from scratch. You can see the built-in defaults in:
#   src/prompt/templates.ts (DEFAULT_POSTURE, DEFAULT_CATEGORIES, etc.)
`,
    "utf-8",
  );

  // posture.md — commented example
  fs.writeFileSync(
    path.join(dirPath, "posture.md.example"),
    `# Posture Override
#
# This file replaces the posture/persona section of the system prompt.
# The default defines "Monsignor Flaught" as a skeptical devil's advocate.
#
# Example — shift to a security-focused posture:
# You are a security-focused code reviewer. Your job is to find security
# vulnerabilities, injection risks, and data exposure in this PR.
# Focus exclusively on security-relevant findings.
#
# Example — add team-specific rules:
# {{categories}}
#
# In addition to the standard categories, flag any changes that:
# - Touch authentication or authorization code
# - Handle user input without sanitization
# - Use string concatenation for SQL queries
`,
    "utf-8",
  );

  // system-append.md — the most common override
  fs.writeFileSync(
    path.join(dirPath, "system-append.md.example"),
    `# System Prompt Append
#
# This content is appended to the END of the system prompt, regardless
# of whether you're using the built-in prompt or a custom system.md.
#
# This is the simplest way to customize Flaught's review behavior.
# Just add your team-specific rules and review focus areas below.
#
# Example:
# ## Team-Specific Rules
# - Flag any use of eval() or Function() — these are never allowed in our codebase
# - All API endpoints must validate input with a schema library (zod, joi, etc.)
# - Database queries must use parameterized statements, never string interpolation
# - Changes to middleware must include integration tests
`,
    "utf-8",
  );

  // user-append.md — the second most common override
  fs.writeFileSync(
    path.join(dirPath, "user-append.md"),
    `# User Prompt Append
#
# This content is appended to the END of the user prompt (after the diff
# and review instructions). Use it to add project-specific context that
# the reviewer should know about.
#
# Examples:
# - Architecture decisions ("We use event-sourcing; flag any direct DB writes")
# - Known tech debt areas ("The payments module is being rewritten; flag scope creep")
# - Team conventions ("We prefer composition over inheritance")
`,
    "utf-8",
  );

  // categories.md.example
  fs.writeFileSync(
    path.join(dirPath, "categories.md.example"),
    `# Categories Override
#
# This file replaces the categories section of the system prompt.
# The LLM is instructed to use exactly these categories.
#
# Default categories:
# {{categories}}
#
# Example — add domain-specific categories:
# CATEGORIES (use exactly these):
# - security: Vulnerabilities, injection, auth issues, data exposure
# - architecture: Coupling, abstraction problems, separation of concerns violations
# - scope-creep: Changes that don't serve the stated PR intent
# - test-quality: Missing tests, tests that don't verify the change, insufficient coverage
# - performance: Algorithmic concerns, N+1 queries, memory leaks
# - maintainability: Naming, documentation debt, confusing logic, dead code
# - compliance: HIPAA, PCI-DSS, SOC2, or regulatory violations
# - accessibility: A11y violations, missing ARIA labels, keyboard navigation issues
`,
    "utf-8",
  );

  // severity.md.example
  fs.writeFileSync(
    path.join(dirPath, "severity.md.example"),
    `# Severity Override
#
# This file replaces the severity definitions section of the system prompt.
#
# Default severities:
# {{severities}}
`,
    "utf-8",
  );

  // output-format.md.example
  fs.writeFileSync(
    path.join(dirPath, "output-format.md.example"),
    `# Output Format Override
#
# This file replaces the JSON output format specification.
# Only override this if you need the LLM to return findings in a
# different schema — the built-in parser expects the default format.
#
# Default format:
# {{output_format}}
`,
    "utf-8",
  );

  // constraints.md.example
  fs.writeFileSync(
    path.join(dirPath, "constraints.md.example"),
    `# Constraints Override
#
# This file replaces the IMPORTANT constraints section of the system prompt.
#
# Default constraints:
# IMPORTANT:
# - Rank findings within each severity tier. If you have 8 medium findings and the budget is 5, include only the 5 most important.
# - Every finding MUST have file, line_start, line_end, and snippet — no exceptions.
# - confidence is 0.0-1.0 — be honest. If you're guessing, say 0.4-0.5. If you're certain, say 0.9+.
# - Never fabricate code, line numbers, or file paths that don't exist in the provided context.
`,
    "utf-8",
  );

  return dirPath;
}