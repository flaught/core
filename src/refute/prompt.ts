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

Do not merely check whether the finding's literal claim is visible in the code. Where a finding concerns correctness or behavior, independently reason about what the code SHOULD do — deriving it from the stated intent (the PR description, if provided) or, failing that, from the evident purpose of the change in the diff — and compare that to what the code actually does. A finding is confirmed when your independent derivation agrees the code is wrong as described; a finding is refuted when your independent derivation shows the code is actually correct; and it is uncertain when you cannot derive the intended behavior well enough to decide. The goal is an independent check, not a restatement of the reviewer's reasoning.

Be specific in your reasoning. Vague agreement ("this seems right") is not confirmation. Reference specific lines, variables, or logic from the provided context.

IMPORTANT CONSTRAINTS:
- Do not confirm a finding just because it sounds plausible. You must be able to point to the specific code that makes it true, or to an independent derivation that shows it.
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
  prDescription?: string,
  /**
   * Opaque finding IDs assigned by the caller (one per finding, in order).
   * Sent to the skeptic and required back verbatim in each evaluation
   * (issue #88) — positional indexes were previously labelled 1-based in the
   * prompt but parsed as 0-based, an association hazard that could attach an
   * evaluation to the wrong finding. When omitted (legacy callers), falls
   * back to RF-1..N per position in this batch.
   */
  findingIds?: string[],
  /**
   * Soft cap on the total user prompt, in characters (~4/token). The findings
   * and task instructions are essential and always included; the context
   * sections (neighborhood, changed-file contents, diff) degrade gracefully
   * to fit. Uncapped refute prompts on large diffs are a real failure mode
   * (provider 400: "reduce the length of the messages or completion").
   */
  maxPromptChars: number = 100_000,
): string {
  const sections: string[] = [];

  // ── Stated intent (the spec to re-derive against) ──
  // The skeptic independently reasons about what the code SHOULD do from this,
  // rather than only checking whether a finding's claim is visible in the code.
  if (prDescription) {
    sections.push(
      `## Stated Intent (PR description — the spec to check against)\n\n${prDescription}\n\nTreat this as the intended behavior. Where a finding concerns correctness, derive what the code should do from this intent and compare to what the code actually does.`,
    );
  }

  // Degradable context sections, with their positions, in eviction order
  // (least-to-most useful for refutation): neighborhood, file contents, diff.
  const degradable: Array<{ index: number; name: string }> = [];
  let contentsIdx: number | null = null;
  let hoodIdx: number | null = null;
  let diffIdx: number | null = null;

  // ── Changed files context ──
  if (changedFileContents.size > 0) {
    const fileContents = Array.from(changedFileContents.entries())
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
      .join("\n\n");

    sections.push(`## Changed File Contents\n\n${fileContents}`);
    contentsIdx = sections.length - 1;
  }

  // ── Neighborhood context ──
  if (neighborhoodFileContents.size > 0) {
    const hoodContents = Array.from(neighborhoodFileContents.entries())
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
      .join("\n\n");

    sections.push(`## Neighborhood File Contents (for blast radius context)\n\n${hoodContents}`);
    hoodIdx = sections.length - 1;
  }

  // ── Diff ──
  if (diff) {
    sections.push(`## Unified Diff\n\n\`\`\`diff\n${diff}\n\`\`\``);
    diffIdx = sections.length - 1;
  }

  // ── Findings to evaluate ──
  const ids = findingIds ?? findings.map((_, i) => `RF-${i + 1}`);
  const findingsBlock = findings
    .map((f, i) => {
      const evidence = f.evidence.snippet
        ? `\n   Snippet: \`${f.evidence.snippet}\``
        : "";
      const lines = f.evidence.line_start > 0
        ? `\n   Lines: ${f.evidence.line_start}-${f.evidence.line_end}`
        : "";

      return `### Finding ${ids[i]}: [${f.severity.toUpperCase()}] ${f.title}
- Category: ${f.category}
- Source: ${f.source} (${f.source_type})
- Confidence: ${f.confidence}
- Description: ${f.description}${lines}${evidence}`;
    })
    .join("\n\n");

  sections.push(
    `## Findings to Evaluate\n\n` +
    `A code reviewer produced ${findings.length} finding(s), each labelled with an ID (${ids.join(", ")}). Evaluate EVERY one independently.\n\n` +
    findingsBlock,
  );

  // ── Instructions ──
  sections.push(
    `## Your Task\n\n` +
    `For each finding, determine:\n\n` +
    `1. **Can you verify this finding from the code and diff provided?**\n` +
    `   - First, independently derive what the code SHOULD do from the Stated Intent (if provided) or the change's evident purpose — do not just restate the reviewer's claim.\n` +
    `   - Then compare your derivation to the actual code: if the code is wrong as the finding describes: **confirmed**; if you can identify a concrete reason the finding is wrong: **refuted**; if you cannot verify or refute from the available context: **uncertain**.\n\n` +
    `2. **What is your adjusted confidence?**\n` +
    `   - Confirmed: keep the original confidence or slightly increase it\n` +
    `   - Refuted: reduce to 0.0–0.2\n` +
    `   - Uncertain: reduce by roughly half\n\n` +
    `Respond with valid JSON only, one evaluation per finding ID. Every evaluation's "finding_id" MUST be one of the IDs listed above, copied verbatim — never a number, never an invented ID, and never omit a finding:\n\n` +
    `\`\`\`json\n` +
    `{\n` +
    `  "evaluations": [\n` +
    `    {\n` +
    `      "finding_id": "${ids[0] ?? "RF-1"}",\n` +
    `      "verdict": "confirmed" | "refuted" | "uncertain",\n` +
    `      "reasoning": "Specific, evidence-based reasoning. Reference line numbers, variable names, or logic from the code.",\n` +
    `      "adjusted_confidence": 0.85\n` +
    `    }\n` +
    `  ]\n` +
    `}\n` +
    `\`\`\``,
  );

  if (hoodIdx !== null) degradable.push({ index: hoodIdx, name: "neighborhood file contents" });
  if (contentsIdx !== null) degradable.push({ index: contentsIdx, name: "changed-file contents" });
  if (diffIdx !== null) degradable.push({ index: diffIdx, name: "unified diff" });

  return joinWithinBudget(sections, degradable, maxPromptChars);
}

