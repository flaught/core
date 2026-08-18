import { describe, it, expect, vi, afterEach } from "vitest";
import { parseFindingsFromLLM, createProvider, OpenAICompatibleProvider, OllamaProvider, AnthropicProvider } from "./provider.js";
import { FlaughtConfigSchema } from "../schemas/config.js";

describe("parseFindingsFromLLM", () => {
  it("parses well-formed LLM JSON response", () => {
    const raw = JSON.stringify({
      findings: [
        {
          severity: "high",
          category: "security",
          title: "SQL injection in search endpoint",
          description: "The search endpoint constructs a SQL query using string concatenation.",
          file: "src/routes/search.ts",
          line_start: 47,
          line_end: 47,
          snippet: 'db.query(`SELECT * FROM users WHERE name LIKE "%${q}%"`)',
          confidence: 0.9,
          references: ["https://owasp.org/sql-injection"],
        },
        {
          severity: "medium",
          category: "architecture",
          title: "Circular dependency between auth and user modules",
          description: "auth imports from user which imports from auth.",
          file: "src/auth/index.ts",
          line_start: 12,
          line_end: 12,
          snippet: "import { getUserById } from '../user'",
          confidence: 0.65,
          references: [],
        },
      ],
    });

    const findings = parseFindingsFromLLM(raw, "gpt-4o");

    expect(findings).toHaveLength(2);

    expect(findings[0]!.id).toBe("F-001");
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.category).toBe("security");
    expect(findings[0]!.title).toBe("SQL injection in search endpoint");
    expect(findings[0]!.source).toBe("llm:gpt-4o");
    expect(findings[0]!.source_type).toBe("llm");
    expect(findings[0]!.confidence).toBe(0.9);
    expect(findings[0]!.evidence.file).toBe("src/routes/search.ts");
    expect(findings[0]!.dismissed).toBe(false);

    expect(findings[1]!.id).toBe("F-002");
    expect(findings[1]!.severity).toBe("medium");
    expect(findings[1]!.confidence).toBe(0.65);
  });

  it("handles LLM response wrapped in markdown code blocks", () => {
    const raw = '```json\n{"findings": [{"severity": "low", "category": "maintainability", "title": "Dead code", "description": "Unused import.", "file": "src/app.ts", "line_start": 1, "line_end": 1, "snippet": "import { unused }", "confidence": 0.8}]}\n```';

    const findings = parseFindingsFromLLM(raw, "test-model");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("low");
  });

  it("handles LLM response that is just a JSON array", () => {
    const raw = JSON.stringify([
      {
        severity: "info",
        category: "maintainability",
        title: "Consider naming",
        description: "Variable name is unclear.",
        file: "src/main.ts",
        line_start: 10,
        line_end: 10,
        snippet: "const x = 1",
        confidence: 0.5,
      },
    ]);

    const findings = parseFindingsFromLLM(raw, "test-model");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("info");
  });

  it("defaults missing fields gracefully", () => {
    const raw = JSON.stringify({
      findings: [
        {
          title: "Something bad",
          description: "Very bad",
          // missing severity, category, file, etc.
        },
      ],
    });

    const findings = parseFindingsFromLLM(raw, "test-model");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium"); // default
    expect(findings[0]!.category).toBe("architecture"); // default
    expect(findings[0]!.confidence).toBe(0.7); // default
    expect(findings[0]!.evidence.file).toBe("");
    expect(findings[0]!.dismissed).toBe(false);
  });

  it("clamps confidence to 0-1 range", () => {
    const raw = JSON.stringify({
      findings: [
        {
          severity: "high",
          category: "security",
          title: "Test",
          description: "Test",
          file: "a.ts",
          line_start: 1,
          line_end: 1,
          snippet: "code",
          confidence: 1.5, // out of range
        },
      ],
    });

    const findings = parseFindingsFromLLM(raw, "test-model");
    expect(findings[0]!.confidence).toBe(1);
  });

  it("handles invalid JSON gracefully", () => {
    const findings = parseFindingsFromLLM("not json at all", "test-model");
    expect(findings).toHaveLength(0);
  });

  it("handles empty findings array", () => {
    const findings = parseFindingsFromLLM('{"findings": []}', "test-model");
    expect(findings).toHaveLength(0);
  });

  it("skips malformed individual findings without failing entirely", () => {
    const raw = JSON.stringify({
      findings: [
        {
          severity: "high",
          category: "security",
          title: "Good finding",
          description: "Well-formed",
          file: "a.ts",
          line_start: 1,
          line_end: 1,
          snippet: "code",
          confidence: 0.9,
        },
        null, // malformed
        {
          severity: "low",
          category: "maintainability",
          title: "Another good one",
          description: "Also well-formed",
          file: "b.ts",
          line_start: 2,
          line_end: 2,
          snippet: "code",
          confidence: 0.6,
        },
      ],
    });

    const findings = parseFindingsFromLLM(raw, "test-model");
    expect(findings).toHaveLength(2); // null entry skipped
    expect(findings[0]!.title).toBe("Good finding");
    expect(findings[1]!.title).toBe("Another good one");
  });

  it("handles evidence in nested format from LLM", () => {
    const raw = JSON.stringify({
      findings: [
        {
          severity: "high",
          category: "security",
          title: "SQL injection",
          description: "Injection vulnerability",
          evidence: {
            file: "src/routes.ts",
            line_start: 10,
            line_end: 10,
            snippet: "db.query(x)",
            blast_radius: ["src/db.ts:5"],
          },
          confidence: 0.95,
        },
      ],
    });

    const findings = parseFindingsFromLLM(raw, "test-model");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.file).toBe("src/routes.ts");
    expect(findings[0]!.evidence.blast_radius).toEqual(["src/db.ts:5"]);
  });
});

