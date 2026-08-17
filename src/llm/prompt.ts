/**
 * Adversarial review prompt construction.
 *
 * The prompt is the most important part of the LLM review — it sets the
 * adversarial posture, provides the context, and constrains the output
 * format. The LLM is instructed to be Monsignor Flaught: the designated
 * skeptic building the strongest possible case *against* merging.
 */

import type { ReviewContext } from "../context/assembler.js";
import type { FlaughtConfig } from "../schemas/config.js";

/**
 * Build the system prompt — sets the adversarial posture and output format.
 */
export function buildSystemPrompt(config: FlaughtConfig): string {
  const budgetLines = Object.entries(config.noise_budget)
    .map(([severity, limit]) => `  - ${severity}: max ${limit} findings`)
    .join("\n");

  return `You are Monsignor Flaught — the devil's advocate for code review. Your job is to build the strongest possible case against merging this PR. You are a skeptical senior engineer who didn't write the code and doesn't trust the PR description.

POSTURE:
- Argue against merging. Find reasons this change is dangerous, over-scoped, poorly tested, or architecturally wrong.
- Flag every real risk. Do not hedge or soften findings to be "helpful."
- Distinguish clearly between findings you are certain about and findings you suspect but cannot confirm.
- If the change is genuinely clean, say so briefly — but never rubber-stamp.

CATEGORIES (use exactly these):
- security: Vulnerabilities, injection, auth issues, data exposure
- architecture: Coupling, abstraction problems, separation of concerns violations
- scope-creep: Changes that don't serve the stated PR intent
- test-quality: Missing tests, tests that don't verify the change, insufficient coverage
- performance: Algorithmic concerns, N+1 queries, memory leaks
- maintainability: Naming, documentation debt, confusing logic, dead code

SEVERITY (use exactly these):
- critical: Must fix before merge — data loss, security vulnerability, broken production path
- high: Should fix before merge — significant risk or bug
- medium: Worth discussing — potential issue or improvement
- low: Nitpick or minor style concern
- info: Observation worth noting but not actionable

NOISE BUDGET — you MUST rank and prioritize. Do not dump every finding:
${budgetLines}

OUTPUT FORMAT — respond with valid JSON only. No markdown, no explanation outside the JSON:
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
}

IMPORTANT:
- Rank findings within each severity tier. If you have 8 medium findings and the budget is 5, include only the 5 most important.
- Every finding MUST have file, line_start, line_end, and snippet — no exceptions.
- confidence is 0.0-1.0 — be honest. If you're guessing, say 0.4-0.5. If you're certain, say 0.9+.
- Never fabricate code, line numbers, or file paths that don't exist in the provided context.`;
}

/**
 * Build the user prompt — provides the diff, context, and review instructions.
 */
export function buildUserPrompt(
  context: ReviewContext,
  _config: FlaughtConfig,
  prDescription?: string,
): string {
  const sections: string[] = [];

  // ── PR context ──
  if (prDescription) {
    sections.push(`## PR Description\n\n${prDescription}`);
  }

  // ── Changed files summary ──
  const changeSummary = context.changedFiles
    .map((f) => {
      const indicator =
        f.status === "added" ? "+" :
        f.status === "deleted" ? "-" :
        f.status === "renamed" ? "→" : "~";
      return `${indicator} ${f.path} (+${f.additions}/-${f.deletions})`;
    })
    .join("\n");

  sections.push(`## Changed Files\n\n${changeSummary}`);

  // ── Blast radius ──
  if (context.neighborhoodFiles.length > 0) {
    sections.push(
      `## Blast Radius (files that depend on changed files)\n\n` +
      context.neighborhoodFiles.map((f) => `- ${f}`).join("\n"),
    );
  }

  // ── Dependency graph ──
  const relevantEdges: string[] = [];
  const changedPaths = new Set(context.changedFiles.map((f) => f.path));
  const allRelevant = new Set([
    ...changedPaths,
    ...context.neighborhoodFiles,
  ]);

  for (const file of allRelevant) {
    const deps = context.dependencyGraph.getDependenciesOf(file);
    for (const dep of deps) {
      if (allRelevant.has(dep)) {
        relevantEdges.push(`${file} → ${dep}`);
      }
    }
  }

  if (relevantEdges.length > 0) {
    sections.push(
      `## Relevant Dependency Edges\n\n` +
      relevantEdges.map((e) => `- ${e}`).join("\n"),
    );
  }

  // ── Changed file contents ──
  const fileContents = Array.from(context.changedFileContents.entries())
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
    .join("\n\n");

  if (fileContents) {
    sections.push(`## Changed File Contents\n\n${fileContents}`);
  }

  // ── Neighborhood file contents ──
  const neighborhoodContents = Array.from(
    context.neighborhoodFileContents.entries(),
  )
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
    .join("\n\n");

  if (neighborhoodContents) {
    sections.push(
      `## Neighborhood File Contents (for blast radius context)\n\n${neighborhoodContents}`,
    );
  }

  // ── Diff ──
  if (context.diff) {
    sections.push(`## Unified Diff\n\n\`\`\`diff\n${context.diff}\n\`\`\``);
  }

  // ── Review instruction ──
  sections.push(
    `## Review Instructions\n\n` +
    `Review this change adversarially. The diff shows ${context.changedFiles.length} changed file(s). ` +
    `Focus on the most important findings first. ` +
    `Remember: you are building the case AGAINST merging. ` +
    `If the change is genuinely clean, say so briefly — but never rubber-stamp.\n\n` +
    `Respond with valid JSON only, following the format specified in your system prompt.`,
  );

  return sections.join("\n\n---\n\n");
}