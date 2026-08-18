/**
 * Review orchestrator — ties context assembly, LLM provider, and report
 * rendering together into a complete adversarial review pipeline.
 */

import { assembleContext, type ReviewContext } from "./context/assembler.js";
import { loadConfig } from "./config.js";
import type { FlaughtConfig } from "./schemas/config.js";
import { createProvider, type LLMReviewResult } from "./llm/provider.js";
import { buildSystemPrompt, buildUserPrompt } from "./llm/prompt.js";
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
import { detectScopeCreepHeuristic, extractScopeCreepFromFindings, formatScopeCreepForPrompt } from "./scope-creep/detector.js";

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
  /** Progress callback for logging */
  onProgress?: ProgressCallback;
}

export async function runReview(options: ReviewOptions = {}): Promise<ReviewResult> {
  const progress = options.onProgress ?? noopProgress;
  const startTime = Date.now();

  // 1. Load config
  progress("Loading config...");
  const config = await loadConfig(options.configPath);
  progress(`  Provider: ${config.llm.provider}/${config.llm.model}`);

  // 2. Assemble context
  progress("Assembling context (diff + dependency graph)...");
  const context = await assembleContext({
    repoPath: options.repoPath,
    baseRef: options.baseRef,
    headRef: options.headRef,
    configPath: options.configPath,
  });

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
    findings.push({
      id: `D-${findings.length + 1}`.padStart(5, "0"),
      severity: (["critical", "high", "medium", "low", "info"].includes(df.severity) ? df.severity : "medium") as Severity,
      category: (["security", "architecture", "scope-creep", "test-quality", "performance", "maintainability"].includes(df.category) ? df.category : "maintainability") as Finding["category"],
      title: df.title,
      description: `${df.source} found: ${df.title}${df.ruleId !== "unknown" ? ` (${df.ruleId})` : ""}`,
      evidence: {
        file: df.file,
        line_start: df.line,
        line_end: df.line,
        snippet: df.snippet,
        blast_radius: [],
      },
      source: df.source,
      source_type: "deterministic",
      confidence: 1.0, // deterministic tools get full confidence
      references: df.reference ? [df.reference] : [],
      dismissed: false,
      dismissed_by: null,
      dismissed_at: null,
      dismissal_reason: null,
    });
  }

  if (options.skipLlm) {
    progress("Skipping LLM review (--no-llm).");
  } else if (context.changedFiles.length === 0) {
    progress("No changes to review — skipping LLM call.");
  } else {
    const provider = createProvider(config);
    const systemPrompt = buildSystemPrompt(config);
    const userPrompt = buildUserPrompt(context, config, options.prDescription);

    // Inject deterministic tool findings into the prompt
    const toolContext = formatToolFindingsForPrompt(deterministicFindings);

    // Inject scope-creep heuristic findings into the prompt (pre-computed before LLM call)
    const scopeCreepContext = formatScopeCreepForPrompt(
      scopeCreepHeuristic.length > 0
        ? { pr_intent: options.prDescription ?? "No PR description provided", flagged_hunks: scopeCreepHeuristic }
        : null,
    );

    let fullUserPrompt = userPrompt;
    if (toolContext) {
      fullUserPrompt = `${fullUserPrompt}\n\n---\n\n${toolContext}`;
    }
    if (scopeCreepContext) {
      fullUserPrompt = `${fullUserPrompt}\n\n---\n\n${scopeCreepContext}`;
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
  }

  // 5. Test inversion
  let testInversion: TestInversion | null = null;

  if (context.changedFiles.length > 0 && config.test_inversion.enabled) {
    progress("Running test inversion (pre/post change test comparison)...");
    testInversion = await runTestInversion(
      config,
      context.repoRoot,
      context.baseSha,
      context.headSha,
      progress,
    );

    if (testInversion && testInversion.flagged.length > 0) {
      // Convert flagged tests to findings
      for (const ft of testInversion.flagged) {
        findings.push({
          id: `F-${findings.length + 1}`.padStart(5, "0"),
          severity: "medium",
          category: "test-quality",
          title: `Test doesn't verify the change: ${ft.test}`,
          description: ft.reason,
          evidence: {
            file: "",
            line_start: 0,
            line_end: 0,
            snippet: "",
            blast_radius: [],
          },
          source: "test-inversion",
          source_type: "deterministic",
          confidence: 1.0,
          references: [],
          dismissed: false,
          dismissed_by: null,
          dismissed_at: null,
          dismissal_reason: null,
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

  const result: Finding[] = [];
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  // Sort by severity (critical first), then by confidence (high first)
  const sorted = [...findings].sort((a, b) => {
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

  return result;
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
    flaught_version: "0.1.0",
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