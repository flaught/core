import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderMarkdownReport } from "./report/markdown.js";
import type { FindingsArtifact, Finding, Severity } from "./schemas/findings.js";
import {
  SCHEMA_VERSION,
  FINDINGS_SCHEMA_URL,
  CAVEAT,
  FINDING_ID_CAVEAT,
} from "./schemas/findings.js";

const originalArgv = process.argv;
const tempDirs: string[] = [];

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

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
      blast_radius: ["src/db/client.ts:12"],
      rule_id: null,
    },
    source: "llm:groq/compound-mini",
    source_type: "llm",
    confidence: 0.9,
    references: ["https://owasp.org/sql-injection"],
    fingerprint: "sha256:test-fixture-fingerprint",
    dismissed: false,
    dismissed_by: null,
    dismissed_at: null,
    dismissal_reason: null,
    refute_result: null,
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<FindingsArtifact> = {}): FindingsArtifact {
  const findings = overrides.findings ?? [makeFinding()];
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const bySourceType = { deterministic: 0, llm: 0 };
  const byCategory: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity]++;
    bySourceType[f.source_type] = (bySourceType[f.source_type] ?? 0) + 1;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  }
  return {
    $schema: FINDINGS_SCHEMA_URL,
    schema_version: SCHEMA_VERSION,
    _caveat: CAVEAT,
    generated_at: "2026-09-10T10:30:00Z",
    flaught_version: "0.11.0",
    repository: { name: "flaught/core", url: "", branch: "main" },
    pull_request: { number: 42, url: null, title: "Add auth", description: "Adds JWT auth", base_sha: "abc123", head_sha: "def456" },
    run: { id: "flaught-1234567890-abc123", ci_url: null, duration_seconds: 47, llm_error: null, usage: null },
    analysis_completeness: null,
    tools_executed: [],
    findings,
    test_inversion: null,
    scope_creep: null,
    noise_budget: {
      critical: { limit: 5, used: bySeverity.critical },
      high: { limit: 10, used: bySeverity.high },
      medium: { limit: 15, used: bySeverity.medium },
      low: { limit: 20, used: bySeverity.low },
      info: { limit: 25, used: bySeverity.info },
    },
    dropped_below_min_confidence: 0,
    summary: {
      total_findings: findings.length,
      by_severity: bySeverity,
      by_source_type: bySourceType as FindingsArtifact["summary"]["by_source_type"],
      by_category: byCategory as FindingsArtifact["summary"]["by_category"],
      dismissed_count: 0,
    },
    ...overrides,
  };
}

/**
 * Drive the `flaught report` subcommand the way the CLI would (argv parsing,
 * stdout/stderr capture, process.exit interception). Returns the captured
 * stdout lines; throws if the command calls process.exit (so the caller can
 * assert on the exit code via the thrown message).
 */
async function runReportCli(argv: string[]): Promise<{ stdout: string[]; stderr: string[] }> {
  process.argv = [process.execPath, "flaught", "report", ...argv];
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
  vi.resetModules();
  try {
    await import("./cli.js");
  } finally {
    exitSpy.mockRestore();
  }
  return { stdout, stderr };
}

describe("flaught report", () => {
  it("renders the same markdown as renderMarkdownReport, from a findings.json artifact, via --from", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-cli-report-"));
    tempDirs.push(dir);
    const artifactPath = path.join(dir, "findings.json");
    const artifact = makeArtifact();
    fs.writeFileSync(artifactPath, JSON.stringify(artifact), "utf-8");

    const { stdout } = await runReportCli(["--from", artifactPath]);

    // The rendered output must match the library renderer byte-for-byte —
    // `report` is a pure artifact -> markdown pipe, no transformation.
    const expected = renderMarkdownReport(artifact);
    expect(stdout.join("\n")).toBe(expected);

    // And it must actually contain the LLM finding — the whole point of #75
    // is that the comment no longer silently drops LLM-sourced findings.
    expect(stdout.join("\n")).toContain("SQL injection in search endpoint");
    expect(stdout.join("\n")).toContain("🤖"); // LLM source badge
  });

  it("accepts the path as a positional argument too", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-cli-report-"));
    tempDirs.push(dir);
    const artifactPath = path.join(dir, "findings.json");
    fs.writeFileSync(artifactPath, JSON.stringify(makeArtifact()), "utf-8");

    const { stdout } = await runReportCli([artifactPath]);
    expect(stdout.join("\n")).toContain("SQL injection in search endpoint");
  });

  it("exits 2 with a clear error when no path is given", async () => {
    await expect(runReportCli([])).rejects.toThrow("process.exit(2)");
  });

  it("exits 2 with a clear error when the artifact file is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-cli-report-"));
    tempDirs.push(dir);
    const missing = path.join(dir, "nope.json");
    await expect(runReportCli(["--from", missing])).rejects.toThrow("process.exit(2)");
  });

  it("exits 2 when the artifact has no findings array (schema validation)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-cli-report-"));
    tempDirs.push(dir);
    const artifactPath = path.join(dir, "findings.json");
    fs.writeFileSync(artifactPath, JSON.stringify({ not_findings: true }), "utf-8");

    await expect(runReportCli(["--from", artifactPath])).rejects.toThrow("process.exit(2)");
  });

  it("exits 2 with a clear message when the artifact passes the light check but is missing fields the renderer needs (e.g. noise_budget)", async () => {
    // parseArtifactFile only verifies `findings` is an array; renderMarkdownReport
    // also reads noise_budget/summary/run/etc. A corrupted or hand-edited artifact
    // that has findings but is missing those fields must fail gracefully (exit 2,
    // clear message) rather than throwing a raw TypeError mid-render.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-cli-report-"));
    tempDirs.push(dir);
    const artifactPath = path.join(dir, "findings.json");
    fs.writeFileSync(
      artifactPath,
      JSON.stringify({ findings: [] }), // has findings array, missing everything else
      "utf-8",
    );

    await expect(runReportCli(["--from", artifactPath])).rejects.toThrow("process.exit(2)");
  });

  it("renders the finding-ID caveat footer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-cli-report-"));
    tempDirs.push(dir);
    const artifactPath = path.join(dir, "findings.json");
    fs.writeFileSync(artifactPath, JSON.stringify(makeArtifact()), "utf-8");

    const { stdout } = await runReportCli(["--from", artifactPath]);
    expect(stdout.join("\n")).toContain(FINDING_ID_CAVEAT);
  });
});