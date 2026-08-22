import { describe, it, expect, vi, afterEach } from "vitest";
import { REFUTE_SYSTEM_PROMPT, buildRefuteUserPrompt, parseRefuteResponse } from "./prompt.js";
import { runRefutePass } from "./runner.js";
import type { Finding } from "../schemas/findings.js";
import type { ReviewContext } from "../context/assembler.js";
import { FlaughtConfigSchema } from "../schemas/config.js";

// Captures every config createProvider was called with, so tests can assert
// which provider/model the refute pass actually resolved to without a real
// network call.
const { mockCreateProvider, mockReview, capturedConfigs } = vi.hoisted(() => {
  const capturedConfigs: unknown[] = [];
  const mockReview = vi.fn().mockResolvedValue({
    findings: [],
    raw: JSON.stringify({
      evaluations: [{ finding_index: 0, verdict: "confirmed", reasoning: "ok", adjusted_confidence: 0.9 }],
    }),
    model: "test",
  });
  const mockCreateProvider = vi.fn((config: unknown) => {
    capturedConfigs.push(config);
    return { review: mockReview };
  });
  return { mockCreateProvider, mockReview, capturedConfigs };
});

vi.mock("../llm/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/provider.js")>();
  return { ...actual, createProvider: mockCreateProvider };
});

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    severity: "high",
    category: "security",
    title: "SQL injection in search endpoint",
    description: "The search endpoint constructs a SQL query using string concatenation.",
    evidence: {
      file: "src/routes/search.ts",
      line_start: 47,
      line_end: 47,
      snippet: 'db.query(`SELECT * FROM users WHERE name LIKE "%${q}%"`)',
      blast_radius: [],
      rule_id: null,
    },
    source: "llm:gpt-4o",
    source_type: "llm",
    confidence: 0.9,
    references: [],
    fingerprint: "sha256:test-fixture-fingerprint",
    dismissed: false,
    dismissed_by: null,
    dismissed_at: null,
    dismissal_reason: null,
    refute_result: null,
    ...overrides,
  };
}

// ─── System prompt ────────────────────────────────────────────────────────────

describe("REFUTE_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(REFUTE_SYSTEM_PROMPT).toBeTruthy();
    expect(REFUTE_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it("instructs the skeptic to default to doubt", () => {
    expect(REFUTE_SYSTEM_PROMPT).toContain("Default to doubt");
  });

  it("requires specific reasoning for confirmation", () => {
    expect(REFUTE_SYSTEM_PROMPT).toContain("Vague agreement");
  });

  it("defines all three verdicts", () => {
    expect(REFUTE_SYSTEM_PROMPT).toContain("confirmed");
    expect(REFUTE_SYSTEM_PROMPT).toContain("refuted");
    expect(REFUTE_SYSTEM_PROMPT).toContain("uncertain");
  });
});

// ─── User prompt builder ──────────────────────────────────────────────────────

describe("buildRefuteUserPrompt", () => {
  it("includes findings in the prompt", () => {
    const findings = [
      makeFinding({ id: "F-001", title: "SQL injection", severity: "critical" }),
    ];

    const prompt = buildRefuteUserPrompt(
      findings,
      "diff --git a/file.ts b/file.ts\n+unsafe code",
      new Map([["src/routes/search.ts", "const q = req.query.q;\ndb.query(`SELECT * FROM users WHERE name LIKE \"%${q}%\"`);"]]),
      new Map(),
    );

    expect(prompt).toContain("SQL injection");
    expect(prompt).toContain("CRITICAL");
    expect(prompt).toContain("Findings to Evaluate");
    expect(prompt).toContain("Unified Diff");
  });

  it("includes only LLM findings in the prompt", () => {
    const findings = [
      makeFinding({ id: "D-0001", source: "semgrep", source_type: "deterministic", title: "Deterministic finding" }),
    ];

    // This shouldn't happen in practice (we filter before calling), but the prompt
    // builder shouldn't crash — it just formats whatever it receives.
    const prompt = buildRefuteUserPrompt(
      findings,
      null,
      new Map(),
      new Map(),
    );

    expect(prompt).toContain("Deterministic finding");
  });

  it("includes JSON output format instructions", () => {
    const findings = [makeFinding()];

    const prompt = buildRefuteUserPrompt(
      findings,
      null,
      new Map(),
      new Map(),
    );

    expect(prompt).toContain("evaluations");
    expect(prompt).toContain("verdict");
    expect(prompt).toContain("reasoning");
    expect(prompt).toContain("adjusted_confidence");
  });

  it("handles multiple findings", () => {
    const findings = [
      makeFinding({ id: "F-001", title: "Finding 1" }),
      makeFinding({ id: "F-002", title: "Finding 2", severity: "medium" }),
    ];

    const prompt = buildRefuteUserPrompt(
      findings,
      null,
      new Map(),
      new Map(),
    );

    expect(prompt).toContain("Finding 1");
    expect(prompt).toContain("Finding 2");
    expect(prompt).toContain("2 finding");
  });
});

// ─── Parse refute response ─────────────────────────────────────────────────────

