import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildInlineComments,
  buildInlineSummaryHeader,
  postInlineReview,
  type GitHubConfig,
} from "./inline-comments.js";
import type { FindingsArtifact, Finding } from "../schemas/findings.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-0001",
    severity: "high",
    category: "security",
    title: "SQL injection in search endpoint",
    description: "The search endpoint constructs a SQL query using string concatenation.",
    evidence: {
      file: "src/routes/search.ts",
      line_start: 47,
      line_end: 47,
      snippet: 'db.query(`SELECT * FROM users WHERE name LIKE "%${q}%"`)',
      blast_radius: ["src/db.ts:5"],
      rule_id: null,
    },
    source: "llm:gpt-oss-20b",
    source_type: "llm",
    confidence: 0.9,
    references: ["https://owasp.org/sql-injection"],
    fingerprint: "fp-001",
    dismissed: false,
    dismissed_by: null,
    dismissed_at: null,
    dismissal_reason: null,
    refute_result: null,
    ...overrides,
  };
}

const minimalArtifact: FindingsArtifact = {
  $schema: "https://flaught.dev/schemas/findings/v2.schema.json",
  schema_version: 2,
  _caveat: "This artifact is evidence that adversarial scrutiny occurred.",
  generated_at: "2026-08-22T00:00:00Z",
  flaught_version: "0.8.0",
  repository: { name: "flaught/core", url: "", branch: "main" },
  pull_request: { number: 42, url: null, title: null, description: null, base_sha: "abc123", head_sha: "def456" },
  run: { id: "flaught-001", ci_url: null, duration_seconds: 10, llm_error: null },
  tools_executed: [],
  findings: [],
  test_inversion: null,
  scope_creep: null,
  noise_budget: {
    critical: { limit: 5, used: 0 },
    high: { limit: 10, used: 0 },
    medium: { limit: 15, used: 0 },
    low: { limit: 20, used: 0 },
    info: { limit: 25, used: 0 },
  },
  summary: {
    total_findings: 0,
    by_severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    by_source_type: { deterministic: 0, llm: 0 },
    by_category: {} as Record<string, number>,
    dismissed_count: 0,
  },
};

// ─── buildInlineComments ────────────────────────────────────────────────────

describe("buildInlineComments", () => {
  it("creates an inline comment for a finding with file and line", () => {
    const finding = makeFinding();
    const comments = buildInlineComments([finding]);

    expect(comments).toHaveLength(1);
    expect(comments[0]!.path).toBe("src/routes/search.ts");
    expect(comments[0]!.position).toBe(47);
    expect(comments[0]!.body).toContain("SQL injection in search endpoint");
    expect(comments[0]!.body).toContain("🟠 HIGH");
  });

  it("skips findings without a file", () => {
    const finding = makeFinding({
      evidence: { file: "", line_start: 10, line_end: 10, snippet: "", blast_radius: [], rule_id: null },
    });
    const comments = buildInlineComments([finding]);
    expect(comments).toHaveLength(0);
  });

  it("skips findings with line_start 0 (package-level vuln)", () => {
    const finding = makeFinding({
      evidence: { file: "package.json", line_start: 0, line_end: 0, snippet: "", blast_radius: [], rule_id: null },
    });
    const comments = buildInlineComments([finding]);
    expect(comments).toHaveLength(0);
  });

  it("skips dismissed findings", () => {
    const finding = makeFinding({ dismissed: true, dismissed_by: "alice", dismissed_at: "2026-08-22", dismissal_reason: "false positive" });
    const comments = buildInlineComments([finding]);
    expect(comments).toHaveLength(0);
  });

  it("includes refute result in the comment body", () => {
    const finding = makeFinding({
      refute_result: { verdict: "confirmed", reasoning: "Confirmed by skeptic", adjusted_confidence: 0.92 },
    });
    const comments = buildInlineComments([finding]);
    expect(comments[0]!.body).toContain("✅ Skeptic: confirmed");
    expect(comments[0]!.body).toContain("Confirmed by skeptic");
  });

  it("includes dismissed tag in comment body for non-dismissed findings that were refuted", () => {
    const finding = makeFinding({
      refute_result: { verdict: "refuted", reasoning: "Not a real issue", adjusted_confidence: 0.1 },
    });
    const comments = buildInlineComments([finding]);
    expect(comments[0]!.body).toContain("❌ Skeptic: refuted");
  });

  it("uses the correct source badge for deterministic findings", () => {
    const finding = makeFinding({ source_type: "deterministic", source: "semgrep" });
    const comments = buildInlineComments([finding]);
    expect(comments[0]!.body).toContain("🔧");
  });

  it("uses the correct source badge for LLM findings", () => {
    const finding = makeFinding({ source_type: "llm", source: "llm:gpt-oss-20b" });
    const comments = buildInlineComments([finding]);
    expect(comments[0]!.body).toContain("🤖");
  });

  it("handles multiple findings", () => {
    const findings = [
      makeFinding({ id: "F-0001", evidence: { file: "a.ts", line_start: 1, line_end: 1, snippet: "", blast_radius: [], rule_id: null } }),
      makeFinding({ id: "F-0002", severity: "low", evidence: { file: "b.ts", line_start: 10, line_end: 10, snippet: "", blast_radius: [], rule_id: null } }),
      makeFinding({ id: "F-0003", evidence: { file: "", line_start: 0, line_end: 0, snippet: "", blast_radius: [], rule_id: null } }), // no file
    ];
    const comments = buildInlineComments(findings);
    expect(comments).toHaveLength(2); // third one has no file
  });
});

// ─── buildInlineSummaryHeader ────────────────────────────────────────────────

