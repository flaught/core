import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("does not truncate when the prompt fits within the budget", () => {
    const prompt = buildRefuteUserPrompt(
      [makeFinding()],
      "small diff",
      new Map([["a.ts", "content"]]),
      new Map(),
      undefined,
      undefined,
      50_000,
    );
    expect(prompt).not.toContain("Context truncated");
    expect(prompt).not.toContain("omitted entirely");
  });

  it("truncates an oversized diff to the budget and SAYS SO in-band (CI 400 regression)", () => {
    // CI failure that motivated this: a 316K-char diff rode the refute prompt
    // uncapped and Groq rejected the whole call (400: reduce the length of
    // the messages or completion). The findings and instructions — the
    // sections the skeptic actually needs — must survive; the diff tail
    // degrades with an explicit note.
    const hugeDiff = "diff content line\n".repeat(20_000); // ~360K chars
    const budget = 30_000;

    const prompt = buildRefuteUserPrompt(
      [makeFinding()],
      hugeDiff,
      new Map(),
      new Map(),
      undefined,
      undefined,
      budget,
    );

    expect(prompt.length).toBeLessThanOrEqual(budget + 1000); // budget + note overhead
    expect(prompt).toContain("Context truncated");
    expect(prompt).toContain("the skeptic saw only part of it");
    expect(prompt).toContain(makeFinding().title); // findings never truncated
    expect(prompt).toContain("## Your Task");
  });

  it("evicts neighborhood contents before shrinking the diff", () => {
    const hugeHood = new Map([["neighbor.ts", "x".repeat(60_000)]]);
    const prompt = buildRefuteUserPrompt(
      [makeFinding()],
      "d".repeat(40_000),
      new Map(),
      hugeHood,
      undefined,
      undefined,
      30_000,
    );

    expect(prompt).toContain('"neighborhood file contents" omitted entirely');
    expect(prompt).toContain("## Unified Diff");
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

  it("includes the stated intent as the spec to re-derive against when a PR description is provided", () => {
    const findings = [makeFinding({ id: "F-001", title: "Off-by-one" })];
    const prompt = buildRefuteUserPrompt(
      findings,
      "diff",
      new Map(),
      new Map(),
      "This PR adds bounds checking so index lookups never return -1.",
    );

    expect(prompt).toContain("Stated Intent (PR description");
    expect(prompt).toContain("never return -1");
    expect(prompt).toContain("derive what the code should do from this intent");
  });

  it("omits the stated intent section when no PR description is provided", () => {
    const findings = [makeFinding({ id: "F-001", title: "Off-by-one" })];
    const prompt = buildRefuteUserPrompt(findings, "diff", new Map(), new Map());
    expect(prompt).not.toContain("## Stated Intent");
  });
});

// ─── Parse refute response ─────────────────────────────────────────────────────

