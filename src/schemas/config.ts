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
    .default("openai"),
  model: z.string().default("gpt-4o"),
  api_key_env: z.string().default("OPENAI_API_KEY"),
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
});

// ─── Scope creep ───────────────────────────────────────────────────────────

const ScopeCreepSchema = z.object({
  enabled: z.boolean().default(true),
  intent_source: z
    .enum(["pr_description", "linked_issue", "both"])
    .default("pr_description"),
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