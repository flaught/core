/**
 * Review orchestrator — ties context assembly, LLM provider, and report
 * rendering together into a complete adversarial review pipeline.
 */

// Read version from package.json — the compiled output is CJS, so require() works directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkgVersion: string = require("../package.json").version;

import * as fs from "node:fs";
import * as path from "node:path";
import { assembleContext, contextFromJSON, type ReviewContext, type ReviewContextJSON, type ChangedFile } from "./context/assembler.js";
import { loadConfig } from "./config.js";
import type { FlaughtConfig } from "./schemas/config.js";
import { createProvider, type LLMReviewResult } from "./llm/provider.js";
import { buildSystemPrompt, buildUserPromptWithCompleteness } from "./llm/prompt.js";
import { loadTemplates, type PromptTemplates } from "./prompt/templates.js";
import {
  type FindingsArtifact,
  type Finding,
  type NoiseBudget,
  type Severity,
  type ToolExecuted,
  type TestInversion,
  type ScopeCreep,
  type FlaggedHunk,
  type AnalysisCompleteness,
  SCHEMA_VERSION,
  FINDINGS_SCHEMA_URL,
  CAVEAT,
} from "./schemas/findings.js";
import { renderMarkdownReport } from "./report/markdown.js";
import { renderJsonArtifact } from "./report/json.js";
import { runDeterministicTools, formatToolFindingsForPrompt, type DeterministicFinding } from "./tools/runner.js";
import { runTestInversion } from "./test-inversion/runner.js";
import {
  detectScopeCreepHeuristic,
  extractScopeCreepFromFindings,
  formatScopeCreepForPrompt,
  filterExcludedScopeCreep,
  formatScopeCreepExclusionsForPrompt,
} from "./scope-creep/detector.js";
import { computeFingerprint } from "./dismissals/fingerprint.js";
import { loadDismissalStore, resolveDismissalsPath, getActiveDismissals } from "./dismissals/store.js";
import { applyDismissals } from "./dismissals/apply.js";
import type { DismissalStore } from "./schemas/dismissals.js";
import { runRefutePass } from "./refute/runner.js";
import { validateModelLiveness, ModelNotFoundError } from "./llm/liveness.js";

// ─── Progress callback ──────────────────────────────────────────────────────

export type ProgressCallback = (message: string) => void;

function noopProgress(_message: string) {}

// ─── Review result ──────────────────────────────────────────────────────────

export interface ReviewResult {
  /** The assembled context */
  context: ReviewContext;
  /** The LLM review result (null if LLM was skipped or failed) */
  llmResult: LLMReviewResult | null;
  /** Deterministic tool results */
  toolResults: ToolExecuted[];
  /** The full findings artifact */
  artifact: FindingsArtifact;
  /** Markdown report for PR comments */
  markdown: string;
  /** JSON artifact string */
  json: string;
  /** Exit code based on severity gate */
  exitCode: number;
  /** Duration of the review in seconds */
  durationSeconds: number;
  /** LLM error if the LLM call failed (review still completes with deterministic findings) */
  llmError: string | null;
  /**
   * Raw deterministic tool findings (pre-conversion). Populated so the
   * `--emit-context` bundle can carry them for the privileged half's LLM
   * grounding prompt (the converted Finding[] in the artifact loses the
   * structured vuln fields formatToolFindingsForPrompt needs). Null when not
   * applicable (e.g. --only-llm, which consumes rather than produces these).
   */
  deterministicFindings: DeterministicFinding[];
}

// ─── Run the full review ────────────────────────────────────────────────────

export interface ReviewOptions {
  repoPath?: string;
  baseRef?: string;
  headRef?: string;
  configPath?: string;
  prDescription?: string;
  /** Skip LLM review (context assembly only) */
  skipLlm?: boolean;
  /** Skip the skeptic/refute pass even if LLM review is enabled */
  skipRefute?: boolean;
  /**
   * Emit a context bundle for the fork-PR review split (core-8fz): skip the
   * noise budget so the partial findings artifact carries the FULL
   * deterministic + test-inversion set (un-truncated) for the privileged
   * `--only-llm` half to budget against the LLM findings. Used with --no-llm
   * + --emit-context.
   */
  emitBundle?: boolean;
  /** Progress callback for logging */
  onProgress?: ProgressCallback;
}