describe("parseRefuteResponse", () => {
  it("parses a valid JSON response with opaque finding IDs", () => {
    const response = JSON.stringify({
      evaluations: [
        {
          finding_id: "RF-ab12-1",
          verdict: "confirmed",
          reasoning: "The SQL injection is clearly visible on line 47.",
          adjusted_confidence: 0.92,
        },
        {
          finding_id: "RF-ab12-2",
          verdict: "refuted",
          reasoning: "The variable is sanitized before use.",
          adjusted_confidence: 0.1,
        },
      ],
    });

    const result = parseRefuteResponse(response);
    expect(result.parse_error).toBe(false);
    expect(result.evaluations).toHaveLength(2);
    expect(result.evaluations[0]!.finding_id).toBe("RF-ab12-1");
    expect(result.evaluations[0]!.verdict).toBe("confirmed");
    expect(result.evaluations[0]!.reasoning).toContain("SQL injection");
    expect(result.evaluations[0]!.adjusted_confidence).toBe(0.92);
    expect(result.evaluations[1]!.verdict).toBe("refuted");
    expect(result.evaluations[1]!.adjusted_confidence).toBe(0.1);
  });

  it("retains the legacy numeric finding_index as a fallback reference", () => {
    const response = JSON.stringify({
      evaluations: [
        { finding_index: 0, verdict: "confirmed", reasoning: "ok", adjusted_confidence: 0.9 },
      ],
    });

    const result = parseRefuteResponse(response);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0]!.finding_index).toBe(0);
    expect(result.evaluations[0]!.finding_id).toBeNull();
  });

  it("parses a response wrapped in markdown code blocks", () => {
    const response = '```json\n{"evaluations": [{"finding_id": "RF-x-1", "verdict": "uncertain", "reasoning": "Cannot verify from context.", "adjusted_confidence": 0.45}]}\n```';

    const result = parseRefuteResponse(response);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0]!.verdict).toBe("uncertain");
  });

  it("reports a parse error (not an empty success) for invalid JSON", () => {
    // #88: a skeptic response we cannot parse is a FAILURE SIGNAL, not
    // "zero evaluations happened to come back".
    expect(parseRefuteResponse("not json")).toEqual({ evaluations: [], parse_error: true, dropped_entries: 0 });
    expect(parseRefuteResponse("")).toEqual({ evaluations: [], parse_error: true, dropped_entries: 0 });
  });

  it("drops entries with no finding reference instead of attaching them to finding 0 (#88)", () => {
    // The old parser defaulted a missing finding_index to 0, silently
    // attaching an unidentified evaluation to the FIRST finding.
    const response = JSON.stringify({
      evaluations: [
        { verdict: "uncertain", reasoning: "Cannot tell", adjusted_confidence: 0.45 },
        { finding_id: "RF-x-2", verdict: "confirmed", reasoning: "Real", adjusted_confidence: 0.9 },
      ],
    });

    const result = parseRefuteResponse(response);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0]!.finding_id).toBe("RF-x-2");
    expect(result.dropped_entries).toBe(1);
  });

  it("defaults uncertain for invalid verdicts", () => {
    const response = JSON.stringify({
      evaluations: [
        {
          finding_id: "RF-x-1",
          verdict: "maybe",
          reasoning: "Not sure",
          adjusted_confidence: 0.5,
        },
      ],
    });

    const result = parseRefuteResponse(response);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0]!.verdict).toBe("uncertain");
  });

  it("clamps adjusted_confidence to 0-1 range", () => {
    const response = JSON.stringify({
      evaluations: [
        {
          finding_id: "RF-x-1",
          verdict: "confirmed",
          reasoning: "Confirmed",
          adjusted_confidence: 1.5,
        },
      ],
    });

    const result = parseRefuteResponse(response);
    expect(result.evaluations[0]!.adjusted_confidence).toBe(1);
  });

  it("defaults adjusted_confidence to 0.5 for missing values", () => {
    const response = JSON.stringify({
      evaluations: [
        {
          finding_id: "RF-x-1",
          verdict: "uncertain",
          reasoning: "Cannot tell",
        },
      ],
    });

    const result = parseRefuteResponse(response);
    expect(result.evaluations[0]!.adjusted_confidence).toBe(0.5);
  });

  it("handles a plain array response (not wrapped in evaluations key)", () => {
    const response = JSON.stringify([
      {
        finding_id: "RF-x-1",
        verdict: "confirmed",
        reasoning: "Looks right",
        adjusted_confidence: 0.85,
      },
    ]);

    const result = parseRefuteResponse(response);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0]!.verdict).toBe("confirmed");
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

// ─── Token usage aggregation ──────────────────────────────────────────────────

