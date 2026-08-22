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

import type { FlaughtConfig } from "../schemas/config.js";
import type { Finding, RefuteResult, RefuteVerdict } from "../schemas/findings.js";
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
}

// ─── Create the refute provider ─────────────────────────────────────────────

/**
 * Create the LLM provider for the refute pass.
 *
 * If refute.provider/model are set, use those. Otherwise, fall back to
 * the main LLM config. This allows anti-correlation: code reviewed by
 * Claude can be refuted by GPT-4o, or vice versa.
 */
function createRefuteProvider(config: FlaughtConfig): LLMProvider {
  // If a separate refute provider is configured, use it
  if (config.refute.provider && config.refute.model) {
    const refuteConfig: FlaughtConfig = {
      ...config,
      llm: {
        ...config.llm,
        provider: config.refute.provider,
        model: config.refute.model,
        api_key_env: config.refute.api_key_env ?? config.llm.api_key_env,
        base_url: config.refute.base_url ?? config.llm.base_url,
        temperature: config.refute.temperature,
        max_tokens: config.refute.max_tokens,
      },
    };
    return createProvider(refuteConfig);
  }

  // Otherwise, use the same provider with the refute temperature
  const refuteConfig: FlaughtConfig = {
    ...config,
    llm: {
      ...config.llm,
      temperature: config.refute.temperature,
      max_tokens: config.refute.max_tokens,
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
  const providerLabel = config.refute.provider && config.refute.model
    ? `${config.refute.provider}/${config.refute.model}`
    : `${config.llm.provider}/${config.llm.model}`;

  onProgress(`  Skeptic model: ${providerLabel}`);

  const allEvaluations: Array<{ findingIndex: number; verdict: RefuteVerdict; reasoning: string; adjustedConfidence: number }> = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx]!;

    if (batches.length > 1) {
      onProgress(`  Refuting batch ${batchIdx + 1}/${batches.length} (${batch.length} findings)...`);
    }

    // Build the skeptic prompt
    const userPrompt = buildRefuteUserPrompt(
      batch,
      context.diff,
      context.changedFileContents,
      context.neighborhoodFileContents,
    );

    // Call the skeptic
    const result = await provider.review(REFUTE_SYSTEM_PROMPT, userPrompt);

    // Parse the evaluations
    const evaluations = parseRefuteResponse(result.raw);

    // Map evaluations back to findings using finding_index
    for (const eval_ of evaluations) {
      // The finding_index in the evaluation refers to the index within this batch
      const batchIndex = eval_.finding_index;
      if (batchIndex >= 0 && batchIndex < batch.length) {
        // Map batch-local index to global LLM findings index
        const globalIndex = batchIdx * batchSize + batchIndex;
        allEvaluations.push({
          findingIndex: globalIndex,
          verdict: eval_.verdict,
          reasoning: eval_.reasoning,
          adjustedConfidence: eval_.adjusted_confidence,
        });
      }
    }

    if (result.usage) {
      onProgress(`  Skeptic tokens: ${result.usage.prompt_tokens.toLocaleString()} prompt + ${result.usage.completion_tokens.toLocaleString()} completion`);
    }
  }

  // Apply evaluations to findings
  const evaluationMap = new Map(allEvaluations.map((e) => [e.findingIndex, e]));

  const adjustedLlmFindings = llmFindings.map((finding, idx) => {
    const evaluation = evaluationMap.get(idx);

    if (!evaluation) {
      // No evaluation for this finding — treat as uncertain (conservative)
      return {
        ...finding,
        confidence: Math.round(finding.confidence * 0.7 * 100) / 100,
        refute_result: {
          verdict: "uncertain" as RefuteVerdict,
          reasoning: "Skeptic did not evaluate this finding; confidence reduced conservatively.",
          adjusted_confidence: Math.round(finding.confidence * 0.7 * 100) / 100,
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

  onProgress(`  Skeptic results: ${confirmed} confirmed, ${refuted} refuted, ${uncertain} uncertain`);

  return {
    findings: allFindings,
    model: `refute:${providerLabel}`,
  };
}