export async function runReview(options: ReviewOptions = {}): Promise<ReviewResult> {
  const progress = options.onProgress ?? noopProgress;
  const startTime = Date.now();

  // 1. Load config
  progress("Loading config...");
  const config = await loadConfig(options.configPath, options.repoPath);
  progress(`  Provider: ${config.llm.provider}/${config.llm.model}`);

  // 2. Assemble context
  progress("Assembling context (diff + dependency graph)...");
  const context = await assembleContext({
    repoPath: options.repoPath,
    baseRef: options.baseRef,
    headRef: options.headRef,
    configPath: options.configPath,
  });

  // 2a. Load the dismissal store up front — needed both to inject "known
  // non-issues" context into the LLM prompt (below) and, later, to apply
  // dismissals to the finished findings list (step 6c).
  const dismissalStore: DismissalStore | null = config.dismissals.enabled
    ? loadDismissalStore(resolveDismissalsPath(context.repoRoot, config.dismissals.path))
    : null;

  // 2b. Load prompt templates
  const templates = loadTemplates(context.repoRoot, config);
  const activeTemplates = Object.entries(templates)
    .filter(([, v]) => v !== null)
    .map(([k]) => k);
  if (activeTemplates.length > 0) {
    progress(`Loaded ${activeTemplates.length} prompt template override(s): ${activeTemplates.join(", ")}`);
  }

  progress(`  Base: ${context.baseSha.slice(0, 8)} → Head: ${context.headSha.slice(0, 8)}`);
  progress(`  Changed files: ${context.changedFiles.length}`);
  progress(`  Neighborhood (blast radius): ${context.neighborhoodFiles.length}`);
  progress(`  Dependency graph: ${context.dependencyGraph.getAllFiles().length} files`);

  if (context.changedFiles.length === 0) {
    progress("No changes detected. Nothing to review.");
  } else {
    for (const f of context.changedFiles) {
      const indicator =
        f.status === "added" ? "+" :
        f.status === "deleted" ? "-" :
        f.status === "renamed" ? "→" : "~";
      progress(`    ${indicator} ${f.path} (+${f.additions}/-${f.deletions})`);
    }
    if (context.neighborhoodFiles.length > 0) {
      progress("  Neighborhood files:");
      for (const f of context.neighborhoodFiles) {
        progress(`    ○ ${f}`);
      }
    }
  }

  // 3. Run deterministic tools (semgrep, linter, vuln scanner)
  let toolExecutions: ToolExecuted[] = [];
  let deterministicFindings: DeterministicFinding[] = [];
  let scopeCreepHeuristic: FlaggedHunk[] = [];

  if (context.changedFiles.length > 0) {
    const anyToolEnabled = config.tools.semgrep.enabled || config.tools.linter.enabled || config.tools.vuln_scanner.enabled;
    if (anyToolEnabled) {
      progress("Running deterministic tools...");
      const toolResult = await runDeterministicTools(config, context.repoRoot, progress);
      toolExecutions = toolResult.executions;
      deterministicFindings = toolResult.findings;
    } else {
      progress("Deterministic tools disabled in config — skipping.");
    }
  }

  // 3b. Heuristic scope-creep pre-filter (runs before LLM so it can be injected into the prompt)
  if (context.changedFiles.length > 0 && config.scope_creep.enabled) {
    scopeCreepHeuristic = detectScopeCreepHeuristic(context, options.prDescription, config);
  }

  // 4. Run LLM review
  let llmResult: LLMReviewResult | null = null;
  let llmError: string | null = null;
  let analysisCompleteness: AnalysisCompleteness | null = null;
  let findings: Finding[] = [];
  let droppedBelowMinConfidence = 0;

  // Convert deterministic findings to Finding format
  for (const df of deterministicFindings) {
    const ruleId = df.ruleId !== "unknown" ? df.ruleId : null;
    const severity = (["critical", "high", "medium", "low", "info"].includes(df.severity) ? df.severity : "medium") as Severity;
    const category = (["security", "architecture", "scope-creep", "test-quality", "performance", "maintainability"].includes(df.category) ? df.category : "maintainability") as Finding["category"];
    const evidence = {
      file: df.file,
      line_start: df.line,
      line_end: df.line,
      snippet: df.snippet,
      blast_radius: [],
      rule_id: ruleId,
    };

    // Build description: for vulnerability findings, use the rich vuln_description;
    // for all others, fall back to the generic format.
    // vuln_description already includes dependency path, fix info, etc.
    // — only add version range and CVSS if they aren't already in vuln_description.
    let description: string;
    if (df.vuln_description) {
      const parts: string[] = [df.vuln_description];
      if (df.vuln_range && !df.vuln_description.includes(df.vuln_range)) parts.push(`Affected versions: ${df.vuln_range}.`);
      if (df.vuln_cvss_score && df.vuln_cvss_score > 0 && !df.vuln_description.includes("CVSS")) parts.push(`CVSS score: ${df.vuln_cvss_score}.`);
      description = parts.join(" ");
    } else {
      description = `${df.source} found: ${df.title}${ruleId ? ` (${ruleId})` : ""}`;
    }

    // Collect references: merge reference + vuln_urls, deduplicated
    const references: string[] = [];
    const seenRefs = new Set<string>();
    if (df.reference) {
      references.push(df.reference);
      seenRefs.add(df.reference);
    }
    if (df.vuln_urls) {
      for (const url of df.vuln_urls) {
        if (!seenRefs.has(url)) {
          references.push(url);
          seenRefs.add(url);
        }
      }
    }

    findings.push({
      id: `D-${String(findings.length + 1).padStart(4, "0")}`,
      severity,
      category,
      title: df.title,
      description,
      evidence,
      source: df.source,
      source_type: "deterministic",
      confidence: 1.0, // deterministic tools get full confidence
      references,
      fingerprint: computeFingerprint({
        source_type: "deterministic",
        source: df.source,
        category,
        title: df.title,
        evidence: { file: evidence.file, rule_id: ruleId },
      }),
      dismissed: false,
      dismissed_by: null,
      dismissed_at: null,
      dismissal_reason: null,
      refute_result: null, // deterministic findings are ground truth — not refuted
    });
  }

  if (options.skipLlm) {
    progress("Skipping LLM review (--no-llm).");
  } else if (context.changedFiles.length === 0) {
    progress("No changes to review — skipping LLM call.");
  } else {
    // LLM adversarial review + refute/skeptic pass. Extracted into runLlmStage
    // so the same code path backs both the live-checkout review and the
    // artifact-driven `flaught review --only-llm` half of the fork-PR split
    // (core-8fz): the LLM pass only needs the assembled context + deterministic
    // findings, never the git checkout itself.
    const llmStage = await runLlmStage({
      context,
      deterministicFindings,
      scopeCreepHeuristic,
      config,
      templates,
      dismissalStore,
      prDescription: options.prDescription,
      skipRefute: options.skipRefute,
      onProgress: progress,
    });
    llmResult = llmStage.llmResult;
    llmError = llmStage.llmError;
    analysisCompleteness = llmStage.completeness;
    droppedBelowMinConfidence = llmStage.droppedBelowMinConfidence;
    findings.push(...llmStage.llmFindings);
  }

  // 5. Test inversion
  let testInversion: TestInversion | null = null;

  const docsOnlyDiff = config.test_inversion.skip_docs_only_diffs && isDocsOnlyDiff(context.changedFiles);

  if (docsOnlyDiff) {
    progress("  All changed files are documentation — skipping test inversion (no code for a test to verify).");
  } else if (context.changedFiles.length > 0 && config.test_inversion.enabled) {
    progress("Running test inversion (pre/post change test comparison)...");
    const relevantFiles = new Set<string>([
      ...context.changedFiles.map((f) => f.path),
      ...context.neighborhoodFiles,
    ]);
    testInversion = await runTestInversion(
      config,
      context.repoRoot,
      context.baseSha,
      context.headSha,
      relevantFiles,
      progress,
    );

    if (testInversion && testInversion.flagged.length > 0) {
      // Convert flagged tests to findings
      for (const ft of testInversion.flagged) {
        const title = `Test doesn't verify the change: ${ft.test}`;
        const evidence = {
          file: "",
          line_start: 0,
          line_end: 0,
          snippet: "",
          blast_radius: [],
          rule_id: null,
        };

        findings.push({
          id: `F-${String(findings.length + 1).padStart(4, "0")}`,
          severity: "medium",
          category: "test-quality",
          title,
          description: ft.reason,
          evidence,
          source: "test-inversion",
          source_type: "deterministic",
          confidence: 1.0,
          references: [],
          fingerprint: computeFingerprint({
            source_type: "deterministic",
            source: "test-inversion",
            category: "test-quality",
            title,
            evidence: { file: evidence.file, rule_id: null },
          }),
          dismissed: false,
          dismissed_by: null,
          dismissed_at: null,
          dismissal_reason: null,
          refute_result: null, // test-inversion findings are deterministic — not refuted
        });
      }
      progress(`  ⚠ ${testInversion.flagged.length} test(s) pass on both base and head`);
    }
  } else if (!config.test_inversion.enabled) {
    progress("Test inversion disabled in config — skipping.");
  }

  // 6. Scope-creep detection
  let scopeCreepResult: ScopeCreep | null = null;

  if (context.changedFiles.length > 0 && config.scope_creep.enabled) {
    progress("Checking for scope creep...");

    // Enforcement backstop: strip any scope-creep finding on an exempt path,
    // regardless of whether the LLM honored the prompt-level guidance above.
    if (config.scope_creep.exclude_paths.length > 0) {
      const beforeCount = findings.length;
      findings = filterExcludedScopeCreep(findings, config.scope_creep.exclude_paths);
      if (findings.length < beforeCount) {
        progress(`  Filtered ${beforeCount - findings.length} scope-creep finding(s) on exempt path(s)`);
      }
    }

    // Heuristic results were already computed before the LLM call
    // (they're in scopeCreepHeuristic)
    const llmScopeCreep = extractScopeCreepFromFindings(findings, options.prDescription);

    // Merge: heuristic findings + LLM findings
    const allFlagged: FlaggedHunk[] = [...scopeCreepHeuristic];

    if (llmScopeCreep) {
      // Add LLM findings that aren't already covered by heuristics
      const heuristicFiles = new Set(scopeCreepHeuristic.map((h) => h.file));
      for (const hunk of llmScopeCreep.flagged_hunks) {
        if (!heuristicFiles.has(hunk.file)) {
          allFlagged.push(hunk);
        }
      }
    }

    if (allFlagged.length > 0) {
      scopeCreepResult = {
        pr_intent: options.prDescription ?? "No PR description provided",
        flagged_hunks: allFlagged,
      };
      progress(`  ⚠ ${allFlagged.length} hunks flagged as potential scope creep`);
      for (const h of allFlagged) {
        progress(`    - ${h.file} (${h.lines}): ${h.reason.substring(0, 60)}${h.reason.length > 60 ? "..." : ""}`);
      }
    } else {
      progress("  No scope creep detected");
    }
  } else if (!config.scope_creep.enabled) {
    progress("Scope-creep detection disabled in config — skipping.");
  }

  // 6c. Apply persisted dismissals (fingerprint-matched, before noise budget so a
  // re-surfaced dismissed finding never crowds out a genuinely new one)
  if (dismissalStore) {
    const applied = applyDismissals(findings, dismissalStore);
    findings = applied.findings;
    if (applied.appliedCount > 0) {
      progress(`  ${applied.appliedCount} finding(s) auto-dismissed via ${config.dismissals.path}`);
    }
  }

  // 7. Enforce noise budget.
  // Skipped in emitBundle mode (the unprivileged half of the fork-PR split):
  // the partial findings artifact must carry the FULL deterministic +
  // test-inversion set un-truncated, so the privileged --only-llm half can
  // budget them against the LLM findings (matching the monolithic path, which
  // budgets once on the complete set). Dismissals still apply (idempotent).
  if (!options.emitBundle) {
    findings = enforceNoiseBudget(findings, config);
  } else {
    progress("Skipping noise budget (emit-bundle mode) — the privileged half budgets the full set.");
  }

  if (!options.emitBundle && findings.length > 0) {
    progress(`  After noise budget: ${findings.length} findings`);
    const bySev: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const f of findings) {
      bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
      bySource[f.source_type] = (bySource[f.source_type] ?? 0) + 1;
    }
    const sevSummary = Object.entries(bySev).map(([sev, count]) => `${count} ${sev}`).join(", ");
    const srcSummary = Object.entries(bySource).map(([src, count]) => `${count} ${src}`).join(", ");
    progress(`  Breakdown: ${sevSummary} (${srcSummary})`);
  }

  // 8. Build the findings artifact
  progress("Building findings artifact...");
  const artifact = buildArtifact(context, findings, config, droppedBelowMinConfidence);
  artifact.tools_executed = toolExecutions;
  artifact.test_inversion = testInversion;
  artifact.scope_creep = scopeCreepResult;
  artifact.analysis_completeness = analysisCompleteness;

  // Record the PR description on the artifact so the privileged half of the
  // fork-PR split (--only-llm) can recover the scope-creep intent anchor from
  // the partial findings artifact without a separate bundle field.
  artifact.pull_request.description = options.prDescription ?? null;

  // Record LLM error in the artifact if the LLM call failed
  if (llmError) {
    artifact.run.llm_error = llmError;
  }

  // 9. Render reports
  progress("Rendering reports...");
  const markdown = renderMarkdownReport(artifact);
  const json = renderJsonArtifact(artifact);

  // 10. Determine exit code
  const exitCode = computeExitCode(artifact, config);

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);
  artifact.run.duration_seconds = durationSeconds;
  progress(`Done in ${durationSeconds}s.`);

  return {
    context,
    llmResult,
    toolResults: toolExecutions,
    artifact,
    markdown,
    json,
    exitCode,
    durationSeconds,
    llmError: llmError,
    deterministicFindings,
  };
}

