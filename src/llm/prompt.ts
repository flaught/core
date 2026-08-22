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
import type { DismissalEntry } from "../schemas/dismissals.js";
import {
  assembleSystemPrompt,
  assembleUserAppend,
  type PromptTemplates,
  NO_TEMPLATES,
} from "../prompt/templates.js";

// Cap on how many dismissed themes get echoed back into the prompt. Dismissal
// stores grow indefinitely; without a cap this section would eventually crowd
// out the diff itself. Most-recent-first (see getActiveDismissals) means the
// cap drops the oldest, presumably least-relevant, entries first.
const MAX_DISMISSALS_IN_PROMPT = 25;

/**
 * Format previously-dismissed findings as a "don't re-raise this" digest for
 * the LLM prompt.
 *
 * This is the root-cause fix for dismissal-by-fingerprint's known limitation:
 * fingerprint matching only catches an LLM finding that comes back with
 * *identical* wording. A reworded restatement of the same theme gets a new
 * fingerprint and silently re-triggers the gate. Feeding the dismissal
 * history back into the prompt stops the LLM from generating the restatement
 * in the first place, instead of trying to pattern-match its infinite
 * phrasings after the fact.
 */
export function formatDismissalsForPrompt(entries: DismissalEntry[]): string {
  if (entries.length === 0) return "";

  const shown = entries.slice(0, MAX_DISMISSALS_IN_PROMPT);
  const lines = [
    `## Previously Reviewed & Dismissed`,
    "",
    "A human has already reviewed and dismissed the findings below as not " +
    "actionable. Do not re-raise the same underlying issue under new wording " +
    "unless something materially new and different is present in this diff.",
    "",
  ];

  for (const entry of shown) {
    const file = entry.context?.file ? ` (\`${entry.context.file}\`)` : "";
    const title = entry.context?.title ?? "(untitled)";
    lines.push(`- "${title}"${file} — dismissed: ${entry.reason}`);
  }

  if (entries.length > shown.length) {
    lines.push(`- …and ${entries.length - shown.length} older dismissal(s), omitted for space.`);
  }

  return lines.join("\n");
}

/**
 * Build the system prompt — sets the adversarial posture and output format.
 *
 * When templates are provided, individual sections may be overridden or
 * the entire prompt may be replaced. When templates are null/empty (the
 * default), the built-in prompt is used.
 */
export function buildSystemPrompt(
  config: FlaughtConfig,
  templates: PromptTemplates = NO_TEMPLATES,
): string {
  return assembleSystemPrompt(config, templates);
}

/**
 * Build the user prompt — provides the diff, context, and review instructions.
 *
 * When templates are provided, user-append.md content is appended after
 * the built-in review instructions.
 */
export function buildUserPrompt(
  context: ReviewContext,
  _config: FlaughtConfig,
  prDescription?: string,
  templates: PromptTemplates = NO_TEMPLATES,
  activeDismissals: DismissalEntry[] = [],
): string {
  const sections: string[] = [];
  const MAX_PROMPT_CHARS = 100_000; // ~25K tokens, leaves room for the system prompt and output

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

  // ── Previously dismissed findings (don't re-raise reworded restatements) ──
  const dismissalsSection = formatDismissalsForPrompt(activeDismissals);
  if (dismissalsSection) {
    sections.push(dismissalsSection);
  }

  // ── Review instruction ──
  const reviewInstructions =
    `## Review Instructions\n\n` +
    `Review this change adversarially. The diff shows ${context.changedFiles.length} changed file(s). ` +
    `Focus on the most important findings first. ` +
    `Remember: you are building the case AGAINST merging. ` +
    `If the change is genuinely clean, say so briefly — but never rubber-stamp.\n\n` +
    `Respond with valid JSON only, following the format specified in your system prompt.`;

  sections.push(reviewInstructions);

  // Append user prompt template overrides
  const userAppend = assembleUserAppend(templates);
  if (userAppend) {
    sections.push(userAppend);
  }

  const prompt = sections.join("\n\n---\n\n");

  // ── Truncate if the prompt is too long ──
  if (prompt.length > MAX_PROMPT_CHARS) {
    // Priority order for truncation: neighborhood contents first, then file contents, then diff
    // The summary sections (changed files, blast radius, review instructions) are kept.

    // Try without neighborhood contents
    const withoutNeighborhood = sections
      .filter((s) => !s.includes("Neighborhood File Contents"))
      .join("\n\n---\n\n");
    if (withoutNeighborhood.length <= MAX_PROMPT_CHARS) {
      return withoutNeighborhood + "\n\n---\n\n⚠️ Neighborhood file contents were truncated to fit the prompt size limit.";
    }

    // Try without file contents too
    const essential = sections
      .filter((s) => !s.includes("Neighborhood File Contents") && !s.includes("Changed File Contents"))
      .join("\n\n---\n\n");
    if (essential.length <= MAX_PROMPT_CHARS) {
      return essential + "\n\n---\n\n⚠️ File contents were truncated to fit the prompt size limit. Only the diff and summaries are included.";
    }

    // Last resort: truncate the diff itself
    const diffSection = sections.find((s) => s.includes("Unified Diff"));
    const nonDiffSections = sections.filter((s) => !s.includes("Unified Diff") && !s.includes("Neighborhood File Contents") && !s.includes("Changed File Contents"));
    const diffBudget = MAX_PROMPT_CHARS - nonDiffSections.join("\n\n---\n\n").length - 200;
    if (diffSection && diffBudget > 1000) {
      const truncatedDiff = diffSection.slice(0, diffBudget);
      return [...nonDiffSections, truncatedDiff].join("\n\n---\n\n") +
        `\n\n---\n\n⚠️ The diff was truncated to fit the prompt size limit (${context.changedFiles.length} files changed; showing first ~${diffBudget} chars).`;
    }

    // Absolute fallback
    return nonDiffSections.join("\n\n---\n\n") +
      `\n\n⚠️ Context was truncated to fit the prompt size limit.`;
  }

  return prompt;
}