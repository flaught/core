/**
 * Model liveness validation — pre-flight check that the configured model
 * actually exists on the provider before running the review.
 *
 * Groq's model catalog is volatile: models can be removed without notice
 * (e.g., llama-3.3-70b-versatile, llama-4-maverick, kimi-k2 were all
 * removed during our sessions). This module queries the provider's model
 * list endpoint and gives a clear error if the model is not found,
 * including available alternatives.
 */

import type { FlaughtConfig } from "../schemas/config.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ModelNotFoundError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly model: string,
    public readonly availableModels: string[],
  ) {
    super(message);
    this.name = "ModelNotFoundError";
  }
}

export class LivenessCheckError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly model: string,
  ) {
    super(message);
    this.name = "LivenessCheckError";
  }
}

// ─── Liveness result ─────────────────────────────────────────────────────────

export interface LivenessResult {
  /** Whether the configured model was found on the provider */
  alive: true;
  /** The model that was validated */
  model: string;
  /** The provider that was validated */
  provider: string;
}

// ─── Model list response shapes ──────────────────────────────────────────────

interface OpenAIModelEntry {
  id: string;
}

interface OllamaModelEntry {
  name: string;
}

// ─── Model liveness check ────────────────────────────────────────────────────

/**
 * Validate that the configured model exists on the provider.
 *
 * For providers that expose a model-list API (Groq, OpenAI, Gemini, Ollama),
 * this queries the endpoint and checks for the model. For Anthropic, which
 * doesn't expose a model-list endpoint, we skip the check and trust the config
 * (a bad model name will surface as a clear API error anyway).
 *
 * Returns a LivenessResult on success, or throws ModelNotFoundError /
 * LivenessCheckError on failure.
 */
export async function validateModelLiveness(
  config: FlaughtConfig,
  options?: { timeoutMs?: number },
): Promise<LivenessResult> {
  const { provider, model } = config.llm;
  const apiKey = process.env[config.llm.api_key_env] ?? "";
  const timeoutMs = options?.timeoutMs ?? 10_000; // 10s default — this is a pre-flight check

  switch (provider) {
    case "groq":
      return checkOpenAICompatibleModel({
        baseUrl: config.llm.base_url ?? "https://api.groq.com/openai/v1",
        apiKey,
        apiKeyEnvVar: config.llm.api_key_env,
        model,
        providerName: "Groq",
        timeoutMs,
      });

    case "openai":
      return checkOpenAICompatibleModel({
        baseUrl: config.llm.base_url ?? "https://api.openai.com/v1",
        apiKey,
        apiKeyEnvVar: config.llm.api_key_env,
        model,
        providerName: "OpenAI",
        timeoutMs,
      });

    case "gemini":
      return checkOpenAICompatibleModel({
        baseUrl: config.llm.base_url ?? "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey,
        apiKeyEnvVar: config.llm.api_key_env,
        model,
        providerName: "Gemini",
        timeoutMs,
      });

    case "anthropic":
      // Anthropic doesn't have a public model-list endpoint. A bad model name
      // surfaces as a clear API error, so we skip the liveness check.
      return { alive: true, model, provider };

    case "ollama":
      return checkOllamaModel({
        baseUrl: config.llm.base_url ?? "http://localhost:11434",
        model,
        apiKey: (() => {
          // Only include API key if explicitly configured for cloud usage
          const DEFAULT_API_KEY_ENV_SENTINELS = new Set(["OPENAI_API_KEY", "GROQ_API_KEY"]);
          const isConfigured = !DEFAULT_API_KEY_ENV_SENTINELS.has(config.llm.api_key_env);
          return isConfigured ? apiKey : undefined;
        })(),
        timeoutMs,
      });

    default:
      // Unknown provider — can't validate, so skip
      return { alive: true, model, provider };
  }
}

// ─── OpenAI-compatible model check ────────────────────────────────────────────

interface OpenAICompatibleCheckOptions {
  baseUrl: string;
  apiKey: string;
  apiKeyEnvVar: string;
  model: string;
  providerName: string;
  timeoutMs: number;
}

async function checkOpenAICompatibleModel(
  opts: OpenAICompatibleCheckOptions,
): Promise<LivenessResult> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new LivenessCheckError(
      `Could not reach ${opts.providerName} to validate model "${opts.model}".\n\n` +
      `This usually means:\n` +
      `  • The ${opts.providerName} API is down or unreachable\n` +
      `  • Network connectivity issues\n\n` +
      `The review will proceed — if the model is also unavailable, you'll get a clear error then.`,
      opts.providerName,
      opts.model,
    );
  }
  clearTimeout(timeout);

  if (!response.ok) {
    // Auth errors mean the API is reachable but we can't list models — the
    // model check is inconclusive. Let the review proceed; if the model
    // is also bad, the review call itself will fail with a clear message.
    if (response.status === 401 || response.status === 403) {
      return { alive: true, model: opts.model, provider: opts.providerName.toLowerCase() };
    }
    // Other errors — likely transient, let the review proceed
    return { alive: true, model: opts.model, provider: opts.providerName.toLowerCase() };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    // Can't parse response — let the review proceed
    return { alive: true, model: opts.model, provider: opts.providerName.toLowerCase() };
  }

  // OpenAI-compatible endpoints return { data: [{ id: "model-name" }, ...] }
  const modelList = (data as Record<string, unknown>)?.data;
  if (!Array.isArray(modelList)) {
    // Unexpected response shape — let the review proceed
    return { alive: true, model: opts.model, provider: opts.providerName.toLowerCase() };
  }

  const availableModels = (modelList as OpenAIModelEntry[])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string")
    .sort();

  const modelExists = availableModels.some(
    (id) => id === opts.model || id === opts.model.toLowerCase(),
  );

  if (modelExists) {
    return { alive: true, model: opts.model, provider: opts.providerName.toLowerCase() };
  }

  // Model not found — find close matches to suggest
  const suggestions = suggestModels(opts.model, availableModels);

  throw new ModelNotFoundError(
    `Model "${opts.model}" not found on ${opts.providerName}.\n\n` +
    `Available models:\n${formatModelList(availableModels)}\n\n` +
    (suggestions.length > 0
      ? `Did you mean one of these?\n${suggestions.map((s) => `  • ${s}`).join("\n")}\n\n`
      : "") +
    `Options:\n` +
    `  • Update the model in .advreview.yml to an available model above\n` +
    `  • Switch to a different provider (e.g., openai, anthropic, ollama)\n` +
    `  • Run with --no-llm to skip the LLM review entirely`,
    opts.providerName,
    opts.model,
    availableModels,
  );
}

