/**
 * Refute pass runner — the skeptic stage of adversarial review.
 *
 * After the initial LLM pass produces findings, this module runs a second
 * pass where a skeptic model (which can be a different provider/model from
 * the initial reviewer) tries to knock down each finding. Only findings
 * that survive the skeptic retain their original confidence; refuted
 * findings get their confidence reduced.
 *
 * This is the architectural feature that most distinguishes Flaught from
 * other AI code review tools. Aster's "hypothesize then refute" pipeline
 * and ng/adversarial-review's "Optimizer/Skeptic" architecture use similar
 * ideas, but Flaught combines the skeptic pass with deterministic findings
 * (which are exempt from refutation) and test inversion (which is ground
 * truth, not an opinion to be debated).
 */

import { randomBytes } from "node:crypto";
import type { FlaughtConfig } from "../schemas/config.js";
import type { Finding, RefuteResult, RefuteVerdict, SkepticStatus } from "../schemas/findings.js";
import { createProvider, type LLMProvider } from "../llm/provider.js";
import { buildRefuteUserPrompt, parseRefuteResponse, REFUTE_SYSTEM_PROMPT } from "./prompt.js";
import type { ReviewContext } from "../context/assembler.js";
import type { PromptTemplates } from "../prompt/templates.js";
import { NO_TEMPLATES } from "../prompt/templates.js";

// ─── Progress callback ──────────────────────────────────────────────────────

export type RefuteProgressCallback = (message: string) => void;

function noopProgress(_message: string) {}

// ─── Refute result ───────────────────────────────────────────────────────────

export interface RunRefuteResult {
  /** Findings with refute_result populated and confidence adjusted */
  findings: Finding[];
  /** The skeptic model used */
  model: string;
  /** Token usage from the skeptic call (if available) */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Coverage/validation diagnostics for the skeptic pass (issue #88). */
  skeptic: SkepticStatus;
}

// ─── Create the refute provider ─────────────────────────────────────────────

/**
 * Resolve the provider/model the refute pass should actually run on.
 *
 * `refute.provider` and `refute.model` are independent overrides — either
 * can be set without the other. Setting only `refute.model` is the common
 * same-provider anti-correlation case (e.g. a different Groq model acting
 * as skeptic for whatever Groq model wrote the findings) and must not
 * require also repeating the provider name.
 */
function resolveRefuteTarget(config: FlaughtConfig): { provider: FlaughtConfig["llm"]["provider"]; model: string } {
  return {
    provider: config.refute.provider ?? config.llm.provider,
    model: config.refute.model ?? config.llm.model,
  };
}

/**
 * Create the LLM provider for the refute pass.
 *
 * If refute.provider and/or refute.model are set, use those (falling back
 * to the main LLM config for whichever isn't overridden). Otherwise, fall
 * back to the main LLM config entirely. This allows anti-correlation: code
 * reviewed by Claude can be refuted by GPT-4o, or by a different model on
 * the same provider — e.g. one Groq model refuted by another.
 */
function createRefuteProvider(config: FlaughtConfig): LLMProvider {
  const target = resolveRefuteTarget(config);
  const refuteConfig: FlaughtConfig = {
    ...config,
    llm: {
      ...config.llm,
      provider: target.provider,
      model: target.model,
      api_key_env: config.refute.api_key_env ?? config.llm.api_key_env,
      base_url: config.refute.base_url ?? config.llm.base_url,
      temperature: config.refute.temperature,
      max_tokens: config.refute.max_tokens,
      reasoning_effort: config.refute.reasoning_effort ?? config.llm.reasoning_effort,
    },
  };
  return createProvider(refuteConfig);
}

// ─── Run the refute pass ─────────────────────────────────────────────────────

/**
 * Run the skeptic pass on LLM-asserted findings.
 *
 * Only LLM findings go through the refute pass. Deterministic findings
 * (source_type: "deterministic") are ground truth and are left untouched.
 *
 * Returns the findings array with:
 * - LLM findings: confidence adjusted based on skeptic verdict
 * - Deterministic findings: unchanged, refute_result = null
 */
export async function runRefutePass(
  findings: Finding[],
  context: ReviewContext,
  config: FlaughtConfig,
  _templates: PromptTemplates = NO_TEMPLATES,
  onProgress: RefuteProgressCallback = noopProgress,
  prDescription?: string,
): Promise<RunRefuteResult> {
  // Separate deterministic from LLM findings
  const deterministicFindings = findings.filter((f) => f.source_type === "deterministic");
  const llmFindings = findings.filter((f) => f.source_type === "llm");

  // Nothing to refute
  if (llmFindings.length === 0) {
    onProgress("No LLM findings to refute — skipping skeptic pass.");
    return {
      findings: [...deterministicFindings, ...llmFindings],
      model: "none",
      skeptic: {
        state: "not_run",
        expected: 0,
        evaluated: 0,
        not_evaluated: 0,
        parse_failures: 0,
        retries: 0,
        unknown_ids: 0,
        duplicate_ids: 0,
        legacy_index_matches: 0,
      },
    };
  }

  // Batch findings if needed
  const batches: Finding[][] = [];
  const batchSize = config.refute.max_batch_size;

  for (let i = 0; i < llmFindings.length; i += batchSize) {
    batches.push(llmFindings.slice(i, i + batchSize));
  }

  onProgress(`Running skeptic pass (${llmFindings.length} LLM finding${llmFindings.length === 1 ? "" : "s"}, ${batches.length} batch${batches.length === 1 ? "" : "es"})...`);

  const provider = createRefuteProvider(config);
  const refuteTarget = resolveRefuteTarget(config);
  onProgress(`  Skeptic model: ${refuteTarget.provider}/${refuteTarget.model}`);

  // Assign each finding an opaque, run-scoped ID (issue #88). The prompt
  // previously numbered findings 1-based while the parser expected 0-based
  // `finding_index` values, and a missing index silently defaulted to finding
  // 0 — an evaluation could attach to the WRONG finding, and a response that
  // evaluated nothing was indistinguishable from nine "uncertain" verdicts.
  // Round-tripping opaque IDs makes every mismatch detectable.
  const salt = randomBytes(2).toString("hex");
  const findingIds = llmFindings.map((_, idx) => `RF-${salt}-${idx + 1}`);

  const allEvaluations: Array<{ findingIndex: number; verdict: RefuteVerdict; reasoning: string; adjustedConfidence: number }> = [];
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalTotal = 0;
  let sawUsage = false;
  let parseFailures = 0;
  let retries = 0;
  let unknownIds = 0;
  let duplicateIds = 0;
  let legacyIndexMatches = 0;

  /** Upper bound on extra skeptic calls: one retry per malformed batch response. */
  const MAX_BATCH_RETRIES = 1;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx]!;
    const batchIds = findingIds.slice(batchIdx * batchSize, batchIdx * batchSize + batch.length);
    const idToGlobal = new Map(batchIds.map((id, i) => [id, batchIdx * batchSize + i]));

