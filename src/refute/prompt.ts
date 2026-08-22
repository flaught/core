/**
 * Refute-pass prompt construction.
 *
 * The skeptic prompt takes each LLM finding and challenges it. The skeptic
 * is instructed to default to refutation under uncertainty — a finding must
 * earn its survival. This is the "devil's advocate" pass that gives Flaught
 * its name: Monsignor Flaught's job was to argue against canonization, and
 * the skeptic's job is to argue against each finding.
 *
 * Only LLM-asserted findings go through the refute pass. Deterministic
 * findings (from Semgrep, linters, etc.) are already ground-truth —
 * refuting them would be wasteful and misleading.
 */

import type { Finding, RefuteVerdict } from "../schemas/findings.js";

// ─── System prompt ──────────────────────────────────────────────────────────

export const REFUTE_SYSTEM_PROMPT = `You are the Skeptic — an independent reviewer whose sole job is to challenge findings from a code review.

You did NOT produce these findings. You are seeing them for the first time, with no attachment to whether they are correct.

Your posture:
- Default to doubt. A finding must EARN survival by being clearly correct.
- If you cannot verify a finding from the provided context, mark it "uncertain" — do not confirm it.
- If you can identify a concrete reason the finding is wrong, mark it "refuted".
- Only mark a finding "confirmed" if you can verify it from the code provided.

Be specific in your reasoning. Vague agreement ("this seems right") is not confirmation. Reference specific lines, variables, or logic from the provided context.

IMPORTANT CONSTRAINTS:
- Do not confirm a finding just because it sounds plausible. You must be able to point to the specific code that makes it true.
- Do not refute a finding just because you're being skeptical. You must have a concrete reason: the code doesn't exist, the logic is correct, the risk is overstated, or the finding is a false positive.
- When in genuine doubt, mark "uncertain" — this is honest and actionable.`;

// ─── User prompt builder ────────────────────────────────────────────────────

/**
 * Build the user prompt for the refute pass.
 *
 * This sends the original diff context plus each LLM finding, asking the
 * skeptic to evaluate whether each finding is confirmed, refuted, or uncertain.
 */
export function buildRefuteUserPrompt(
  findings: Finding[],
  diff: string | null,
  changedFileContents: Map<string, string>,
  neighborhoodFileContents: Map<string, string>,
): string {
  const sections: string[] = [];

  // ── Changed files context ──
  if (changedFileContents.size > 0) {
    const fileContents = Array.from(changedFileContents.entries())
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
      .join("\n\n");

    sections.push(`## Changed File Contents\n\n${fileContents}`);
  }

  // ── Neighborhood context ──
  if (neighborhoodFileContents.size > 0) {
    const hoodContents = Array.from(neighborhoodFileContents.entries())
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
      .join("\n\n");

    sections.push(`## Neighborhood File Contents (for blast radius context)\n\n${hoodContents}`);
  }

  // ── Diff ──
  if (diff) {
    sections.push(`## Unified Diff\n\n\`\`\`diff\n${diff}\n\`\`\``);
  }

  // ── Findings to evaluate ──
  const findingsBlock = findings
    .map((f, i) => {
      const evidence = f.evidence.snippet
        ? `\n   Snippet: \`${f.evidence.snippet}\``
        : "";
      const lines = f.evidence.line_start > 0
        ? `\n   Lines: ${f.evidence.line_start}-${f.evidence.line_end}`
        : "";

      return `### Finding ${i + 1}: [${f.severity.toUpperCase()}] ${f.title}
- Category: ${f.category}
- Source: ${f.source} (${f.source_type})
- Confidence: ${f.confidence}
- Description: ${f.description}${lines}${evidence}`;
    })
    .join("\n\n");

  sections.push(
    `## Findings to Evaluate\n\n` +
    `A code reviewer produced ${findings.length} finding(s). Evaluate each one independently.\n\n` +
    findingsBlock,
  );

  // ── Instructions ──
  sections.push(
    `## Your Task\n\n` +
    `For each finding, determine:\n\n` +
    `1. **Can you verify this finding from the code and diff provided?**\n` +
    `   - If the code clearly shows the bug/vulnerability/issue described: **confirmed**\n` +
    `   - If you can identify a concrete reason the finding is wrong: **refuted**\n` +
    `   - If you cannot verify or refute from the available context: **uncertain**\n\n` +
    `2. **What is your adjusted confidence?**\n` +
    `   - Confirmed: keep the original confidence or slightly increase it\n` +
    `   - Refuted: reduce to 0.0–0.2\n` +
    `   - Uncertain: reduce by roughly half\n\n` +
    `Respond with valid JSON only:\n\n` +
    `\`\`\`json\n` +
    `{\n` +
    `  "evaluations": [\n` +
    `    {\n` +
    `      "finding_index": 0,\n` +
    `      "verdict": "confirmed" | "refuted" | "uncertain",\n` +
    `      "reasoning": "Specific, evidence-based reasoning. Reference line numbers, variable names, or logic from the code.",\n` +
    `      "adjusted_confidence": 0.85\n` +
    `    }\n` +
    `  ]\n` +
    `}\n` +
    `\`\`\``,
  );

  return sections.join("\n\n---\n\n");
}

// ─── Parse skeptic response ──────────────────────────────────────────────────

export interface RefuteEvaluation {
  finding_index: number;
  verdict: RefuteVerdict;
  reasoning: string;
  adjusted_confidence: number;
}

export interface RefuteResponse {
  evaluations: RefuteEvaluation[];
}

/**
 * Parse the skeptic's JSON response into structured evaluations.
 *
 * Tries to be robust: handles missing fields, invalid verdicts,
 * out-of-range confidence values, and extra/unexpected fields.
 */
export function parseRefuteResponse(raw: string): RefuteEvaluation[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (jsonMatch?.[1]) {
      try {
        parsed = JSON.parse(jsonMatch[1]);
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }

  if (!parsed || typeof parsed !== "object") return [];

  const evaluations = (parsed as Record<string, unknown>).evaluations;
  const rawEvals: unknown[] = Array.isArray(evaluations)
    ? evaluations
    : Array.isArray(parsed)
      ? parsed as unknown[]
      : [];

  const validVerdicts = new Set<RefuteVerdict>(["confirmed", "refuted", "uncertain"]);
  const result: RefuteEvaluation[] = [];

  for (const rawEval of rawEvals) {
    if (!rawEval || typeof rawEval !== "object") continue;
    const e = rawEval as Record<string, unknown>;

    const verdict = validVerdicts.has(e.verdict as RefuteVerdict)
      ? (e.verdict as RefuteVerdict)
      : "uncertain";

    const adjustedConfidence = typeof e.adjusted_confidence === "number"
      ? Math.min(1, Math.max(0, e.adjusted_confidence))
      : 0.5;

    result.push({
      finding_index: typeof e.finding_index === "number" ? e.finding_index : 0,
      verdict,
      reasoning: typeof e.reasoning === "string" ? e.reasoning : "",
      adjusted_confidence: adjustedConfidence,
    });
  }

  return result;
}