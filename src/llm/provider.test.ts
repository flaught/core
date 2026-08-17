import { describe, it, expect } from "vitest";
import { parseFindingsFromLLM, createProvider, OpenAICompatibleProvider, OllamaProvider } from "./provider.js";
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

  it("throws for unknown provider", () => {
    // This would need to bypass Zod validation, so we test it differently
    // The Zod schema only allows valid providers, so this is a defensive check
    // Zod only allows valid providers, so we test the defensive check directly
    expect(() => {
      createProvider({ llm: { provider: "invalid", model: "x" } } as any);
    }).toThrow();
  });
});