describe("runRefutePass — token usage", () => {
  afterEach(() => {
    mockCreateProvider.mockClear();
    mockReview.mockClear();
    capturedConfigs.length = 0;
  });

  it("returns undefined usage when the provider reports no usage", async () => {
    const config = FlaughtConfigSchema.parse({ llm: { provider: "groq", model: "m" } });
    const result = await runRefutePass([makeFinding()], mockContext(), config);
    expect(result.usage).toBeUndefined();
  });

  it("returns aggregated usage across multiple batches", async () => {
    // Two findings, batch size 1 => two skeptic calls. Each returns usage;
    // the runner must sum prompt/completion/total across batches.
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "groq", model: "m" },
      refute: { max_batch_size: 1 },
    });
    const findings = [
      makeFinding({ id: "F-001", title: "Finding 1" }),
      makeFinding({ id: "F-002", title: "Finding 2" }),
    ];

    mockReview
      .mockResolvedValueOnce({
        findings: [],
        raw: JSON.stringify({ evaluations: [{ finding_index: 0, verdict: "confirmed", reasoning: "ok", adjusted_confidence: 0.9 }] }),
        model: "test",
        usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
      })
      .mockResolvedValueOnce({
        findings: [],
        raw: JSON.stringify({ evaluations: [{ finding_index: 0, verdict: "refuted", reasoning: "no", adjusted_confidence: 0.1 }] }),
        model: "test",
        usage: { prompt_tokens: 3000, completion_tokens: 400, total_tokens: 3400 },
      });

    const result = await runRefutePass(findings, mockContext(), config);

    expect(mockReview).toHaveBeenCalledTimes(2);
    expect(result.usage).toEqual({
      prompt_tokens: 4000,
      completion_tokens: 600,
      total_tokens: 4600,
    });
  });

  it("aggregates usage when only some batches report usage (mixed)", async () => {
    // Two findings, batch size 1 => two skeptic calls. Batch 1 returns
    // usage; batch 2 returns none. The runner must sum only the batches that
    // reported usage and still return a summary (sawUsage flips on the first
    // batch), rather than dropping the whole thing or crashing on undefined.
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "groq", model: "m" },
      refute: { max_batch_size: 1 },
    });
    const findings = [
      makeFinding({ id: "F-001", title: "Finding 1" }),
      makeFinding({ id: "F-002", title: "Finding 2" }),
    ];

    mockReview
      .mockResolvedValueOnce({
        findings: [],
        raw: JSON.stringify({ evaluations: [{ finding_index: 0, verdict: "confirmed", reasoning: "ok", adjusted_confidence: 0.9 }] }),
        model: "test",
        usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
      })
      .mockResolvedValueOnce({
        findings: [],
        raw: JSON.stringify({ evaluations: [{ finding_index: 0, verdict: "uncertain", reasoning: "dunno", adjusted_confidence: 0.5 }] }),
        model: "test",
        // no usage field on this batch
      });

    const result = await runRefutePass(findings, mockContext(), config);

    expect(mockReview).toHaveBeenCalledTimes(2);
    expect(result.usage).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
    });
  });
});
// ─── Issue #88: stable finding identities + unevaluated-skeptic reporting ──────

