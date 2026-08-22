/**
 * Review orchestrator — ties context assembly, LLM provider, and report
 * rendering together into a complete adversarial review pipeline.
 */

// Read version from package.json — the compiled output is CJS, so require() works directly
const pkgVersion: string = require("../package.json").version;

import { assembleContext, type ReviewContext, type ChangedFile } from "./context/assembler.js";
import { loadConfig } from "./config.js";
import type { FlaughtConfig } from "./schemas/config.js";
import { createProvider, type LLMReviewResult } from "./llm/provider.js";
import { buildSystemPrompt, buildUserPrompt } from "./llm/prompt.js";
import { loadTemplates } from "./prompt/templates.js";
import {
  type FindingsArtifact,
  type Finding,
  type NoiseBudget,
  type Severity,
  type ToolExecuted,
  type TestInversion,
  type ScopeCreep,
  type FlaggedHunk,
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
  /** The LLM review result (null if LLM was skipped) */
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
  let findings: Finding[] = [];

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
    const userPrompt = buildUserPrompt(context, config, options.prDescription, templates, activeDismissals);

    // Inject deterministic tool findings into the prompt
    const toolContext = formatToolFindingsForPrompt(deterministicFindings);

    // Inject scope-creep heuristic findings into the prompt (pre-computed before LLM call)
    const scopeCreepContext = formatScopeCreepForPrompt(
      scopeCreepHeuristic.length > 0
        ? { pr_intent: options.prDescription ?? "No PR description provided", flagged_hunks: scopeCreepHeuristic }
        : null,
    );

    // Tell the LLM up front which paths are exempt from scope-creep scoring
    // (e.g. an ADR accompanying the change it documents) — filterExcludedScopeCreep
    // below is the enforcement backstop if it ignores this.
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

    llmResult = await provider.review(systemPrompt, fullUserPrompt);
    findings.push(...llmResult.findings);

    if (llmResult.usage) {
      progress(`  Token usage: ${llmResult.usage.prompt_tokens.toLocaleString()} prompt + ${llmResult.usage.completion_tokens.toLocaleString()} completion = ${llmResult.usage.total_tokens.toLocaleString()} total`);
    }

    progress(`  LLM found ${llmResult.findings.length} findings`);

    // ── Refute pass: the skeptic challenges each LLM finding ──
    // Deterministic findings are ground truth — they don't get refuted.
    const llmFindingsForRefute = findings.filter((f) => f.source_type === "llm");
    if (options.skipRefute) {
      progress("Refute pass skipped (--no-refute).");
      // Set refute_result to null for all LLM findings (no skeptic evaluation)
      findings = findings.map((f) =>
        f.source_type === "llm" ? { ...f, refute_result: null } : f,
      );
    } else if (config.refute.enabled && llmFindingsForRefute.length > 0) {
      const refuteResult = await runRefutePass(
        findings,
        context,
        config,
        templates,
        progress,
      );
      findings = refuteResult.findings;
      progress(`  Refute model: ${refuteResult.model}`);
      if (refuteResult.usage) {
        progress(`  Refute tokens: ${refuteResult.usage.prompt_tokens.toLocaleString()} prompt + ${refuteResult.usage.completion_tokens.toLocaleString()} completion = ${refuteResult.usage.total_tokens.toLocaleString()} total`);
      }
    } else if (!config.refute.enabled) {
      progress("Refute pass disabled in config — skipping skeptic.");
    } else {
      progress("No LLM findings to refute — skipping skeptic pass.");
    }
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

  // 7. Enforce noise budget
  findings = enforceNoiseBudget(findings, config);

  if (findings.length > 0) {
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
  const artifact = buildArtifact(context, findings, config);
  artifact.tools_executed = toolExecutions;
  artifact.test_inversion = testInversion;
  artifact.scope_creep = scopeCreepResult;

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
  };
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
    },
    tools_executed: [],
    findings,
    test_inversion: null,
    scope_creep: null,
    noise_budget: noiseBudget,
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