// ─── LLM review + refute stage (decoupled from the checkout) ───────────────

export interface LlmStageInput {
  /** Assembled review context — from a live checkout OR a context artifact. */
  context: ReviewContext;
  /** Deterministic tool findings, to ground the LLM prompt. */
  deterministicFindings: DeterministicFinding[];
  /** Heuristic scope-creep hunks, injected into the prompt. */
  scopeCreepHeuristic: FlaggedHunk[];
  config: FlaughtConfig;
  templates: PromptTemplates;
  /** Dismissal store (for injecting active dismissals into the prompt). */
  dismissalStore: DismissalStore | null;
  /** PR title/body, the scope-creep intent anchor. */
  prDescription?: string;
  /** Skip the skeptic/refute pass even if LLM review succeeds. */
  skipRefute?: boolean;
  onProgress?: ProgressCallback;
}

export interface LlmStageResult {
  /** LLM findings with refute_result applied (refuted, or null if skipped/failed). */
  llmFindings: Finding[];
  /** Raw LLM review result, or null if the call failed. */
  llmResult: LLMReviewResult | null;
  /** Error message if the LLM call or refute pass failed; null otherwise. */
  llmError: string | null;
  /** Whether the LLM received the full change context or some was truncated to fit the prompt cap. Null is impossible here (the prompt is always built), but typed nullable for the caller's union with the skip-LLM path. */
  completeness: AnalysisCompleteness;
  droppedBelowMinConfidence: number;
}