    if (batches.length > 1) {
      onProgress(`  Refuting batch ${batchIdx + 1}/${batches.length} (${batch.length} findings)...`);
    }

    // Build the skeptic prompt
    const userPrompt = buildRefuteUserPrompt(
      batch,
      context.diff,
      context.changedFileContents,
      context.neighborhoodFileContents,
      prDescription,
      batchIds,
      // Same soft cap as the review pass — an uncapped refute prompt against
      // a large diff is a real provider-400 failure mode.
      config.llm.max_prompt_chars,
    );

    // Call the skeptic, retrying once if the response is entirely unusable
    // (unparseable, or every evaluation entry malformed/unidentified) —
    // bounded so a persistently broken model cannot loop indefinitely (#88).
    let attempt = 0;
    let batchEvaluations: ReturnType<typeof parseRefuteResponse>["evaluations"] = [];
    for (;;) {
      const result = await provider.review(REFUTE_SYSTEM_PROMPT, userPrompt);

      if (result.usage) {
        sawUsage = true;
        totalPrompt += result.usage.prompt_tokens;
        totalCompletion += result.usage.completion_tokens;
        totalTotal += result.usage.total_tokens;
        onProgress(`  Skeptic tokens: ${result.usage.prompt_tokens.toLocaleString()} prompt + ${result.usage.completion_tokens.toLocaleString()} completion`);
      }

      batchEvaluations = parseRefuteResponse(result.raw).evaluations;

      if (batchEvaluations.length > 0 || attempt >= MAX_BATCH_RETRIES) break;
      attempt++;
      retries++;
      onProgress(`  ⚠ Skeptic response for batch ${batchIdx + 1} yielded no usable evaluations — retrying once.`);
    }
    if (batchEvaluations.length === 0) {
      parseFailures++;
      onProgress(`  ⚠ Skeptic batch ${batchIdx + 1} could not be parsed after ${attempt + 1} attempt(s); its findings will be marked not_evaluated.`);
    }

