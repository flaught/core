/**
 * .advreview.yml config schema — validated with Zod.
 *
 * Design principles:
 * - Everything has sensible defaults; a repo can run with zero config
 * - Stack can be auto-detected or explicitly declared
 * - LLM provider is swappable via config/env with no code changes
 * - Tools can be toggled individually
 * - Noise budget caps are configurable but present by default
 */

import { z } from "zod";

// ─── Stack ──────────────────────────────────────────────────────────────────

const StackSchema = z.object({
  languages: z
    .union([z.literal("auto"), z.array(z.string())])
    .default("auto"),
  frameworks: z.array(z.string()).default([]),
  runtime: z
    .enum(["node", "python", "mixed", "auto"])
    .default("auto"),
});

// ─── LLM ───────────────────────────────────────────────────────────────────

const LlmSchema = z.object({
  provider: z
    .enum(["openai", "groq", "gemini", "ollama", "anthropic"])
    .default("groq"),
  model: z.string().default("groq/compound-mini"),
  api_key_env: z.string().default("GROQ_API_KEY"),
  base_url: z.string().nullable().default(null),
  temperature: z.number().min(0).max(1).default(0.2),
  max_tokens: z.number().int().positive().default(4096),
  timeout_seconds: z.number().int().positive().default(120),
});

// ─── Deterministic tools ───────────────────────────────────────────────────

const SemgrepConfigSchema = z.object({
  enabled: z.boolean().default(true),
  config: z.string().nullable().default(null),
});

const LinterConfigSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().nullable().default(null),
});

const VulnScannerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().nullable().default(null),
});

const ToolsSchema = z.object({
  semgrep: SemgrepConfigSchema.default({}),
  linter: LinterConfigSchema.default({}),
  vuln_scanner: VulnScannerConfigSchema.default({}),
});

// ─── Test inversion ────────────────────────────────────────────────────────

const TestInversionSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().nullable().default(null),
  /**
   * Only flag a "passes on both base and head" test if its file is one of
   * the changed files or in their one-hop dependency blast radius. Without
   * this, test inversion runs the whole suite and flags every test file the
   * diff didn't happen to touch — which is nearly the entire suite on any
   * small PR, and a different (so never-dismissable) subset on every PR.
   * Best-effort: when the test runner's output doesn't let us determine
   * which file a test belongs to (e.g. Go, Rust), that test is kept
   * unscoped rather than silently dropped.
   */
  scope_to_blast_radius: z.boolean().default(true),
  /**
   * Skip test inversion entirely when every changed file is documentation
   * (markdown/text, or a common extensionless doc file like README/LICENSE)
   * — no test can meaningfully "verify" a prose change, so running the whole
   * suite twice just to flag it as suspicious is pure noise. This also
   * sidesteps `scope_to_blast_radius`'s known gap: a slow test file that a
   * reporter expands into individual per-test lines (rather than one
   * per-file summary line) loses its file association, so those lines stay
   * unscoped even on a docs-only diff. Skipping the run outright avoids that
   * entirely, rather than relying on scoping to filter it after the fact.
   */
  skip_docs_only_diffs: z.boolean().default(true),
});

// ─── Scope creep ───────────────────────────────────────────────────────────

const ScopeCreepSchema = z.object({
  enabled: z.boolean().default(true),
  intent_source: z
    .enum(["pr_description", "linked_issue", "both"])
    .default("pr_description"),
  /**
   * Glob patterns for paths that are never scored as scope creep, regardless
   * of the PR's stated intent (e.g. an ADR that accompanies the change it
   * documents). Enforced both as prompt guidance to the LLM and as a
   * post-hoc filter on its findings, so it holds even if the LLM ignores the
   * guidance. Same `*`/`**` glob syntax as `exclude.paths`.
   */
  exclude_paths: z.array(z.string()).default([]),
});

// ─── Lighthouse ────────────────────────────────────────────────────────────

const LighthouseSchema = z.object({
  enabled: z.boolean().default(false),
  preview_url: z.string().nullable().default(null),
});

// ─── Noise budget ──────────────────────────────────────────────────────────

const NoiseBudgetSchema = z.object({
  critical: z.number().int().positive().default(5),
  high: z.number().int().positive().default(10),
  medium: z.number().int().positive().default(15),
  low: z.number().int().positive().default(20),
  info: z.number().int().positive().default(25),
});

// ─── Severity gate ─────────────────────────────────────────────────────────

const SeverityGateSchema = z.object({
  fail_on: z
    .enum(["none", "critical", "high", "medium"])
    .default("high"),
});

// ─── Dismissals ────────────────────────────────────────────────────────────

const DismissalsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Path to the dismissal store, relative to repo root. */
  path: z.string().default(".flaught-dismissals.json"),
});

// ─── Prompt templates ──────────────────────────────────────────────────────

const PromptSchema = z.object({
  /** Enable prompt template overrides from .flaught-prompt/ directory */
  enabled: z.boolean().default(true),
  /** Path to prompt templates directory, relative to repo root (or absolute) */
  path: z.string().default(".flaught-prompt"),
});

// ─── Exclusions ─────────────────────────────────────────────────────────────

const ExcludeSchema = z.object({
  paths: z.array(z.string()).default([
    "node_modules/**",
    "vendor/**",
    "**/*.min.js",
    "**/*.min.css",
    "**/*.generated.*",
  ]),
  patterns: z.array(z.string()).default([]),
});

// ─── Full config ────────────────────────────────────────────────────────────

export const FlaughtConfigSchema = z.object({
  version: z.number().default(1),
  stack: StackSchema.default({}),
  llm: LlmSchema.default({}),
  tools: ToolsSchema.default({}),
  test_inversion: TestInversionSchema.default({}),
  scope_creep: ScopeCreepSchema.default({}),
  lighthouse: LighthouseSchema.default({}),
  noise_budget: NoiseBudgetSchema.default({}),
  severity_gate: SeverityGateSchema.default({}),
  dismissals: DismissalsSchema.default({}),
  prompt: PromptSchema.default({}),
  exclude: ExcludeSchema.default({}),
});

export type FlaughtConfig = z.infer<typeof FlaughtConfigSchema>;

// ─── Config loader ──────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: FlaughtConfig = FlaughtConfigSchema.parse({});

export function mergeWithDefaults(
  raw: Record<string, unknown>,
): FlaughtConfig {
  return FlaughtConfigSchema.parse(raw);
}