describe("buildInlineSummaryHeader", () => {
  it("produces a header with the Flaught title and caveat", () => {
    const artifact = { ...minimalArtifact };
    const header = buildInlineSummaryHeader(artifact);
    expect(header).toContain("Flaught");
    expect(header).toContain("adversarial scrutiny"); // caveat text
  });

  it("shows severity counts for non-zero severities", () => {
    const artifact = {
      ...minimalArtifact,
      findings: [makeFinding({ severity: "high" })],
      summary: {
        ...minimalArtifact.summary,
        total_findings: 1,
        by_severity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      },
    };
    const header = buildInlineSummaryHeader(artifact);
    expect(header).toContain("HIGH");
    expect(header).toContain("1");
  });

  it("shows skeptic summary when refute results exist", () => {
    const artifact = {
      ...minimalArtifact,
      findings: [makeFinding({ refute_result: { verdict: "confirmed", reasoning: "Looks real", adjusted_confidence: 0.95 } })],
      summary: {
        ...minimalArtifact.summary,
        total_findings: 1,
        by_source_type: { deterministic: 0, llm: 1 },
      },
    };
    const header = buildInlineSummaryHeader(artifact);
    expect(header).toContain("Skeptic");
    expect(header).toContain("confirmed");
  });
});

// ─── postInlineReview ───────────────────────────────────────────────────────

describe("postInlineReview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const config: GitHubConfig = {
    token: "ghp_test123",
    repository: "flaught/core",
    pullNumber: 42,
    baseSha: "abc123",
    headSha: "def456",
  };

  it("returns no inline comments when findings have no file/line info", async () => {
    const artifact = { ...minimalArtifact };
    const result = await postInlineReview(config, artifact, "summary body");

    expect(result.posted).toBe(true);
    expect(result.inlineCommentsCount).toBe(0);
  });

  it("posts a review with inline comments for findings with file/line info", async () => {
    const finding = makeFinding();
    const artifact = {
      ...minimalArtifact,
      findings: [finding],
      summary: {
        ...minimalArtifact.summary,
        total_findings: 1,
        by_severity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      },
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ html_url: "https://github.com/flaught/core/pull/42#pullrequestreview-123" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postInlineReview(config, artifact, "summary body");

    expect(result.posted).toBe(true);
    expect(result.inlineCommentsCount).toBe(1);
    expect(result.reviewUrl).toBe("https://github.com/flaught/core/pull/42#pullrequestreview-123");

    // Verify the review was posted to the correct URL
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/flaught/core/pulls/42/reviews");

    const body = JSON.parse(init.body as string);
    expect(body.event).toBe("COMMENT");
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].path).toBe("src/routes/search.ts");
    expect(body.comments[0].position).toBe(47);
    expect(body.comments[0].body).toContain("SQL injection");
  });

  it("falls back to a PR comment when inline positions are invalid (422)", async () => {
    const finding = makeFinding();
    const artifact = {
      ...minimalArtifact,
      findings: [finding],
      summary: {
        ...minimalArtifact.summary,
        total_findings: 1,
        by_severity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      },
    };

    // First call (review) returns 422, second call (comment) returns 200
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => "Validation failed",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ html_url: "https://github.com/flaught/core/issues/42#issuecomment-1" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postInlineReview(config, artifact, "summary body");

    expect(result.posted).toBe(true);
    expect(result.inlineCommentsCount).toBe(0); // fell back to comment, no inline
    expect(result.reviewUrl).toBe("https://github.com/flaught/core/issues/42#issuecomment-1");

    // Verify fallback: second call to issues comments API
    const [url] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(url).toContain("/repos/flaught/core/issues/42/comments");
  });

  it("returns error on non-422 API errors", async () => {
    const finding = makeFinding();
    const artifact = {
      ...minimalArtifact,
      findings: [finding],
      summary: {
        ...minimalArtifact.summary,
        total_findings: 1,
        by_severity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      },
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postInlineReview(config, artifact, "summary body");

    expect(result.posted).toBe(false);
    expect(result.error).toContain("401");
  });

  it("handles network errors", async () => {
    const finding = makeFinding();
    const artifact = {
      ...minimalArtifact,
      findings: [finding],
      summary: {
        ...minimalArtifact.summary,
        total_findings: 1,
      },
    };

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await postInlineReview(config, artifact, "summary body");

    expect(result.posted).toBe(false);
    expect(result.error).toContain("Network error");
  });

  it("limits inline comments to 50 per request", async () => {
    const findings: Finding[] = Array.from({ length: 55 }, (_, i) =>
      makeFinding({
        id: `F-${String(i + 1).padStart(4, "0")}`,
        evidence: { file: `file${i}.ts`, line_start: i + 1, line_end: i + 1, snippet: "", blast_radius: [], rule_id: null },
      }),
    );
    const artifact = {
      ...minimalArtifact,
      findings,
      summary: { ...minimalArtifact.summary, total_findings: 55 },
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ html_url: "https://github.com/flaught/core/pull/42#pullrequestreview-123" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postInlineReview(config, artifact, "summary body");

    expect(result.posted).toBe(true);
    expect(result.inlineCommentsCount).toBe(50); // capped at 50

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.comments).toHaveLength(50);
  });

  it("uses custom API base URL when provided", async () => {
    const finding = makeFinding();
    const artifact = {
      ...minimalArtifact,
      findings: [finding],
      summary: { ...minimalArtifact.summary, total_findings: 1 },
    };

    const customConfig = {
      ...config,
      apiBaseUrl: "https://github.mycompany.com/api/v3",
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ html_url: "https://github.mycompany.com/flaught/core/pull/42#pullrequestreview-123" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await postInlineReview(customConfig, artifact, "summary body");

    const [url] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://github.mycompany.com/api/v3/repos/flaught/core/pulls/42/reviews");
  });
});