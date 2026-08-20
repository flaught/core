/**
 * LLM provider interface — swappable behind a single adapter pattern.
 *
 * Each provider implements one method: `review()`, which takes the assembled
 * context and a system prompt, and returns structured findings.
 *
 * The OpenAI-compatible adapter covers OpenAI, Groq, Together, and any
 * provider that exposes an OpenAI-style /chat/completions endpoint.
 * The Ollama adapter covers local models.
 */

import type { Finding, Severity, Category } from "../schemas/findings.js";
import { computeFingerprint } from "../dismissals/fingerprint.js";

// ─── Custom error classes ────────────────────────────────────────────────────

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly model: string,
    public readonly statusCode?: number,
    public readonly raw?: string,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export class MissingAPIKeyError extends LLMError {
  constructor(
    public readonly envVarName: string,
    provider: string,
  ) {
    super(
      `Missing API key. Set the ${envVarName} environment variable to use the ${provider} provider.\n\n` +
      `Options:\n` +
      `  1. Set the key: export ${envVarName}=sk-...\n` +
      `  2. Use a different provider in .advreview.yml:\n` +
      `       llm:\n` +
      `         provider: ollama\n` +
      `         model: codellama\n` +
      `  3. Skip the LLM review entirely: flaught review --no-llm`,
      provider,
      "unknown",
    );
    this.name = "MissingAPIKeyError";
  }
}

// ─── Provider interface ─────────────────────────────────────────────────────

export interface LLMProvider {
  /** Human-readable provider name */
  name: string;

  /** The model identifier being used */
  model: string;

  /**
   * Run the adversarial review and return structured findings.
   *
   * @param systemPrompt - The adversarial review system prompt
   * @param userPrompt - The diff, context, and review instructions
   * @returns Structured findings from the LLM
   */
  review(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<LLMReviewResult>;
}

export interface LLMReviewResult {
  /** Structured findings parsed from the LLM response */
  findings: Finding[];
  /** Raw LLM response text (for debugging/audit) */
  raw: string;
  /** Model that produced this review (e.g. "llm:gpt-4o") */
  model: string;
  /** Token usage if available */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ─── Provider factory ────────────────────────────────────────────────────────

import type { FlaughtConfig } from "../schemas/config.js";

export function createProvider(config: FlaughtConfig): LLMProvider {
  const apiKey = process.env[config.llm.api_key_env] ?? "";

  switch (config.llm.provider) {
    case "openai":
      if (!apiKey) {
        throw new MissingAPIKeyError(config.llm.api_key_env, "OpenAI");
      }
      return new OpenAICompatibleProvider({
        baseUrl: config.llm.base_url ?? "https://api.openai.com/v1",
        apiKey,
        apiKeyEnvVar: config.llm.api_key_env,
        model: config.llm.model,
        temperature: config.llm.temperature,
        maxTokens: config.llm.max_tokens,
        timeoutSeconds: config.llm.timeout_seconds,
      });

    case "groq":
      if (!apiKey) {
        throw new MissingAPIKeyError(config.llm.api_key_env, "Groq");
      }
      return new OpenAICompatibleProvider({
        baseUrl: config.llm.base_url ?? "https://api.groq.com/openai/v1",
        apiKey,
        apiKeyEnvVar: config.llm.api_key_env,
        model: config.llm.model,
        temperature: config.llm.temperature,
        maxTokens: config.llm.max_tokens,
        timeoutSeconds: config.llm.timeout_seconds,
      });

    case "gemini":
      if (!apiKey) {
        throw new MissingAPIKeyError(config.llm.api_key_env, "Gemini");
      }
      return new OpenAICompatibleProvider({
        baseUrl: config.llm.base_url ?? "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey,
        apiKeyEnvVar: config.llm.api_key_env,
        model: config.llm.model,
        temperature: config.llm.temperature,
        maxTokens: config.llm.max_tokens,
        timeoutSeconds: config.llm.timeout_seconds,
      });

    case "anthropic":
      if (!apiKey) {
        throw new MissingAPIKeyError(config.llm.api_key_env, "Anthropic");
      }
      // baseUrl is overridable so this same adapter reaches any
      // Messages-API-compatible endpoint — a corporate proxy, a self-hosted
      // gateway, or a future Anthropic-compatible provider — not just
      // api.anthropic.com. model is a free-form string, so any current or
      // future Claude model (or a differently-named model behind a
      // compatible proxy) works without a code change.
      return new AnthropicProvider({
        baseUrl: config.llm.base_url ?? "https://api.anthropic.com/v1",
        apiKey,
        apiKeyEnvVar: config.llm.api_key_env,
        model: config.llm.model,
        temperature: config.llm.temperature,
        maxTokens: config.llm.max_tokens,
        timeoutSeconds: config.llm.timeout_seconds,
      });

    case "ollama": {
      // Local Ollama needs no API key. Ollama Cloud (:cloud-tagged models,
      // base_url: https://ollama.com) needs Authorization: Bearer — same
      // /api/chat endpoint shape either way. Only attach a key when the
      // user has explicitly pointed api_key_env somewhere other than the
      // schema's default ("OPENAI_API_KEY") — otherwise a user who has
      // OPENAI_API_KEY set for unrelated reasons would silently leak it as
      // a bearer header to whatever base_url their Ollama config points at.
      const ollamaApiKeyConfigured = config.llm.api_key_env !== "OPENAI_API_KEY";
      return new OllamaProvider({
        baseUrl: config.llm.base_url ?? "http://localhost:11434",
        model: config.llm.model,
        temperature: config.llm.temperature,
        timeoutSeconds: config.llm.timeout_seconds,
        apiKey: ollamaApiKeyConfigured ? (apiKey || undefined) : undefined,
        // Only set when opted in, so a plain local config never surfaces an
        // "OPENAI_API_KEY" hint in error messages for a provider that
        // doesn't need one.
        apiKeyEnvVar: ollamaApiKeyConfigured ? config.llm.api_key_env : undefined,
      });
    }

    default:
      throw new LLMError(
        `Unknown LLM provider: ${config.llm.provider}. Supported providers: openai, groq, gemini, anthropic, ollama`,
        config.llm.provider,
        config.llm.model,
      );
  }
}

// ─── OpenAI-compatible provider ──────────────────────────────────────────────

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  apiKeyEnvVar: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
}

export class OpenAICompatibleProvider implements LLMProvider {
  name: string;
  model: string;
  private config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.config = config;
    this.name = "openai-compatible";
    this.model = config.model;
  }