/**
 * LLM adversarial review + refute/skeptic pass, decoupled from context assembly
 * and the git checkout.
 *
 * This is the privileged half of the fork-PR review split (core-8fz): it takes
 * an already-assembled `ReviewContext` (loaded from a context artifact by
 * `flaught review --only-llm --context <path>`) plus the deterministic findings
 * that ground the prompt, calls the LLM, and runs the skeptic pass. It never
 * touches the repo — the diff and file contents arrive as DATA on `context`,
 * so the fork's code is never executed in the privileged workflow.
 *
 * The same function backs the monolithic `flaught review` path, so both the
 * live-checkout and artifact-driven reviews share one LLM+refute code path.
 *
 * Returns the LLM findings (refute_result applied) separately from any
 * deterministic findings — the caller decides where to merge them.
 */
export async function runLlmStage(input: LlmStageInput): Promise<LlmStageResult> {
  const progress = input.onProgress ?? noopProgress;
  const { context, deterministicFindings, scopeCreepHeuristic, config, templates, dismissalStore, prDescription, skipRefute } = input;

  // Pre-flight: validate that the configured model exists on the provider
  progress("Validating model liveness...");
  try {
    const liveness = await validateModelLiveness(config);
    progress(`  Model ${liveness.provider}/${liveness.model} is available`);
  } catch (err) {
    if (err instanceof ModelNotFoundError) {
      progress(`  ⚠ Model not found: ${err.model}`);
      // Re-throw with the clear message — this is a hard stop, not a warning
      throw err;
    }
    // Liveness check failures (network, etc.) are warnings, not hard stops
    progress(`  ⚠ Could not validate model liveness: ${err instanceof Error ? err.message : String(err)}`);
    progress(`  Continuing — if the model is also unavailable, the review call will fail with a clear error.`);
  }

  const provider = createProvider(config);
  const systemPrompt = buildSystemPrompt(config, templates);
  const activeDismissals = dismissalStore ? getActiveDismissals(dismissalStore) : [];
  const { prompt: userPrompt, completeness } = buildUserPromptWithCompleteness(context, config, prDescription, templates, activeDismissals);

  // Inject deterministic tool findings into the prompt
  const toolContext = formatToolFindingsForPrompt(deterministicFindings);

  // Inject scope-creep heuristic findings into the prompt (pre-computed before LLM call)
  const scopeCreepContext = formatScopeCreepForPrompt(
    scopeCreepHeuristic.length > 0
      ? { pr_intent: prDescription ?? "No PR description provided", flagged_hunks: scopeCreepHeuristic }
      : null,
  );

  // Tell the LLM up front which paths are exempt from scope-creep scoring
  // (e.g. an ADR accompanying the change it documents) — filterExcludedScopeCreep
  // in the caller is the enforcement backstop if it ignores this.
  const scopeCreepExclusionsContext = formatScopeCreepExclusionsForPrompt(config.scope_creep.exclude_paths);

  let fullUserPrompt = userPrompt;
  if (toolContext) {
    fullUserPrompt = `${fullUserPrompt}\n\n---\n\n${toolContext}`;
  }
  if (scopeCreepContext) {
    fullUserPrompt = `${fullUserPrompt}\n\n---\n\n${scopeCreepContext}`;
  }
  if (scopeCreepExclusionsContext) {
    fullUserPrompt = `${fullUserPrompt}\n\n---\n\n${scopeCreepExclusionsContext}`;
  }

  const promptChars = systemPrompt.length + fullUserPrompt.length;
  const promptTokensEst = Math.round(promptChars / 4);
  progress(`Running adversarial review with ${config.llm.provider}/${config.llm.model}...`);
  progress(`  Prompt size: ~${promptTokensEst.toLocaleString()} tokens (${promptChars.toLocaleString()} chars)`);
  if (deterministicFindings.length > 0) {
    progress(`  Grounding with ${deterministicFindings.length} deterministic tool findings`);
  }

  let llmResult: LLMReviewResult | null = null;
  let llmError: string | null = null;
  let llmFindings: Finding[] = [];
  let droppedBelowMinConfidence = 0;

  // ── LLM review ──
  // If the LLM call fails, we gracefully degrade: return no LLM findings;
  // the caller still has its deterministic findings to write the artifact.
  try {
    llmResult = await provider.review(systemPrompt, fullUserPrompt);
    llmFindings = [...llmResult.findings];
    if (config.llm.min_confidence > 0) {
      const before = llmFindings.length;
      llmFindings = filterFindingsByConfidence(llmFindings, config.llm.min_confidence);
      droppedBelowMinConfidence = before - llmFindings.length;
    }

    if (llmResult.usage) {
      progress(`  Token usage: ${llmResult.usage.prompt_tokens.toLocaleString()} prompt + ${llmResult.usage.completion_tokens.toLocaleString()} completion = ${llmResult.usage.total_tokens.toLocaleString()} total`);
    }

    progress(`  LLM found ${llmResult.findings.length} findings`);
  } catch (err) {
    llmError = err instanceof Error ? err.message : String(err);
    progress(`  ⚠ LLM review failed: ${llmError}`);
    progress(`  Continuing with deterministic findings only.`);
    llmResult = null;
  }

  // ── Refute pass: the skeptic challenges each LLM finding ──
  // Only run if the LLM succeeded and produced findings. The skeptic only ever
  // touches LLM findings, so we pass just the LLM subset (deterministic findings
  // are ground truth and stay with the caller).
  if (llmError) {
    progress("Skipping refute pass — LLM review failed.");
  } else if (skipRefute) {
    progress("Refute pass skipped (--no-refute).");
    llmFindings = llmFindings.map((f) => ({ ...f, refute_result: null }));
  } else if (config.refute.enabled && llmFindings.length > 0) {
    // If the skeptic call itself fails (400, timeout, etc.), keep the findings
    // from the LLM pass that already succeeded rather than losing them —
    // just leave them un-refuted.
    try {
      const refuteResult = await runRefutePass(
        llmFindings,
        context,
        config,
        templates,
        progress,
      );
      llmFindings = refuteResult.findings.filter((f) => f.source_type === "llm");
      progress(`  Refute model: ${refuteResult.model}`);
      if (refuteResult.usage) {
        progress(`  Refute tokens: ${refuteResult.usage.prompt_tokens.toLocaleString()} prompt + ${refuteResult.usage.completion_tokens.toLocaleString()} completion = ${refuteResult.usage.total_tokens.toLocaleString()} total`);
      }
    } catch (err) {
      llmError = `Refute (skeptic) pass failed: ${err instanceof Error ? err.message : String(err)}`;
      progress(`  ⚠ ${llmError}`);
      progress(`  Continuing with un-refuted LLM findings.`);
      llmFindings = llmFindings.map((f) => ({ ...f, refute_result: null }));
    }
  } else if (!config.refute.enabled) {
    progress("Refute pass disabled in config — skipping skeptic.");
  } else {
    progress("No LLM findings to refute — skipping skeptic pass.");
  }

  return { llmFindings, llmResult, llmError, completeness, droppedBelowMinConfidence };
}