    // Map evaluations back to findings. Opaque finding_id is the primary
    // scheme; the legacy numeric finding_index is accepted only as a fallback
    // and counted, so consumers can see when the model ignored the ID
    // instruction (#88).
    for (const eval_ of batchEvaluations) {
      let globalIndex: number | null = null;

      if (eval_.finding_id !== null) {
        globalIndex = idToGlobal.get(eval_.finding_id) ?? null;
        if (globalIndex === null) {
          unknownIds++;
          continue; // reject unknown/invented IDs — never guess
        }
      } else if (eval_.finding_index !== null) {
        const batchIndex = eval_.finding_index;
        if (batchIndex >= 0 && batchIndex < batch.length) {
          globalIndex = batchIdx * batchSize + batchIndex;
          legacyIndexMatches++;
        } else {
          unknownIds++;
          continue; // out-of-range index: reject, do not clamp or wrap
        }
      }

      if (globalIndex === null) continue;

      // Duplicate evaluations for the same finding: keep the FIRST,
      // reject the rest — a later duplicate must not silently overwrite
      // an earlier verdict (the old Map-collapse behavior, #88).
      if (allEvaluations.some((e) => e.findingIndex === globalIndex)) {
        duplicateIds++;
        continue;
      }

      allEvaluations.push({
        findingIndex: globalIndex,
        verdict: eval_.verdict,
        reasoning: eval_.reasoning,
        adjustedConfidence: eval_.adjusted_confidence,
      });
    }
  }

  // Apply evaluations to findings
  const evaluationMap = new Map(allEvaluations.map((e) => [e.findingIndex, e]));

  const adjustedLlmFindings = llmFindings.map((finding, idx) => {
    const evaluation = evaluationMap.get(idx);

    if (!evaluation) {
      // The skeptic's response contained NO usable evaluation for this
      // finding. This is a coverage failure, NOT an evidence-based verdict —
      // distinguish it as not_evaluated (issue #88) so a paid skeptic call
      // that evaluated nothing can never masquerade as "all uncertain".
      const adjusted = Math.round(finding.confidence * 0.7 * 100) / 100;
      return {
        ...finding,
        confidence: adjusted,
        refute_result: {
          verdict: "not_evaluated" as RefuteVerdict,
          reasoning: "Skeptic did not evaluate this finding (its response omitted, malformed, or mis-identified the evaluation); confidence reduced conservatively. This is an incomplete-skeptic signal, not an uncertain verdict.",
          adjusted_confidence: adjusted,
        } satisfies RefuteResult,
      };
    }

    let adjustedConfidence: number;
    let verdict: RefuteVerdict = evaluation.verdict;

    switch (evaluation.verdict) {
      case "confirmed":
        // Confirmed findings keep or slightly increase their confidence
        adjustedConfidence = Math.min(1, Math.round((finding.confidence * 1.05) * 100) / 100);
        break;
      case "refuted":
        // Refuted findings get a significant confidence reduction
        adjustedConfidence = evaluation.adjustedConfidence;
        break;
      case "uncertain":
        // Uncertain findings get a moderate reduction
        adjustedConfidence = evaluation.adjustedConfidence;
        break;
      default:
        adjustedConfidence = Math.round(finding.confidence * 0.7 * 100) / 100;
        verdict = "uncertain";
    }

    return {
      ...finding,
      confidence: adjustedConfidence,
      refute_result: {
        verdict,
        reasoning: evaluation.reasoning,
        adjusted_confidence: adjustedConfidence,
      } satisfies RefuteResult,
    };
  });

  // Merge back: deterministic findings first, then adjusted LLM findings
  const allFindings = [...deterministicFindings, ...adjustedLlmFindings];

  // Re-index IDs to maintain sequential ordering
  for (let i = 0; i < allFindings.length; i++) {
    allFindings[i] = { ...allFindings[i]!, id: `F-${String(i + 1).padStart(4, "0")}` };
  }

  // Summary
  const confirmed = adjustedLlmFindings.filter((f) => f.refute_result?.verdict === "confirmed").length;
  const refuted = adjustedLlmFindings.filter((f) => f.refute_result?.verdict === "refuted").length;
  const uncertain = adjustedLlmFindings.filter((f) => f.refute_result?.verdict === "uncertain").length;
  const notEvaluated = adjustedLlmFindings.filter((f) => f.refute_result?.verdict === "not_evaluated").length;

  onProgress(`  Skeptic results: ${confirmed} confirmed, ${refuted} refuted, ${uncertain} uncertain${notEvaluated > 0 ? `, ${notEvaluated} NOT EVALUATED` : ""}`);

  const evaluatedCount = llmFindings.length - notEvaluated;
  const skeptic: SkepticStatus = {
    state: notEvaluated === 0
      ? "complete"
      : evaluatedCount === 0
        ? "failed"
        : "partial",
    expected: llmFindings.length,
    evaluated: evaluatedCount,
    not_evaluated: notEvaluated,
    parse_failures: parseFailures,
    retries,
    unknown_ids: unknownIds,
    duplicate_ids: duplicateIds,
    legacy_index_matches: legacyIndexMatches,
  };

  if (notEvaluated > 0) {
    onProgress(`  ⚠ Incomplete skeptic coverage: ${evaluatedCount}/${llmFindings.length} findings evaluated (parse failures: ${parseFailures}, unknown IDs: ${unknownIds}, duplicates: ${duplicateIds}).`);
  }

  return {
    findings: allFindings,
    model: `refute:${refuteTarget.provider}/${refuteTarget.model}`,
    usage: sawUsage
      ? { prompt_tokens: totalPrompt, completion_tokens: totalCompletion, total_tokens: totalTotal }
      : undefined,
    skeptic,
  };
}