  async review(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<LLMReviewResult> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    const body = {
      model: this.config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      response_format: { type: "json_object" },
    };

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutSeconds * 1000);
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new LLMError(
          `Request to ${this.config.model} timed out after ${this.config.timeoutSeconds}s.\n\n` +
          `This usually means the diff is too large or the model is slow to respond.\n\n` +
          `Options:\n` +
          `  • Increase timeout in .advreview.yml: llm.timeout_seconds: 300\n` +
          `  • Use a faster model (e.g., groq with llama-3.1-70b)\n` +
          `  • Run with --no-llm to skip the LLM review entirely`,
          this.name,
          this.model,
        );
      }
      throw new LLMError(
        `Could not reach ${this.config.model} at ${this.config.baseUrl}.\n\n` +
        `This usually means:\n` +
        `  • The model name is misspelled in .advreview.yml\n` +
        `  • The API endpoint is down or unreachable\n` +
        `  • The base_url in your config is wrong\n\n` +
        `Run with --no-llm to skip the LLM review entirely.`,
        this.name,
        this.model,
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }

    if (!response.ok) {
      clearTimeout(timeout);
      throw await classifyHttpError(response, this.config.baseUrl, this.config.model, this.name, this.config.apiKeyEnvVar);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    clearTimeout(timeout);
    const raw = data.choices[0]?.message?.content ?? "";
    const findings = parseFindingsFromLLM(raw, this.config.model);

    return {
      findings,
      raw,
      model: `llm:${this.config.model}`,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.prompt_tokens,
            completion_tokens: data.usage.completion_tokens,
            total_tokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }
}

// ─── Anthropic provider ───────────────────────────────────────────────────────
//
// Anthropic's Messages API has a genuinely different wire shape from the
// OpenAI-style /chat/completions convention — system prompt as a top-level
// field (not a message), x-api-key + anthropic-version headers instead of
// Authorization: Bearer, content as an array of typed blocks, and
// usage.input_tokens/output_tokens instead of prompt_tokens/completion_tokens.
// It cannot reuse OpenAICompatibleProvider; this adapter targets that shape
// directly. baseUrl and model are both free-form config, so this same class
// reaches any current or future Claude model, and any Messages-API-compatible
// endpoint (a proxy, a gateway) via base_url — not just api.anthropic.com.