// ─── Review bundle (context artifact for the fork-PR split) ──────────────────

/**
 * The artifact written by `flaught review --emit-context` and read by
 * `flaught review --only-llm --context`. Carries the serialized review context
 * (diff + file contents + dependency graph, as data) plus the RAW deterministic
 * tool findings, so the privileged half can ground the LLM prompt without a
 * git checkout. The converted Finding[] live in the separate findings.json
 * artifact; only the raw DeterministicFinding[] (with structured vuln fields)
 * need to ride along here, because formatToolFindingsForPrompt uses them.
 */
export interface ReviewBundleJSON {
  context: ReviewContextJSON;
  deterministicFindings: DeterministicFinding[];
}

// ─── Untrusted-artifact guards (the privileged half treats the bundle as data
//     from a potentially-malicious fork; bound CPU/memory against DoS) ───────

const MAX_DIFF_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_FILE_CONTENT_BYTES = 16 * 1024 * 1024; // 16 MiB per file
const MAX_TOTAL_CONTENT_BYTES = 64 * 1024 * 1024; // 64 MiB across all files
const MAX_FILES = 5000;

/**
 * Load + validate a context bundle from disk. The bundle is untrusted data in
 * the fork-PR split (a malicious fork controls the file contents that become
 * changedFileContents), so this enforces shape + size caps before the
 * privileged half spends CPU rebuilding the dependency graph or handing the
 * contents to the LLM. Throws a clear error on any violation.
 */