/** Extract the opaque finding IDs embedded in the skeptic prompt, in order. */
function promptFindingIds(prompt: string): string[] {
  return [...prompt.matchAll(/### Finding (RF-[0-9a-f]+-\d+):/g)].map((m) => m[1]!);
}

function skepticResponse(evaluations: unknown[], usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  return {
    findings: [],
    raw: JSON.stringify({ evaluations }),
    model: "test",
    ...(usage ? { usage } : {}),
  };
}

describe("runRefutePass — finding identity and coverage (GH#88)", () => {
  beforeEach(() => {
    // Restore the default (legacy index-based) skeptic response: mockClear
    // does NOT reset custom implementations, so an implementation set by one
    // test would otherwise leak into the next.
    mockCreateProvider.mockClear();
    mockReview.mockReset();
    mockReview.mockResolvedValue({
      findings: [],
      raw: JSON.stringify({
        evaluations: [{ finding_index: 0, verdict: "confirmed", reasoning: "ok", adjusted_confidence: 0.9 }],
      }),
      model: "test",
    });
    capturedConfigs.length = 0;
  });

  it("labels findings with opaque IDs in the prompt and requires them back verbatim", async () => {
    const config = FlaughtConfigSchema.parse({ llm: { provider: "groq", model: "m" } });
    const findings = [makeFinding(), makeFinding({ title: "Second finding" })];

    mockReview.mockImplementation(async (_sys: string, userPrompt: string) => {
      const ids = promptFindingIds(userPrompt);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
      return skepticResponse(
        ids.map((id) => ({ finding_id: id, verdict: "confirmed", reasoning: "verified", adjusted_confidence: 0.9 })),
      );
    });

    const result = await runRefutePass(findings, mockContext(), config);

    const userPrompt = mockReview.mock.calls[0]![1] as string;
    expect(userPrompt).toContain('"finding_id"');
    expect(userPrompt).toContain("copied verbatim");
    expect(result.skeptic).toMatchObject({ state: "complete", expected: 2, evaluated: 2, not_evaluated: 0 });
    expect(result.findings.filter((f) => f.source_type === "llm").every((f) => f.refute_result?.verdict === "confirmed")).toBe(true);
  });

  it("matches reordered evaluations by ID — verdicts cannot shift between findings", async () => {
    const config = FlaughtConfigSchema.parse({ llm: { provider: "groq", model: "m" } });
    const findings = [
      makeFinding({ title: "First finding" }),
      makeFinding({ title: "Second finding" }),
    ];

    mockReview.mockImplementation(async (_sys: string, userPrompt: string) => {
      const ids = promptFindingIds(userPrompt);
      // Return evaluations in REVERSE order with distinct verdicts
      return skepticResponse([
        { finding_id: ids[1], verdict: "refuted", reasoning: "second is wrong", adjusted_confidence: 0.1 },
        { finding_id: ids[0], verdict: "confirmed", reasoning: "first is right", adjusted_confidence: 0.95 },
      ]);
    });

    const result = await runRefutePass(findings, mockContext(), config);
    const llm = result.findings.filter((f) => f.source_type === "llm");

    expect(llm[0]!.refute_result?.verdict).toBe("confirmed");
    expect(llm[0]!.refute_result?.reasoning).toBe("first is right");
    expect(llm[1]!.refute_result?.verdict).toBe("refuted");
    expect(llm[1]!.refute_result?.reasoning).toBe("second is wrong");
    expect(result.skeptic).toMatchObject({ state: "complete", evaluated: 2 });
  });

  it("rejects unknown/invented finding IDs and counts them", async () => {
    const config = FlaughtConfigSchema.parse({ llm: { provider: "groq", model: "m" } });

    mockReview.mockImplementation(async (_sys: string, userPrompt: string) => {
      const ids = promptFindingIds(userPrompt);
      return skepticResponse([
        { finding_id: ids[0], verdict: "confirmed", reasoning: "ok", adjusted_confidence: 0.9 },
        { finding_id: "RF-zzzz-99", verdict: "refuted", reasoning: "invented", adjusted_confidence: 0.1 },
      ]);
    });

    const result = await runRefutePass([makeFinding(), makeFinding({ title: "Second" })], mockContext(), config);

    expect(result.skeptic.unknown_ids).toBe(1);
    expect(result.skeptic.state).toBe("partial");
    const llm = result.findings.filter((f) => f.source_type === "llm");
    expect(llm[1]!.refute_result?.verdict).toBe("not_evaluated");
  });

  it("rejects duplicate evaluations for the same finding (keeps the first)", async () => {
    const config = FlaughtConfigSchema.parse({ llm: { provider: "groq", model: "m" } });

    mockReview.mockImplementation(async (_sys: string, userPrompt: string) => {
      const ids = promptFindingIds(userPrompt);
      return skepticResponse([
        { finding_id: ids[0], verdict: "refuted", reasoning: "first verdict", adjusted_confidence: 0.1 },
        { finding_id: ids[0], verdict: "confirmed", reasoning: "duplicate overwrite attempt", adjusted_confidence: 0.95 },
      ]);
    });

    const result = await runRefutePass([makeFinding()], mockContext(), config);

    const llm = result.findings.filter((f) => f.source_type === "llm");
    expect(llm[0]!.refute_result?.verdict).toBe("refuted");
    expect(llm[0]!.refute_result?.reasoning).toBe("first verdict");
    expect(result.skeptic.duplicate_ids).toBe(1);
  });

  it("an evaluation naming a different finding's ID attaches to THAT finding, never silently to finding 0", async () => {
    // Regression for the observed #88 symptom: the skeptic's reasoning about
    // finding B was attached to finding A. With ID round-tripping, whatever
    // the model names is where it lands — and if it names nothing valid,
    // it attaches nowhere.
    const config = FlaughtConfigSchema.parse({ llm: { provider: "groq", model: "m" } });

    mockReview.mockImplementation(async (_sys: string, userPrompt: string) => {
      const ids = promptFindingIds(userPrompt);
      return skepticResponse([
        { finding_id: ids[1], verdict: "refuted", reasoning: "this reasons about the SECOND finding", adjusted_confidence: 0.1 },
      ]);
    });

    const result = await runRefutePass([makeFinding({ title: "A" }), makeFinding({ title: "B" })], mockContext(), config);
    const llm = result.findings.filter((f) => f.source_type === "llm");

    // Old buggy behavior: this evaluation would have attached to finding 0.
    expect(llm[0]!.refute_result?.verdict).toBe("not_evaluated");
    expect(llm[1]!.refute_result?.verdict).toBe("refuted");
  });

  it("retries a malformed response once, then marks findings not_evaluated with state=failed", async () => {
    const config = FlaughtConfigSchema.parse({ llm: { provider: "groq", model: "m" } });

    mockReview
      .mockResolvedValueOnce({ findings: [], raw: "<<<garbage>>>", model: "test" })
      .mockResolvedValueOnce({ findings: [], raw: "still <<<garbage>>>", model: "test" });

    const result = await runRefutePass([makeFinding()], mockContext(), config);

    expect(mockReview).toHaveBeenCalledTimes(2); // bounded: exactly one retry
    expect(result.skeptic).toMatchObject({
      state: "failed",
      expected: 1,
      evaluated: 0,
      not_evaluated: 1,
      parse_failures: 1,
      retries: 1,
    });
    const llm = result.findings.filter((f) => f.source_type === "llm");
    expect(llm[0]!.refute_result?.verdict).toBe("not_evaluated");
    expect(llm[0]!.refute_result?.reasoning).toContain("not an uncertain verdict");
  });

  it("recovers on retry when the first response is malformed but the second is valid", async () => {
    const config = FlaughtConfigSchema.parse({ llm: { provider: "groq", model: "m" } });

    mockReview
      .mockResolvedValueOnce({ findings: [], raw: "not json at all", model: "test" })
      .mockImplementationOnce(async (_sys: string, userPrompt: string) => {
        const ids = promptFindingIds(userPrompt);
        return skepticResponse([
          { finding_id: ids[0], verdict: "confirmed", reasoning: "verified on retry", adjusted_confidence: 0.9 },
        ]);
      });

    const result = await runRefutePass([makeFinding()], mockContext(), config);

    expect(mockReview).toHaveBeenCalledTimes(2);
    expect(result.skeptic).toMatchObject({ state: "complete", retries: 1 });
    const llm = result.findings.filter((f) => f.source_type === "llm");
    expect(llm[0]!.refute_result?.verdict).toBe("confirmed");
  });

  it("marks only the omitted findings not_evaluated when coverage is partial", async () => {
    const config = FlaughtConfigSchema.parse({ llm: { provider: "groq", model: "m" } });

    mockReview.mockImplementation(async (_sys: string, userPrompt: string) => {
      const ids = promptFindingIds(userPrompt);
      return skepticResponse([
        { finding_id: ids[0], verdict: "uncertain", reasoning: "genuinely cannot decide", adjusted_confidence: 0.45 },
      ]);
    });

    const result = await runRefutePass(
      [makeFinding(), makeFinding({ title: "B" }), makeFinding({ title: "C" })],
      mockContext(),
      config,
    );

    expect(result.skeptic).toMatchObject({ state: "partial", expected: 3, evaluated: 1, not_evaluated: 2 });
    const llm = result.findings.filter((f) => f.source_type === "llm");
    expect(llm[0]!.refute_result?.verdict).toBe("uncertain");
    expect(llm[1]!.refute_result?.verdict).toBe("not_evaluated");
    expect(llm[2]!.refute_result?.verdict).toBe("not_evaluated");
  });

  it("keeps the legacy finding_index path for compatibility, counted in diagnostics", async () => {
    const config = FlaughtConfigSchema.parse({ llm: { provider: "groq", model: "m" } });

    // Default mockReview returns finding_index: 0 (legacy scheme, 0-based)
    const result = await runRefutePass([makeFinding()], mockContext(), config);

    const llm = result.findings.filter((f) => f.source_type === "llm");
    expect(llm[0]!.refute_result?.verdict).toBe("confirmed");
    expect(result.skeptic.legacy_index_matches).toBe(1);
  });

  it("rejects an out-of-range legacy index instead of wrapping it onto a real finding", async () => {
    // The 1-based-vs-0-based hazard: a model numbering 1..N produced index N
    // (out of range) for the last finding and index 1 for the FIRST finding —
    // silently mis-attaching it to the second. Out-of-range must be rejected.
    const config = FlaughtConfigSchema.parse({ llm: { provider: "groq", model: "m" } });

    mockReview.mockResolvedValue(skepticResponse([
      { finding_index: 2, verdict: "confirmed", reasoning: "1-based mistake", adjusted_confidence: 0.9 },
    ]));

    const result = await runRefutePass([makeFinding(), makeFinding({ title: "B" })], mockContext(), config);

    expect(result.skeptic.unknown_ids).toBe(1);
    expect(result.skeptic.state).toBe("failed");
    const llm = result.findings.filter((f) => f.source_type === "llm");
    expect(llm[0]!.refute_result?.verdict).toBe("not_evaluated");
    expect(llm[1]!.refute_result?.verdict).toBe("not_evaluated");
  });
});