const ANTHROPIC_API_VERSION = "2023-06-01";

export interface AnthropicConfig {
  baseUrl: string;
  apiKey: string;
  apiKeyEnvVar: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
}

export class AnthropicProvider implements LLMProvider {
  name: string;
  model: string;
  private config: AnthropicConfig;

  constructor(config: AnthropicConfig) {
    this.config = config;
    this.name = "anthropic";
    this.model = config.model;
  }

  async review(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<LLMReviewResult> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/messages`;

    const body = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    };

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutSeconds * 1000);
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new LLMError(
          `Request to ${this.config.model} timed out after ${this.config.timeoutSeconds}s.\n\n` +
          `This usually means the diff is too large or the model is slow to respond.\n\n` +
          `Options:\n` +
          `  • Increase timeout in .advreview.yml: llm.timeout_seconds: 300\n` +
          `  • Use a faster model (e.g., claude-haiku-4-5)\n` +
          `  • Run with --no-llm to skip the LLM review entirely`,
          this.name,
          this.model,
        );
      }
      throw new LLMError(
        `Could not reach ${this.config.model} at ${this.config.baseUrl}.\n\n` +
        `This usually means:\n` +
        `  • The model name is misspelled in .advreview.yml\n` +
        `  • The API endpoint is down or unreachable\n` +
        `  • The base_url in your config is wrong\n\n` +
        `Run with --no-llm to skip the LLM review entirely.`,
        this.name,
        this.model,
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }

    if (!response.ok) {
      clearTimeout(timeout);
      throw await classifyHttpError(response, this.config.baseUrl, this.config.model, this.name, this.config.apiKeyEnvVar);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };

    clearTimeout(timeout);
    const raw = data.content?.find((block) => block.type === "text")?.text ?? "";
    const findings = parseFindingsFromLLM(raw, this.config.model);

    return {
      findings,
      raw,
      model: `llm:${this.config.model}`,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.input_tokens,
            completion_tokens: data.usage.output_tokens,
            total_tokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined,
    };
  }
}

// ─── Ollama provider ─────────────────────────────────────────────────────────

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutSeconds: number;
  /**
   * Optional — the local Ollama server has no auth, but Ollama Cloud
   * (`:cloud`-tagged models, served from https://ollama.com) requires an
   * `Authorization: Bearer` header. Same endpoint shape (/api/chat) either
   * way; only the header changes. Leave unset for local usage.
   */
  apiKey?: string;
  apiKeyEnvVar?: string;
}

export class OllamaProvider implements LLMProvider {
  name: string;
  model: string;
  private config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.config = config;
    this.name = "ollama";
    this.model = config.model;
  }

  async review(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<LLMReviewResult> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/api/chat`;

    const body = {
      model: this.config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
      options: {
        temperature: this.config.temperature,
      },
      format: "json",
    };

    // apiKeyEnvVar being set (regardless of whether the env var actually
    // resolved to a value) means the user configured this for cloud auth —
    // distinct from apiKey being truthy, so a misconfigured (empty) key
    // still gets the specific "set OLLAMA_API_KEY" hint instead of the
    // generic local-usage one.
    const isCloud = Boolean(this.config.apiKey) || Boolean(this.config.apiKeyEnvVar);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutSeconds * 1000);
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new LLMError(
          `Request to ${this.config.model} timed out after ${this.config.timeoutSeconds}s.\n\n` +
          `This usually means the diff is too large or the model is slow to respond.\n\n` +
          `Options:\n` +
          `  • Increase timeout in .advreview.yml: llm.timeout_seconds: 300\n` +
          `  • Use a faster/smaller model\n` +
          `  • Run with --no-llm to skip the LLM review entirely`,
          this.name,
          this.model,
        );
      }
      throw new LLMError(
        `Could not reach Ollama at ${this.config.baseUrl}.\n\n` +
        `This usually means:\n` +
        `  • The model name is misspelled in .advreview.yml\n` +
        (isCloud
          ? `  • ollama.com is unreachable, or the base_url in your config is wrong\n\n`
          : `  • Ollama is not running — start it with: ollama serve\n` +
            `  • The base_url in your config is wrong\n\n`) +
        `Run with --no-llm to skip the LLM review entirely.`,
        this.name,
        this.model,
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }

    if (!response.ok) {
      clearTimeout(timeout);
      throw await classifyHttpError(
        response,
        this.config.baseUrl,
        this.config.model,
        this.name,
        this.config.apiKeyEnvVar ?? null,
      );
    }

    const data = await response.json() as {
      message: { content: string };
      model: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    clearTimeout(timeout);
    const raw = data.message?.content ?? "";
    const findings = parseFindingsFromLLM(raw, this.config.model);

    return {
      findings,
      raw,
      model: `llm:${this.config.model}`,
      usage: data.prompt_eval_count !== undefined
        ? {
            prompt_tokens: data.prompt_eval_count,
            completion_tokens: data.eval_count ?? 0,
            total_tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
          }
        : undefined,
    };
  }
}

