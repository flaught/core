/**
 * @flaught/core — Adversarial PR/code review tool.
 *
 * This is the library entry point. The CLI is in cli.ts.
 */

export { assembleContext, contextToJSON, type ReviewContext, type ReviewContextJSON, type ChangedFile, type ContextOptions } from "./context/assembler.js";
export { buildDependencyGraph, parseImports, type DependencyGraph, type ImportEntry } from "./context/neighborhood.js";
export { loadConfig, initConfig } from "./config.js";
export { FlaughtConfigSchema, type FlaughtConfig, mergeWithDefaults } from "./schemas/config.js";
export type { FindingsArtifact, Finding, Severity, Category, SourceType } from "./schemas/findings.js";
export { SCHEMA_VERSION, FINDINGS_SCHEMA_URL, CAVEAT } from "./schemas/findings.js";