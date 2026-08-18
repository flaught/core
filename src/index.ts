/**
 * @flaught/core — Adversarial PR/code review tool.
 *
 * This is the library entry point. The CLI is in cli.ts.
 */

export { assembleContext, contextToJSON, type ReviewContext, type ReviewContextJSON, type ChangedFile, type ContextOptions } from "./context/assembler.js";
export { buildDependencyGraph, parseImports, type DependencyGraph, type ImportEntry } from "./context/neighborhood.js";
export { loadConfig, initConfig } from "./config.js";
export { FlaughtConfigSchema, type FlaughtConfig, mergeWithDefaults } from "./schemas/config.js";
export type { FindingsArtifact, Finding, FindingEvidence, Severity, Category, SourceType, ToolExecuted, TestInversion, ScopeCreep, FlaggedTest, FlaggedHunk, SeverityBudget, NoiseBudget, FindingsSummary } from "./schemas/findings.js";
export { SCHEMA_VERSION, FINDINGS_SCHEMA_URL, CAVEAT } from "./schemas/findings.js";
export { createProvider, type LLMProvider, type LLMReviewResult, parseFindingsFromLLM } from "./llm/provider.js";
export { buildSystemPrompt, buildUserPrompt } from "./llm/prompt.js";
export { runReview, type ReviewResult, type ReviewOptions, type ProgressCallback } from "./review.js";
export { renderMarkdownReport } from "./report/markdown.js";
export { renderJsonArtifact } from "./report/json.js";
export { runDeterministicTools, formatToolFindingsForPrompt, type ToolResult, type DeterministicFinding } from "./tools/runner.js";
export { runTestInversion } from "./test-inversion/runner.js";
export { detectScopeCreepHeuristic, extractScopeCreepFromFindings, formatScopeCreepForPrompt } from "./scope-creep/detector.js";
export { DismissalEntrySchema, DismissalStoreSchema, type DismissalEntry, type DismissalStore, DISMISSAL_STORE_VERSION } from "./schemas/dismissals.js";
export { computeFingerprint, fingerprintFinding, type FingerprintInput } from "./dismissals/fingerprint.js";
export {
  loadDismissalStore,
  saveDismissalStore,
  addDismissal,
  removeDismissal,
  isExpired,
  findActiveDismissal,
  resolveDismissalsPath,
  DEFAULT_DISMISSALS_FILENAME,
} from "./dismissals/store.js";
export { applyDismissals, type ApplyDismissalsResult } from "./dismissals/apply.js";