// ─── HTTP error classification ────────────────────────────────────────────────

async function classifyHttpError(
  response: Response,
  _baseUrl: string,
  model: string,
  providerName: string,
  apiKeyEnvVar: string | null,
): Promise<LLMError> {
  const status = response.status;
  // Ollama has no API key (apiKeyEnvVar is null there) — keep the hint generic in that case.
  const setKeyHint = apiKeyEnvVar
    ? `Set the key: export ${apiKeyEnvVar}=...`
    : `Check that the server is reachable and configured correctly`;
  const checkKeyHint = apiKeyEnvVar
    ? `Make sure the key is set: echo $${apiKeyEnvVar}`
    : `Check that the server is reachable and configured correctly`;

  switch (status) {
    case 400: {
      // Bad request — usually model-specific limitations (JSON mode not supported,
      // invalid parameters, etc.). Include the provider's error message for debugging.
      let detail = "";
      try {
        const body = await response.clone().json().catch(() => ({} as Record<string, unknown>));
        const msg = (body as Record<string, unknown>)?.error;
        if (typeof msg === "object" && msg !== null && typeof (msg as Record<string, unknown>).message === "string") {
          detail = (msg as Record<string, unknown>).message as string;
        } else if (typeof (body as Record<string, unknown>).message === "string") {
          detail = (body as Record<string, unknown>).message as string;
        }
      } catch { /* ignore parse errors */ }
      return new LLMError(
        `Bad request from ${providerName} for model "${model}" (${status}).${detail ? `\n\n${detail}` : ""}\n\n` +
        `This usually means the model doesn't support a feature Flaught uses (e.g. JSON mode), or the request parameters are invalid.\n\n` +
        `Options:\n` +
        `  • Switch to a different model in .advreview.yml (groq/compound-mini and openai/gpt-oss-120b are known to work on Groq)\n` +
        `  • Switch to a different provider (openai, anthropic, ollama)\n` +
        `  • Run with --no-llm to skip the LLM review entirely`,
        providerName,
        model,
        status,
      );
    }

    case 401:
      return new LLMError(
        `API key not configured or not valid for ${model}.\n\n` +
        `This usually means the key is missing, empty, expired, or invalid.\n\n` +
        `Options:\n` +
        `  • ${setKeyHint}\n` +
        `  • Check that the key in .advreview.yml (llm.api_key_env) points to a set env var\n` +
        `  • Switch to a different provider in .advreview.yml (e.g., groq, anthropic, ollama)\n` +
        `  • Run with --no-llm to skip the LLM review entirely`,
        providerName,
        model,
        status,
      );

    case 403:
      return new LLMError(
        `API key not configured or not valid for ${model}.\n\n` +
        `Your key doesn't have access to this model or endpoint.\n\n` +
        `Options:\n` +
        `  • Check that the key is set and has the right permissions\n` +
        `  • Switch to a different provider in .advreview.yml\n` +
        `  • Run with --no-llm to skip the LLM review entirely`,
        providerName,
        model,
        status,
      );

    case 429:
      return new LLMError(
        `Rate limited by ${providerName} for model "${model}".\n\n` +
        `This means you've hit the rate limit on your plan (free tier: 30 RPM, 6K TPM).\n\n` +
        `Options:\n` +
        `  • Wait a minute and retry\n` +
        `  • Upgrade your ${providerName === "groq" ? "Groq" : providerName} plan for higher limits\n` +
        `  • Switch to a different provider in .advreview.yml (e.g., openai, anthropic, ollama)\n` +
        `  • Run with --no-llm to skip the LLM review entirely`,
        providerName,
        model,
        status,
      );

    case 404:
      return new LLMError(
        `Model "${model}" not found.\n\n` +
        `This usually means the model name in your .advreview.yml is misspelled or deprecated.\n\n` +
        `Options:\n` +
        `  • Fix the model name in .advreview.yml\n` +
        `  • Run with --no-llm to skip the LLM review entirely`,
        providerName,
        model,
        status,
      );

    case 500:
    case 502:
    case 503:
    case 529: // Anthropic's overloaded_error
      return new LLMError(
        `${model} provider is down or overloaded (${status}). Try again in a few minutes.\n\n` +
        `Run with --no-llm to skip the LLM review entirely.`,
        providerName,
        model,
        status,
      );

    default:
      return new LLMError(
        `API key not configured or not valid for ${model} (${status}).\n\n` +
        `Options:\n` +
        `  • ${checkKeyHint}\n` +
        `  • Switch to a different provider in .advreview.yml\n` +
        `  • Run with --no-llm to skip the LLM review entirely`,
        providerName,
        model,
        status,
      );
  }
}