const SECTION_SEPARATOR = "\n\n---\n\n";

function joinSections(sections: string[]): string {
  return sections.filter((s) => s !== "").join(SECTION_SEPARATOR);
}

/**
 * Final assembly: fit the user prompt within the soft character budget by
 * shrinking degradable context sections (in eviction order), each shrink
 * annotated in-band so "the skeptic saw only part of the context" is visible
 * in the prompt itself. Findings, stated intent, and the task instructions
 * are never truncated.
 */
function joinWithinBudget(
  sections: string[],
  degradable: Array<{ index: number; name: string }>,
  maxPromptChars: number,
): string {
  let rendered = joinSections(sections);
  if (rendered.length <= maxPromptChars) return rendered;

  for (const entry of degradable) {
    if (rendered.length <= maxPromptChars) break;
    const original = sections[entry.index]!;
    const overflow = rendered.length - maxPromptChars;
    const headroom = 300; // space for the truncation note itself
    const keep = original.length - overflow - headroom;
    if (keep <= 200) {
      sections[entry.index] =
        `… [Context section "${entry.name}" omitted entirely to fit the ` +
        `${maxPromptChars}-char prompt budget — the skeptic did NOT see it.]`;
    } else {
      sections[entry.index] =
        original.slice(0, keep) +
        `\n\n… [Context truncated: "${entry.name}" cut from ${original.length} to ${keep} chars ` +
        `to fit the ${maxPromptChars}-char prompt budget — the skeptic saw only part of it.]`;
    }
    rendered = joinSections(sections);
  }

  return rendered;
}

// ─── Parse skeptic response ──────────────────────────────────────────────────

/**
 * A single parsed skeptic evaluation.
 *
 * `finding_id` is the opaque round-tripped ID (the primary, post-#88 scheme).
 * `finding_index` (batch-local, 0-based) is only retained as a legacy
 * fallback for responses that ignore the ID instruction; callers must treat
 * index-matched evaluations as lower-trust and count them in diagnostics.
 * An entry with NEITHER is rejected by the parser — the old default of
 * silently attaching such entries to finding 0 is exactly the #88 bug.
 */
export interface RefuteEvaluation {
  finding_id: string | null;
  finding_index: number | null;
  verdict: RefuteVerdict;
  reasoning: string;
  adjusted_confidence: number;
}

export interface RefuteParseResult {
  evaluations: RefuteEvaluation[];
  /** True when the response body could not be parsed as JSON at all. */
  parse_error: boolean;
  /** Evaluation entries dropped because they were malformed (non-object, or no usable finding reference). */
  dropped_entries: number;
}

/**
 * Parse the skeptic's JSON response into structured evaluations.
 *
 * Strict about finding references (issue #88): each evaluation must carry
 * either a string `finding_id` or a numeric `finding_index`; entries with
 * neither are dropped and counted, never silently mapped to index 0.
 * Verdicts outside the known set are coerced to "uncertain" (that judgement
 * call is the skeptic's, not the parser's).
 */
export function parseRefuteResponse(raw: string): RefuteParseResult {
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
        return { evaluations: [], parse_error: true, dropped_entries: 0 };
      }
    } else {
      return { evaluations: [], parse_error: true, dropped_entries: 0 };
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return { evaluations: [], parse_error: true, dropped_entries: 0 };
  }

  const evaluations = (parsed as Record<string, unknown>).evaluations;
  const rawEvals: unknown[] = Array.isArray(evaluations)
    ? evaluations
    : Array.isArray(parsed)
      ? parsed as unknown[]
      : [];

  const validVerdicts = new Set<RefuteVerdict>(["confirmed", "refuted", "uncertain"]);
  const result: RefuteEvaluation[] = [];
  let dropped = 0;

  for (const rawEval of rawEvals) {
    if (!rawEval || typeof rawEval !== "object") {
      dropped++;
      continue;
    }
    const e = rawEval as Record<string, unknown>;

    //finding reference: opaque ID (primary) or numeric index (legacy fallback)
    const findingId = typeof e.finding_id === "string" && e.finding_id.trim() !== ""
      ? e.finding_id.trim()
      : null;
    const findingIndex = typeof e.finding_index === "number" && Number.isInteger(e.finding_index)
      ? e.finding_index
      : null;

    if (findingId === null && findingIndex === null) {
      // Never silently attach an unidentified evaluation to finding 0 (#88)
      dropped++;
      continue;
    }

    const verdict = validVerdicts.has(e.verdict as RefuteVerdict)
      ? (e.verdict as RefuteVerdict)
      : "uncertain";

    const adjustedConfidence = typeof e.adjusted_confidence === "number"
      ? Math.min(1, Math.max(0, e.adjusted_confidence))
      : 0.5;

    result.push({
      finding_id: findingId,
      finding_index: findingIndex,
      verdict,
      reasoning: typeof e.reasoning === "string" ? e.reasoning : "",
      adjusted_confidence: adjustedConfidence,
    });
  }

  return { evaluations: result, parse_error: false, dropped_entries: dropped };
}