describe("createProvider", () => {
  it("creates an OpenAI-compatible provider for openai config", () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "openai", model: "gpt-4o" },
    });
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.name).toBe("openai-compatible");
    expect(provider.model).toBe("gpt-4o");
  });

  it("creates an OpenAI-compatible provider for groq config", () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "groq", model: "llama-3.1-70b" },
    });
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.model).toBe("llama-3.1-70b");
  });

  it("creates an Ollama provider for ollama config", () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "ollama", model: "codellama" },
    });
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.model).toBe("codellama");
  });

  it("creates a Gemini provider (OpenAI-compatible endpoint)", () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "gemini", model: "gemini-1.5-pro" },
    });
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("throws MissingAPIKeyError when OpenAI key is missing", () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "openai", model: "gpt-4o" },
    });
    // Ensure the env var is not set
    delete process.env.OPENAI_API_KEY;
    expect(() => createProvider(config)).toThrow(/Missing API key/);
  });

  it("throws MissingAPIKeyError when Groq key is missing", () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "groq", model: "llama-3.1-70b" },
    });
    delete process.env.GROQ_API_KEY;
    expect(() => createProvider(config)).toThrow(/Missing API key/);
  });

  it("throws MissingAPIKeyError when Gemini key is missing", () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "gemini", model: "gemini-1.5-pro" },
    });
    delete process.env.GEMINI_API_KEY;
    expect(() => createProvider(config)).toThrow(/Missing API key/);
  });

  it("does not require an API key for Ollama", () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "ollama", model: "codellama" },
    });
    // Should not throw — Ollama doesn't need an API key
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it("creates an Anthropic provider for anthropic config", () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "anthropic", model: "claude-sonnet-5", api_key_env: "ANTHROPIC_API_KEY" },
    });
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe("anthropic");
    expect(provider.model).toBe("claude-sonnet-5");
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("throws MissingAPIKeyError when Anthropic key is missing", () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "anthropic", model: "claude-sonnet-5", api_key_env: "ANTHROPIC_API_KEY" },
    });
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => createProvider(config)).toThrow(/Missing API key/);
  });

  it("respects a custom base_url for the Anthropic provider (proxy/gateway support)", () => {
    const config = FlaughtConfigSchema.parse({
      llm: {
        provider: "anthropic",
        model: "claude-opus-5",
        api_key_env: "ANTHROPIC_API_KEY",
        base_url: "https://my-proxy.internal/anthropic",
      },
    });
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(AnthropicProvider);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("throws for unknown provider", () => {
    expect(() => {
      createProvider({ llm: { provider: "invalid", model: "x" } } as any);
    }).toThrow(/Unknown LLM provider/);
  });
});

describe("AnthropicProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetchOnce(responseBody: unknown, ok = true): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 401,
      json: async () => responseBody,
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends the Messages API shape: top-level system, x-api-key/anthropic-version headers, no Authorization header", async () => {
    const fetchMock = mockFetchOnce({
      content: [{ type: "text", text: '{"findings":[]}' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const provider = new AnthropicProvider({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-test",
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      model: "claude-sonnet-5",
      temperature: 0.2,
      maxTokens: 4096,
      timeoutSeconds: 30,
    });

    const result = await provider.review("system prompt", "user prompt");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");

    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Authorization"]).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.system).toBe("system prompt");
    expect(body.messages).toEqual([{ role: "user", content: "user prompt" }]);
    expect(body.max_tokens).toBe(4096);
    expect(body.model).toBe("claude-sonnet-5");

    expect(result.model).toBe("llm:claude-sonnet-5");
    expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  });

  it("extracts the text block from Anthropic's content array and parses findings", async () => {
    mockFetchOnce({
      content: [
        { type: "text", text: '{"findings":[{"severity":"high","category":"security","title":"SQLi","description":"...","file":"a.ts","line_start":1,"line_end":1,"snippet":"x","confidence":0.9}]}' },
      ],
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    const provider = new AnthropicProvider({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-test",
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      model: "claude-opus-5",
      temperature: 0.2,
      maxTokens: 4096,
      timeoutSeconds: 30,
    });

    const result = await provider.review("system", "user");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe("SQLi");
    expect(result.findings[0]!.source).toBe("llm:claude-opus-5");
  });

  it("classifies a 401 with the configured Anthropic env var in the message", async () => {
    mockFetchOnce({ error: { type: "authentication_error", message: "invalid x-api-key" } }, false);

    const provider = new AnthropicProvider({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "bad-key",
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      model: "claude-sonnet-5",
      temperature: 0.2,
      maxTokens: 4096,
      timeoutSeconds: 30,
    });

    await expect(provider.review("system", "user")).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});