// ─── LLM response parsing ────────────────────────────────────────────────────

/**
 * Parse the LLM's JSON response into structured Findings.
 *
 * The LLM is instructed to return a JSON object with a `findings` array.
 * Each finding may be partially malformed — we parse what we can and
 * skip entries that are missing required fields rather than failing entirely.
 */
export function parseFindingsFromLLM(
  raw: string,
  model: string,
): Finding[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    // If the LLM didn't return valid JSON, try to extract JSON from
    // markdown code blocks (some models wrap JSON in ```json ... ```)
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

  // The LLM may return { findings: [...] } or just [...]
  const maybeFindings = (parsed as Record<string, unknown>).findings;
  const rawFindings: unknown[] = Array.isArray(parsed)
    ? parsed as unknown[]
    : Array.isArray(maybeFindings)
      ? maybeFindings as unknown[]
      : [];

  const findings: Finding[] = [];
  const validSeverities = new Set<Severity>(["critical", "high", "medium", "low", "info"]);
  const validCategories = new Set<Category>(["security", "architecture", "scope-creep", "test-quality", "performance", "maintainability"]);

  for (let i = 0; i < rawFindings.length; i++) {
    const f = rawFindings[i] as Record<string, unknown>;
    if (!f || typeof f !== "object") continue;

    const severity = validSeverities.has(f.severity as Severity)
      ? (f.severity as Severity)
      : "medium";

    const category = validCategories.has(f.category as Category)
      ? (f.category as Category)
      : "architecture";

    const title = typeof f.title === "string" ? f.title : "Untitled finding";
    const evidence = {
      file: typeof f.file === "string" ? f.file : (f.evidence as Record<string, unknown>)?.file as string ?? "",
      line_start: typeof f.line_start === "number" ? f.line_start : ((f.evidence as Record<string, unknown>)?.line_start as number ?? 0),
      line_end: typeof f.line_end === "number" ? f.line_end : ((f.evidence as Record<string, unknown>)?.line_end as number ?? 0),
      snippet: typeof f.snippet === "string" ? f.snippet : ((f.evidence as Record<string, unknown>)?.snippet as string ?? ""),
      blast_radius: Array.isArray((f.evidence as Record<string, unknown>)?.blast_radius)
        ? ((f.evidence as Record<string, unknown>)?.blast_radius as string[])
        : [],
      rule_id: null,
    };

    findings.push({
      id: `F-${String(i + 1).padStart(3, "0")}`,
      severity,
      category,
      title,
      description: typeof f.description === "string" ? f.description : "",
      evidence,
      source: `llm:${model}`,
      source_type: "llm",
      confidence: typeof f.confidence === "number" ? Math.min(1, Math.max(0, f.confidence)) : 0.7,
      references: Array.isArray(f.references) ? (f.references as string[]) : [],
      fingerprint: computeFingerprint({
        source_type: "llm",
        source: `llm:${model}`,
        category,
        title,
        evidence: { file: evidence.file, rule_id: null },
      }),
      dismissed: false,
      dismissed_by: null,
      dismissed_at: null,
      dismissal_reason: null,
    });
  }

  return findings;
}