function loadReviewBundle(contextPath: string): ReviewBundleJSON {
  let raw: string;
  try {
    raw = fs.readFileSync(contextPath, "utf-8");
  } catch (err) {
    throw new Error(`Could not read context artifact at ${contextPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Context artifact at ${contextPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateReviewBundle(json, contextPath);
}

function validateReviewBundle(json: unknown, source: string): ReviewBundleJSON {
  if (typeof json !== "object" || json === null) {
    throw new Error(`Context artifact at ${source} is not an object.`);
  }
  const b = json as Record<string, unknown>;
  if (typeof b.context !== "object" || b.context === null) {
    throw new Error(`Context artifact at ${source} is missing the 'context' object.`);
  }
  if (!Array.isArray(b.deterministicFindings)) {
    throw new Error(`Context artifact at ${source}: 'deterministicFindings' is not an array.`);
  }

  const c = b.context as Record<string, unknown>;
  if (typeof c.diff !== "string") {
    throw new Error(`Context artifact at ${source}: 'context.diff' is not a string.`);
  }
  if (Buffer.byteLength(c.diff) > MAX_DIFF_BYTES) {
    throw new Error(`Context artifact at ${source}: diff exceeds ${MAX_DIFF_BYTES} bytes (possible DoS); rejected.`);
  }
  if (!Array.isArray(c.changedFiles) || !Array.isArray(c.neighborhoodFiles)) {
    throw new Error(`Context artifact at ${source}: 'context.changedFiles'/'neighborhoodFiles' must be arrays.`);
  }
  if (typeof c.changedFileContents !== "object" || c.changedFileContents === null ||
      typeof c.neighborhoodFileContents !== "object" || c.neighborhoodFileContents === null) {
    throw new Error(`Context artifact at ${source}: 'context.*FileContents' must be objects.`);
  }
  if (typeof c.baseSha !== "string" || typeof c.headSha !== "string" || typeof c.repoRoot !== "string") {
    throw new Error(`Context artifact at ${source}: 'context.baseSha'/'headSha'/'repoRoot' must be strings.`);
  }
  if (typeof c.dependencyGraph !== "object" || c.dependencyGraph === null) {
    throw new Error(`Context artifact at ${source}: 'context.dependencyGraph' must be an object.`);
  }

  const changedEntries = Object.entries(c.changedFileContents);
  const neighEntries = Object.entries(c.neighborhoodFileContents);
  if (changedEntries.length + neighEntries.length > MAX_FILES) {
    throw new Error(`Context artifact at ${source}: exceeds ${MAX_FILES} files (possible DoS); rejected.`);
  }
  let total = 0;
  for (const [k, v] of [...changedEntries, ...neighEntries]) {
    if (typeof v !== "string") {
      throw new Error(`Context artifact at ${source}: file content for '${String(k)}' is not a string.`);
    }
    const size = Buffer.byteLength(v);
    if (size > MAX_FILE_CONTENT_BYTES) {
      throw new Error(`Context artifact at ${source}: file '${String(k)}' exceeds ${MAX_FILE_CONTENT_BYTES} bytes; rejected.`);
    }
    total += size;
  }
  if (total > MAX_TOTAL_CONTENT_BYTES) {
    throw new Error(`Context artifact at ${source}: total file contents exceed ${MAX_TOTAL_CONTENT_BYTES} bytes (possible DoS); rejected.`);
  }

  return { context: c as unknown as ReviewContextJSON, deterministicFindings: b.deterministicFindings as DeterministicFinding[] };
}

// ─── --only-llm: the privileged half of the fork-PR split ─────────────────────

export interface OnlyLlmOptions {
  /** Path to the context bundle written by `flaught review --emit-context`. */
  contextPath: string;
  /** Path to the partial findings artifact written by `flaught review --output`. */
  findingsPath: string;
  /** Path to .advreview.yml in the trusted (base-branch) checkout. */
  configPath?: string;
  /** Repository root of the trusted checkout (for config/dismissal-store/template resolution). */
  repoPath?: string;
  /** Skip the skeptic/refute pass even if LLM review succeeds. */
  skipRefute?: boolean;
  onProgress?: ProgressCallback;
}

/**
 * Run ONLY the LLM adversarial review + refute pass against a context artifact,
 * then finalize the findings (scope-creep enforcement, dismissals, noise budget)
 * and render reports. This is the privileged half of the fork-PR review split
 * (core-8fz): it reads the diff + file contents as DATA from the context bundle
 * and never touches a git checkout of the fork's code. Config and the dismissal
 * store come from a trusted base-branch checkout (repoPath), not the fork.
 *
 * Returns the same ReviewResult shape as runReview so the CLI handles both
 * paths uniformly.
 */
export async function runReviewOnlyLlm(options: OnlyLlmOptions): Promise<ReviewResult> {
  const progress = options.onProgress ?? noopProgress;
  const startTime = Date.now();

  // 1. Load the context bundle (context + raw deterministic findings) as data.
  //    Validated + size-capped by loadReviewBundle: the bundle is untrusted in
  //    the fork-PR model (a malicious fork controls the file contents), so we
  //    bound CPU/memory before rebuilding the dependency graph or calling the LLM.
  progress("Loading review context artifact...");
  const bundle = loadReviewBundle(options.contextPath);
  const context = contextFromJSON(bundle.context);

  // 2. Load the partial findings artifact (deterministic + test-inversion, un-budgeted).
  progress("Loading deterministic findings artifact...");
  let partial: FindingsArtifact;
  try {
    partial = JSON.parse(fs.readFileSync(options.findingsPath, "utf-8")) as FindingsArtifact;
  } catch (err) {
    throw new Error(`Could not read findings artifact at ${options.findingsPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Load config + dismissal store from the TRUSTED checkout (not the fork).
  // repoPath defaults to cwd (the privileged workflow's main checkout).
  const repoRoot = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
  progress("Loading config...");
  const config = await loadConfig(options.configPath, repoRoot);
  progress(`  Provider: ${config.llm.provider}/${config.llm.model}`);
  const dismissalStore: DismissalStore | null = config.dismissals.enabled
    ? loadDismissalStore(resolveDismissalsPath(repoRoot, config.dismissals.path))
    : null;
  const templates = loadTemplates(repoRoot, config);

  // 4. Recover the inputs runLlmStage needs from the artifacts.
  const deterministicFindings: DeterministicFinding[] = bundle.deterministicFindings ?? [];
  const scopeCreepHeuristic: FlaggedHunk[] = partial.scope_creep?.flagged_hunks ?? [];
  const prDescription = partial.pull_request?.description ?? undefined;

  // 5. Start from the partial findings (deterministic + test-inversion).
  let findings: Finding[] = [...partial.findings];

  // 6. Run the LLM adversarial + refute pass (shared with the monolithic path).
  const llmStage = await runLlmStage({
    context,
    deterministicFindings,
    scopeCreepHeuristic,
    config,
    templates,
    dismissalStore,
    prDescription,
    skipRefute: options.skipRefute,
    onProgress: progress,
  });

  // 7. Merge the LLM findings into the deterministic/test-inversion set.
  findings.push(...llmStage.llmFindings);

  // 8. Scope-creep enforcement: strip any LLM scope-creep finding on an exempt path
  //    (the heuristic backstop the LLM is told about up front but may ignore).
  if (context.changedFiles.length > 0 && config.scope_creep.enabled && config.scope_creep.exclude_paths.length > 0) {
    const before = findings.length;
    findings = filterExcludedScopeCreep(findings, config.scope_creep.exclude_paths);
    if (findings.length < before) {
      progress(`  Filtered ${before - findings.length} scope-creep finding(s) on exempt path(s)`);
    }
  }

  // 9. Merge LLM-detected scope creep into the scope-creep result (heuristic + LLM).
  let scopeCreepResult: ScopeCreep | null = partial.scope_creep;
  if (context.changedFiles.length > 0 && config.scope_creep.enabled) {
    const llmScopeCreep = extractScopeCreepFromFindings(findings, prDescription);
    const heuristicFiles = new Set(scopeCreepHeuristic.map((h) => h.file));
    const allFlagged: FlaggedHunk[] = [...scopeCreepHeuristic];
    if (llmScopeCreep) {
      for (const hunk of llmScopeCreep.flagged_hunks) {
        if (!heuristicFiles.has(hunk.file)) allFlagged.push(hunk);
      }
    }
    scopeCreepResult = allFlagged.length > 0
      ? { pr_intent: prDescription ?? "No PR description provided", flagged_hunks: allFlagged }
      : null;
  }

  // 10. Apply persisted dismissals (fingerprint-matched) across the full set.
  if (dismissalStore) {
    const applied = applyDismissals(findings, dismissalStore);
    findings = applied.findings;
    if (applied.appliedCount > 0) {
      progress(`  ${applied.appliedCount} finding(s) auto-dismissed via ${config.dismissals.path}`);
    }
  }

  // 11. Enforce the noise budget on the COMPLETE set (deterministic + test-inversion + LLM),
  //     matching the monolithic path. (The unprivileged half skipped this on purpose.)
  findings = enforceNoiseBudget(findings, config);
  if (findings.length > 0) {
    progress(`  After noise budget: ${findings.length} findings`);
  }

  // 12. Re-id findings for a clean, collision-free artifact. The partial artifact
  //     already assigned D-/F- ids to deterministic/test-inversion findings, and
  //     the LLM provider assigned F- ids to its findings, so the merged set can
  //     collide. Re-id by source_type (deterministic -> D-, llm -> F-); ids are
  //     run-local display only — the fingerprint is the stable identity.
  let dIdx = 0;
  let fIdx = 0;
  findings = findings.map((f) => ({
    ...f,
    id: f.source_type === "llm" ? `F-${String(++fIdx).padStart(4, "0")}` : `D-${String(++dIdx).padStart(4, "0")}`,
  }));

  // 13. Build the final artifact, carrying forward the partial's tool/test-inversion metadata.
  progress("Building findings artifact...");
  const artifact = buildArtifact(context, findings, config);
  artifact.tools_executed = partial.tools_executed;
  artifact.test_inversion = partial.test_inversion;
  artifact.scope_creep = scopeCreepResult;
  artifact.pull_request = partial.pull_request;
  artifact.analysis_completeness = llmStage.completeness;
  if (llmStage.llmError) {
    artifact.run.llm_error = llmStage.llmError;
  }

  // 14. Render reports + exit code.
  progress("Rendering reports...");
  const markdown = renderMarkdownReport(artifact);
  const json = renderJsonArtifact(artifact);
  const exitCode = computeExitCode(artifact, config);

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);
  artifact.run.duration_seconds = durationSeconds;
  progress(`Done in ${durationSeconds}s.`);

  return {
    context,
    llmResult: llmStage.llmResult,
    toolResults: partial.tools_executed,
    artifact,
    markdown,
    json,
    exitCode,
    durationSeconds,
    llmError: llmStage.llmError,
    deterministicFindings,
  };
}

/** Apply the optional confidence floor to parsed findings and preserve deterministic findings. */
export function filterFindingsByConfidence(findings: Finding[], minConfidence: number): Finding[] {
  if (minConfidence <= 0) return findings;
  return findings.filter((finding) =>
    finding.source_type === "deterministic" || finding.confidence >= minConfidence,
  );
}

// ─── Noise budget enforcement ───────────────────────────────────────────────

function enforceNoiseBudget(findings: Finding[], config: FlaughtConfig): Finding[] {
  const severityOrder: Severity[] = ["critical", "high", "medium", "low", "info"];
  const budget = config.noise_budget;

  // Dismissed findings are already-handled disposition, not noise — they don't
  // consume a budget slot, so a stale dismissal can't crowd out a new finding.
  const dismissed = findings.filter((f) => f.dismissed);
  const active = findings.filter((f) => !f.dismissed);

  const result: Finding[] = [];
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  // Sort by severity (critical first), then by confidence (high first)
  const sorted = [...active].sort((a, b) => {
    const severityDiff = severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity);
    if (severityDiff !== 0) return severityDiff;
    return b.confidence - a.confidence;
  });

  for (const finding of sorted) {
    const limit = budget[finding.severity];
    if (counts[finding.severity] < limit) {
      result.push(finding);
      counts[finding.severity]++;
    }
  }

  return [...result, ...dismissed];
}

// ─── Build the findings artifact ────────────────────────────────────────────

function buildArtifact(
  context: ReviewContext,
  findings: Finding[],
  config: FlaughtConfig,
  droppedBelowMinConfidence = 0,
): FindingsArtifact {
  const bySeverity: Record<Severity, number> = {
    critical: 0, high: 0, medium: 0, low: 0, info: 0,
  };
  const bySourceType: Record<string, number> = { deterministic: 0, llm: 0 };
  const byCategory: Record<string, number> = {};

  for (const f of findings) {
    bySeverity[f.severity]++;
    bySourceType[f.source_type] = (bySourceType[f.source_type] ?? 0) + 1;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  }

  const dismissedCount = findings.filter((f) => f.dismissed).length;

  const noiseBudget: NoiseBudget = {
    critical: { limit: config.noise_budget.critical, used: bySeverity.critical },
    high: { limit: config.noise_budget.high, used: bySeverity.high },
    medium: { limit: config.noise_budget.medium, used: bySeverity.medium },
    low: { limit: config.noise_budget.low, used: bySeverity.low },
    info: { limit: config.noise_budget.info, used: bySeverity.info },
  };

  const repoName = context.repoRoot.split("/").pop() ?? "unknown";

  const artifact: FindingsArtifact = {
    $schema: FINDINGS_SCHEMA_URL,
    schema_version: SCHEMA_VERSION,
    _caveat: CAVEAT,
    generated_at: new Date().toISOString(),
    flaught_version: pkgVersion,
    repository: {
      name: repoName,
      url: "",
      branch: "",
    },
    pull_request: {
      number: null,
      url: null,
      title: null,
      description: null,
      base_sha: context.baseSha,
      head_sha: context.headSha,
    },
    run: {
      id: generateRunId(),
      ci_url: null,
      duration_seconds: 0,
      llm_error: null,
    },
    analysis_completeness: null,
    tools_executed: [],
    findings,
    test_inversion: null,
    scope_creep: null,
    noise_budget: noiseBudget,
    dropped_below_min_confidence: droppedBelowMinConfidence,
    summary: {
      total_findings: findings.length,
      by_severity: bySeverity,
      by_source_type: bySourceType as FindingsArtifact["summary"]["by_source_type"],
      by_category: byCategory as FindingsArtifact["summary"]["by_category"],
      dismissed_count: dismissedCount,
    },
  };

  return artifact;
}

function generateRunId(): string {
  return `flaught-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Docs-only diff detection ───────────────────────────────────────────────

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

// Common documentation files with no extension — checked by basename, case-insensitively.
const DOC_BASENAMES = new Set(["readme", "license", "changelog", "notice", "authors", "contributing"]);

export function isDocFile(filePath: string): boolean {
  const slash = filePath.lastIndexOf("/");
  const basename = slash === -1 ? filePath : filePath.slice(slash + 1);
  const dot = basename.lastIndexOf(".");

  if (dot > 0) {
    return DOC_EXTENSIONS.has(basename.slice(dot).toLowerCase());
  }
  // No extension (or a dotfile with no further extension) — check by basename.
  return DOC_BASENAMES.has(basename.toLowerCase());
}

/** True when there's at least one changed file and every one of them is documentation. */
export function isDocsOnlyDiff(changedFiles: ChangedFile[]): boolean {
  return changedFiles.length > 0 && changedFiles.every((f) => isDocFile(f.path));
}

// ─── Exit code computation ──────────────────────────────────────────────────

function computeExitCode(artifact: FindingsArtifact, config: FlaughtConfig): number {
  if (config.severity_gate.fail_on === "none") return 0;

  const severityOrder: Severity[] = ["critical", "high", "medium", "low", "info"];
  const threshold = severityOrder.indexOf(config.severity_gate.fail_on);

  for (const finding of artifact.findings) {
    if (finding.dismissed) continue;
    const findingLevel = severityOrder.indexOf(finding.severity);
    if (findingLevel <= threshold) {
      return 1;
    }
  }

  return 0;
}
