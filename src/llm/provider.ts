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
      return new OpenAICompatibleProvider({
        baseUrl: config.llm.base_url ?? "https://api.openai.com/v1",
        apiKey,
        model: config.llm.model,
        temperature: config.llm.temperature,
        maxTokens: config.llm.max_tokens,
      });

    case "groq":
      return new OpenAICompatibleProvider({
        baseUrl: config.llm.base_url ?? "https://api.groq.com/openai/v1",
        apiKey,
        model: config.llm.model,
        temperature: config.llm.temperature,
        maxTokens: config.llm.max_tokens,
      });

    case "gemini":
      // Gemini's OpenAI-compatible endpoint
      return new OpenAICompatibleProvider({
        baseUrl: config.llm.base_url ?? "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey,
        model: config.llm.model,
        temperature: config.llm.temperature,
        maxTokens: config.llm.max_tokens,
      });

    case "ollama":
      return new OllamaProvider({
        baseUrl: config.llm.base_url ?? "http://localhost:11434",
        model: config.llm.model,
        temperature: config.llm.temperature,
      });

    default:
      throw new Error(`Unknown LLM provider: ${config.llm.provider}`);
  }
}

// ─── OpenAI-compatible provider ──────────────────────────────────────────────

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
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
      // Request JSON output — most OpenAI-compatible providers support this
      response_format: { type: "json_object" },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey
          ? { Authorization: `Bearer ${this.config.apiKey}` }
          : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `LLM API error (${response.status}): ${errorText}`,
      );
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

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

// ─── Ollama provider ─────────────────────────────────────────────────────────

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  temperature: number;
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
      // Ollama supports JSON mode
      format: "json",
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Ollama API error (${response.status}): ${errorText}`,
      );
    }

    const data = await response.json() as {
      message: { content: string };
      model: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

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

// ─── LLM response parsing ───────────────────────────────────────────────────

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
        return []; // Can't parse at all
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

  if (!Array.isArray(rawFindings)) return [];

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

    findings.push({
      id: `F-${String(i + 1).padStart(3, "0")}`,
      severity,
      category,
      title: typeof f.title === "string" ? f.title : "Untitled finding",
      description: typeof f.description === "string" ? f.description : "",
      evidence: {
        file: typeof f.file === "string" ? f.file : (f.evidence as Record<string, unknown>)?.file as string ?? "",
        line_start: typeof f.line_start === "number" ? f.line_start : ((f.evidence as Record<string, unknown>)?.line_start as number ?? 0),
        line_end: typeof f.line_end === "number" ? f.line_end : ((f.evidence as Record<string, unknown>)?.line_end as number ?? 0),
        snippet: typeof f.snippet === "string" ? f.snippet : ((f.evidence as Record<string, unknown>)?.snippet as string ?? ""),
        blast_radius: Array.isArray((f.evidence as Record<string, unknown>)?.blast_radius)
          ? ((f.evidence as Record<string, unknown>)?.blast_radius as string[])
          : [],
      },
      source: `llm:${model}`,
      source_type: "llm",
      confidence: typeof f.confidence === "number" ? Math.min(1, Math.max(0, f.confidence)) : 0.7,
      references: Array.isArray(f.references) ? (f.references as string[]) : [],
      dismissed: false,
      dismissed_by: null,
      dismissed_at: null,
      dismissal_reason: null,
    });
  }

  return findings;
}