describe("parseRefuteResponse", () => {
  it("parses a valid JSON response", () => {
    const response = JSON.stringify({
      evaluations: [
        {
          finding_index: 0,
          verdict: "confirmed",
          reasoning: "The SQL injection is clearly visible on line 47.",
          adjusted_confidence: 0.92,
        },
        {
          finding_index: 1,
          verdict: "refuted",
          reasoning: "The variable is sanitized before use.",
          adjusted_confidence: 0.1,
        },
      ],
    });

    const result = parseRefuteResponse(response);
    expect(result).toHaveLength(2);
    expect(result[0]!.verdict).toBe("confirmed");
    expect(result[0]!.reasoning).toContain("SQL injection");
    expect(result[0]!.adjusted_confidence).toBe(0.92);
    expect(result[1]!.verdict).toBe("refuted");
    expect(result[1]!.adjusted_confidence).toBe(0.1);
  });

  it("parses a response wrapped in markdown code blocks", () => {
    const response = '```json\n{"evaluations": [{"finding_index": 0, "verdict": "uncertain", "reasoning": "Cannot verify from context.", "adjusted_confidence": 0.45}]}\n```';

    const result = parseRefuteResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0]!.verdict).toBe("uncertain");
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseRefuteResponse("not json")).toEqual([]);
    expect(parseRefuteResponse("")).toEqual([]);
  });

  it("defaults uncertain for invalid verdicts", () => {
    const response = JSON.stringify({
      evaluations: [
        {
          finding_index: 0,
          verdict: "maybe",
          reasoning: "Not sure",
          adjusted_confidence: 0.5,
        },
      ],
    });

    const result = parseRefuteResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0]!.verdict).toBe("uncertain");
  });

  it("clamps adjusted_confidence to 0-1 range", () => {
    const response = JSON.stringify({
      evaluations: [
        {
          finding_index: 0,
          verdict: "confirmed",
          reasoning: "Confirmed",
          adjusted_confidence: 1.5,
        },
      ],
    });

    const result = parseRefuteResponse(response);
    expect(result[0]!.adjusted_confidence).toBe(1);
  });

  it("defaults adjusted_confidence to 0.5 for missing values", () => {
    const response = JSON.stringify({
      evaluations: [
        {
          finding_index: 0,
          verdict: "uncertain",
          reasoning: "Cannot tell",
        },
      ],
    });

    const result = parseRefuteResponse(response);
    expect(result[0]!.adjusted_confidence).toBe(0.5);
  });

  it("handles a plain array response (not wrapped in evaluations key)", () => {
    const response = JSON.stringify([
      {
        finding_index: 0,
        verdict: "confirmed",
        reasoning: "Looks right",
        adjusted_confidence: 0.85,
      },
    ]);

    const result = parseRefuteResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0]!.verdict).toBe("confirmed");
  });
});

// ─── Refute provider/model resolution (createRefuteProvider via runRefutePass) ─

function mockContext(): ReviewContext {
  return {
    diff: 'diff --git a/src/app.ts b/src/app.ts\n+export const app = {};\n',
    changedFiles: [{ path: "src/app.ts", additions: 1, deletions: 0, status: "modified" as const }],
    neighborhoodFiles: [],
    changedFileContents: new Map([["src/app.ts", "export const app = {};\n"]]),
    neighborhoodFileContents: new Map(),
    dependencyGraph: {
      getDependentsOf: () => [],
      getDependenciesOf: () => [],
      getImportsFor: () => [],
      getAllFiles: () => ["src/app.ts"],
    },
    baseSha: "abc123",
    headSha: "def456",
    repoRoot: "/tmp/test-repo",
  };
}

describe("runRefutePass — provider/model resolution", () => {
  afterEach(() => {
    mockCreateProvider.mockClear();
    mockReview.mockClear();
    capturedConfigs.length = 0;
  });

  it("uses the main LLM's provider/model when no refute override is set", async () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "groq", model: "openai/gpt-oss-20b" },
    });
    const findings = [makeFinding()];

    await runRefutePass(findings, mockContext(), config);

    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
    const passed = capturedConfigs[0] as { llm: { provider: string; model: string } };
    expect(passed.llm.provider).toBe("groq");
    expect(passed.llm.model).toBe("openai/gpt-oss-20b");
  });

  it("uses refute.model with the main provider when only refute.model is set (same-provider anti-correlation)", async () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      refute: { model: "openai/gpt-oss-120b" },
    });
    const findings = [makeFinding()];

    await runRefutePass(findings, mockContext(), config);

    const passed = capturedConfigs[0] as { llm: { provider: string; model: string } };
    expect(passed.llm.provider).toBe("groq");
    expect(passed.llm.model).toBe("openai/gpt-oss-120b");
  });

  it("uses both refute.provider and refute.model when both are set (cross-provider anti-correlation)", async () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      refute: { provider: "openai", model: "gpt-4o" },
    });
    const findings = [makeFinding()];

    await runRefutePass(findings, mockContext(), config);

    const passed = capturedConfigs[0] as { llm: { provider: string; model: string } };
    expect(passed.llm.provider).toBe("openai");
    expect(passed.llm.model).toBe("gpt-4o");
  });

  it("reports the resolved skeptic model on the result even with a same-provider override", async () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      refute: { model: "openai/gpt-oss-120b" },
    });
    const findings = [makeFinding()];

    const result = await runRefutePass(findings, mockContext(), config);

    expect(result.model).toBe("refute:groq/openai/gpt-oss-120b");
  });
});