// ─── Ollama model check ─────────────────────────────────────────────────────

interface OllamaCheckOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

async function checkOllamaModel(opts: OllamaCheckOptions): Promise<LivenessResult> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/api/tags`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

  const headers: Record<string, string> = {};
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new LivenessCheckError(
      `Could not reach Ollama at ${opts.baseUrl} to validate model "${opts.model}".\n\n` +
      `This usually means:\n` +
      `  • Ollama is not running — start it with: ollama serve\n` +
      `  • The base_url in your config is wrong\n\n` +
      `The review will proceed — if the model is also unavailable, you'll get a clear error then.`,
      "ollama",
      opts.model,
    );
  }
  clearTimeout(timeout);

  if (!response.ok) {
    // Can't list models — let the review proceed
    return { alive: true, model: opts.model, provider: "ollama" };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { alive: true, model: opts.model, provider: "ollama" };
  }

  // Ollama returns { models: [{ name: "codellama:7b" }, ...] }
  const modelList = (data as Record<string, unknown>)?.models;
  if (!Array.isArray(modelList)) {
    return { alive: true, model: opts.model, provider: "ollama" };
  }

  // Ollama model names include tags (e.g., "codellama:7b"), strip tags for matching
  const availableModels = (modelList as OllamaModelEntry[])
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === "string")
    .sort();

  // Check exact match first, then tag-stripped match (e.g., "codellama" matches "codellama:7b")
  const modelExists = availableModels.some(
    (name) => name === opts.model || name.split(":")[0] === opts.model,
  );

  if (modelExists) {
    return { alive: true, model: opts.model, provider: "ollama" };
  }

  const suggestions = suggestModels(opts.model, availableModels);

  throw new ModelNotFoundError(
    `Model "${opts.model}" not found on Ollama.\n\n` +
    `Available models:\n${formatModelList(availableModels)}\n\n` +
    (suggestions.length > 0
      ? `Did you mean one of these?\n${suggestions.map((s) => `  • ${s}`).join("\n")}\n\n`
      : "") +
    `Options:\n` +
    `  • Pull the model: ollama pull ${opts.model}\n` +
    `  • Update the model in .advreview.yml to an available model above\n` +
    `  • Run with --no-llm to skip the LLM review entirely`,
    "ollama",
    opts.model,
    availableModels,
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Suggest models that are close matches to the requested model.
 * Uses simple heuristics: prefix match, substring match, and vendor prefix strip.
 */
function suggestModels(requested: string, available: string[]): string[] {
  const suggestions: string[] = [];
  const requestedLower = requested.toLowerCase();

  // 1. Exact prefix match (e.g., "openai/gpt-oss" → "openai/gpt-oss-20b")
  for (const m of available) {
    if (m.toLowerCase().startsWith(requestedLower) && m.toLowerCase() !== requestedLower) {
      suggestions.push(m);
    }
  }

  // 2. Same vendor prefix (e.g., "openai/gpt-oss-20b" → other "openai/*" models)
  const vendorPrefix = requestedLower.split("/")[0];
  if (vendorPrefix && requestedLower.includes("/")) {
    for (const m of available) {
      const mLower = m.toLowerCase();
      if (mLower.startsWith(vendorPrefix + "/") && mLower !== requestedLower && !suggestions.includes(m)) {
        suggestions.push(m);
      }
    }
  }

  // 3. Substring match in either direction
  const requestedShort = requestedLower.split("/").pop() ?? requestedLower;
  for (const m of available) {
    const mLower = m.toLowerCase();
    const mShort = mLower.split("/").pop() ?? mLower;
    if (
      mLower !== requestedLower &&
      !suggestions.includes(m) &&
      (mShort.includes(requestedShort) || requestedShort.includes(mShort))
    ) {
      suggestions.push(m);
    }
  }

  // Limit to top 5 suggestions
  return suggestions.slice(0, 5);
}

/**
 * Format a model list for display in error messages.
 * Shows up to 20 models, truncating if there are more.
 */
function formatModelList(models: string[]): string {
  const max = 20;
  if (models.length === 0) {
    return "  (no models available)";
  }
  const shown = models.slice(0, max);
  const lines = shown.map((m) => `  • ${m}`);
  if (models.length > max) {
    lines.push(`  ... and ${models.length - max} more`);
  }
  return lines.join("\n");
}