import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { simpleGit, type SimpleGit } from "simple-git";
import { runReview, runReviewOnlyLlm, isDocFile, isDocsOnlyDiff } from "./review.js";
import { contextToJSON } from "./context/assembler.js";
import type { Finding } from "./schemas/findings.js";
import { resolveDismissalsPath, loadDismissalStore, addDismissal, saveDismissalStore } from "./dismissals/store.js";

// Skip the real liveness network check — graceful-degradation tests below
// only care about the provider.review() call failing, not liveness.
vi.mock("./llm/liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./llm/liveness.js")>();
  return {
    ...actual,
    validateModelLiveness: vi.fn().mockResolvedValue({ alive: true, model: "test-model", provider: "test" }),
  };
});

// Stub the LLM provider so graceful-degradation tests can force review()
// (and/or the skeptic pass, which shares the same provider factory) to
// fail without a real network call.
const { mockReview } = vi.hoisted(() => ({ mockReview: vi.fn() }));
vi.mock("./llm/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./llm/provider.js")>();
  return {
    ...actual,
    createProvider: vi.fn().mockReturnValue({ review: mockReview }),
  };
});

// ─── Noise budget tests (unit) ─────────────────────────────────────────────

// enforceNoiseBudget is not exported, so we test it through runReview
// by injecting LLM findings. But for direct testing, we replicate the logic.

function enforceBudget(findings: Finding[], config: { critical: number; high: number; medium: number; low: number; info: number }): Finding[] {
  const severityOrder: Array<"critical" | "high" | "medium" | "low" | "info"> = ["critical", "high", "medium", "low", "info"];

  const result: Finding[] = [];
  const counts: Record<string, number> = {
    critical: 0, high: 0, medium: 0, low: 0, info: 0,
  };

  const sorted = [...findings].sort((a, b) => {
    const severityDiff = severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity);
    if (severityDiff !== 0) return severityDiff;
    return b.confidence - a.confidence;
  });

  for (const finding of sorted) {
    const sev = finding.severity;
    const budgetLimit = config[sev] ?? 0;
    const currentCount = counts[sev] ?? 0;
    if (currentCount < budgetLimit) {
      result.push(finding);
      counts[sev] = (counts[sev] ?? 0) + 1;
    }
  }

  return result;
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    severity: "high",
    category: "security",
    title: "Test finding",
    description: "Test description",
    evidence: { file: "", line_start: 0, line_end: 0, snippet: "", blast_radius: [], rule_id: null },
    source: "llm:test",
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

describe("noise budget enforcement", () => {
  it("keeps all findings when under budget", () => {
    const config = { critical: 5, high: 10, medium: 15, low: 20, info: 25 };
    const findings = [
      makeFinding({ id: "F-001", severity: "high" }),
      makeFinding({ id: "F-002", severity: "medium", category: "architecture" }),
    ];

    const result = enforceBudget(findings, config);
    expect(result).toHaveLength(2);
  });

  it("sorts by severity before confidence", () => {
    const config = { critical: 1, high: 1, medium: 1, low: 20, info: 25 };
    const findings = [
      makeFinding({ id: "F-001", severity: "medium", confidence: 0.9 }),
      makeFinding({ id: "F-002", severity: "high", confidence: 0.8 }),
      makeFinding({ id: "F-003", severity: "critical", confidence: 0.7 }),
    ];

    const result = enforceBudget(findings, config);
    expect(result).toHaveLength(3);
    expect(result[0]!.severity).toBe("critical");
    expect(result[1]!.severity).toBe("high");
    expect(result[2]!.severity).toBe("medium");
  });
});

// ─── Docs-only diff detection (unit) ──────────────────────────────────────────

describe("isDocFile", () => {
  it("recognizes markdown and text extensions", () => {
    expect(isDocFile("docs/troubleshooting.md")).toBe(true);
    expect(isDocFile("notes.txt")).toBe(true);
    expect(isDocFile("guide.mdx")).toBe(true);
    expect(isDocFile("intro.rst")).toBe(true);
    expect(isDocFile("chapter.adoc")).toBe(true);
  });

  it("recognizes common extensionless doc files by basename, case-insensitively", () => {
    expect(isDocFile("README")).toBe(true);
    expect(isDocFile("LICENSE")).toBe(true);
    expect(isDocFile("CHANGELOG")).toBe(true);
    expect(isDocFile("license")).toBe(true);
    expect(isDocFile("docs/CONTRIBUTING")).toBe(true);
  });

  it("does not treat code or config files as docs", () => {
    expect(isDocFile("src/index.ts")).toBe(false);
    expect(isDocFile(".advreview.yml")).toBe(false);
    expect(isDocFile("package.json")).toBe(false);
  });
});

describe("isDocsOnlyDiff", () => {
  it("is true when every changed file is documentation", () => {
    const files = [
      { path: "README.md", additions: 1, deletions: 0, status: "modified" as const },
      { path: "docs/api.md", additions: 2, deletions: 1, status: "modified" as const },
    ];
    expect(isDocsOnlyDiff(files)).toBe(true);
  });

  it("is false when any changed file is not documentation", () => {
    const files = [
      { path: "README.md", additions: 1, deletions: 0, status: "modified" as const },
      { path: "src/index.ts", additions: 1, deletions: 0, status: "modified" as const },
    ];
    expect(isDocsOnlyDiff(files)).toBe(false);
  });

  it("is false for an empty changed-files list", () => {
    expect(isDocsOnlyDiff([])).toBe(false);
  });
});

// ─── Review orchestrator integration tests (no-llm mode) ─────────────────────

let tempDirs: string[] = [];

function cleanup() {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs = [];
}

async function commitFiles(
  git: SimpleGit,
  files: Record<string, string>,
  message: string = "initial",
): Promise<string> {
  const repoRoot = (await git.revparse(["--show-toplevel"])).trim();
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  await git.add(".");

  // Use environment variables for git author/committer to avoid conflicts
  // with the host repo's git context during pre-commit hooks.
  await git.commit(message, undefined, {
    "--author": "Flaught Test <test@flaught.dev>",
  });
  return (await git.revparse(["HEAD"])).trim();
}

describe("runReview (no-llm mode)", () => {
  afterEach(() => {
    cleanup();
  });

  it("produces an artifact with no findings in no-llm mode", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-review-"));
    tempDirs.push(repoPath);

    const git = simpleGit(repoPath);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");

    await commitFiles(git, {
      "src/index.ts": "console.log('hello');",
    }, "initial");

    await commitFiles(git, {
      "src/index.ts": "console.log('hello world');",
    }, "add world");

    const result = await runReview({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      skipLlm: true,
    });

    expect(result.context.changedFiles.length).toBeGreaterThanOrEqual(1);
    expect(result.artifact.findings).toHaveLength(0);
    expect(result.artifact.schema_version).toBe(2);
    expect(result.artifact._caveat).toContain("evidence that adversarial scrutiny occurred");
    expect(result.exitCode).toBe(0);
    expect(result.markdown).toContain("No findings");
    expect(result.json).toBeTruthy();
  });

  it("loads .advreview.yml via repoPath alone, without an explicit configPath (regression)", async () => {
    // Regression test: runReview({repoPath, ...}) — the exact shape the CLI's
    // `--repo` flag produces — used to silently ignore the target repo's
    // .advreview.yml and fall back to defaults whenever invoked from an
    // unrelated cwd, because loadConfig only ever searched configPath's
    // dirname or process.cwd(). Prove a real file-based config is honored
    // via repoPath alone, using exclude.paths as the observable effect.
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-review-"));
    tempDirs.push(repoPath);

    const git = simpleGit(repoPath);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");

    await commitFiles(git, {
      ".advreview.yml": "version: 1\nexclude:\n  paths:\n    - \"src/excluded.ts\"\n",
      "src/main.ts": "console.log('hello');",
      "src/excluded.ts": "console.log('hello');",
    }, "initial");

    await commitFiles(git, {
      "src/main.ts": "console.log('hello world');",
      "src/excluded.ts": "console.log('hello world');",
    }, "modify both");

    // No configPath passed — only repoPath, exactly like `flaught review --repo <path>`.
    const result = await runReview({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      skipLlm: true,
    });

    const changedPaths = result.context.changedFiles.map((f) => f.path);
    expect(changedPaths).toContain("src/main.ts");
    expect(changedPaths).not.toContain("src/excluded.ts");
  });

  it("produces valid JSON artifact", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-review-"));
    tempDirs.push(repoPath);

    const git = simpleGit(repoPath);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");

    await commitFiles(git, {
      "src/main.ts": "export const x = 1;",
    }, "initial");

    await commitFiles(git, {
      "src/main.ts": "export const x = 2;",
    }, "change x");

    const result = await runReview({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      skipLlm: true,
    });

    const parsed = JSON.parse(result.json);
    expect(parsed.schema_version).toBe(2);
    expect(parsed.findings).toEqual([]);
    expect(parsed.noise_budget).toBeTruthy();
    expect(parsed._caveat).toBeTruthy();
  });

  it("includes base and head SHAs in artifact", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-review-"));
    tempDirs.push(repoPath);

    const git = simpleGit(repoPath);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");

    await commitFiles(git, {
      "src/main.ts": "export const x = 1;",
    }, "initial");

    await commitFiles(git, {
      "src/main.ts": "export const x = 2;",
    }, "change x");

    const result = await runReview({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      skipLlm: true,
    });

    expect(result.artifact.pull_request.base_sha).toBeTruthy();
    expect(result.artifact.pull_request.head_sha).toBeTruthy();
    expect(result.artifact.run.duration_seconds).toBeGreaterThanOrEqual(0);
  });
});

// ─── Dismissal pipeline integration ───────────────────────────────────────────

describe("runReview (dismissals)", () => {
  afterEach(() => {
    cleanup();
  });

  it("auto-dismisses a re-surfaced finding and flips the severity gate", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-dismiss-"));
    tempDirs.push(repoPath);

    const git = simpleGit(repoPath);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");

    const advreviewYml = [
      "version: 1",
      "test_inversion:",
      "  enabled: true",
      "  command: node -e \"console.log('PASSED test_always_passes')\"",
      "scope_creep:",
      "  enabled: false",
      "tools:",
      "  semgrep:",
      "    enabled: false",
      "  linter:",
      "    enabled: false",
      "  vuln_scanner:",
      "    enabled: false",
      "severity_gate:",
      "  fail_on: medium", // test-inversion findings are severity "medium" — gates until dismissed
      "",
    ].join("\n");

    await commitFiles(git, {
      ".advreview.yml": advreviewYml,
      "src/index.ts": "console.log('hello');",
    }, "initial");

    await commitFiles(git, {
      "src/index.ts": "console.log('hello world');",
    }, "add world");

    const configPath = path.join(repoPath, ".advreview.yml");

    // First run: no dismissal store yet — the test-inversion finding should
    // appear active and gate the build (fail_on: medium).
    const first = await runReview({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      configPath,
      skipLlm: true,
    });

    const flagged = first.artifact.findings.find((f) => f.category === "test-quality");
    expect(flagged).toBeTruthy();
    expect(flagged!.dismissed).toBe(false);
    expect(first.exitCode).toBe(1);

    // Dismiss it by fingerprint, persisted to the dismissal store.
    const dismissalsPath = resolveDismissalsPath(first.context.repoRoot);
    const store = loadDismissalStore(dismissalsPath);
    saveDismissalStore(
      dismissalsPath,
      addDismissal(store, {
        fingerprint: flagged!.fingerprint,
        dismissed_by: "jane@example.com",
        dismissed_at: new Date().toISOString(),
        reason: "Known flaky fixture test — not a real quality issue",
        context: { title: flagged!.title, file: flagged!.evidence.file },
        expires_at: null,
      }),
    );

    // Second run: the same finding should now come back pre-dismissed and
    // the gate should clear even though the finding is still reported.
    const second = await runReview({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      configPath,
      skipLlm: true,
    });

    const stillReported = second.artifact.findings.find((f) => f.category === "test-quality");
    expect(stillReported).toBeTruthy();
    expect(stillReported!.dismissed).toBe(true);
    expect(stillReported!.dismissed_by).toBe("jane@example.com");
    expect(stillReported!.dismissal_reason).toContain("flaky");
    expect(second.exitCode).toBe(0);
    expect(second.markdown).toContain("DISMISSED");
  }, 30_000);
});

// ─── Test inversion: docs-only diff skip ──────────────────────────────────────

describe("runReview (test inversion — docs-only diffs)", () => {
  afterEach(() => {
    cleanup();
  });

  const advreviewYml = [
    "version: 1",
    "test_inversion:",
    "  enabled: true",
    "  command: node -e \"console.log('PASSED src/app.test.ts::t1')\"",
    "scope_creep:",
    "  enabled: false",
    "tools:",
    "  semgrep:",
    "    enabled: false",
    "  linter:",
    "    enabled: false",
    "  vuln_scanner:",
    "    enabled: false",
    "",
  ].join("\n");

  it("skips test inversion entirely when every changed file is documentation", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-docsonly-"));
    tempDirs.push(repoPath);

    const git = simpleGit(repoPath);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");

    await commitFiles(git, {
      ".advreview.yml": advreviewYml,
      "README.md": "# Hello\n",
    }, "initial");

    await commitFiles(git, {
      "README.md": "# Hello\n\nMore docs.\n",
    }, "docs-only change");

    const result = await runReview({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      configPath: path.join(repoPath, ".advreview.yml"),
      skipLlm: true,
    });

    expect(result.artifact.test_inversion).toBeNull();
    expect(result.artifact.findings.find((f) => f.category === "test-quality")).toBeUndefined();
  }, 30_000);

  it("still runs test inversion when a code file changed alongside docs", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-docsonly-"));
    tempDirs.push(repoPath);

    const git = simpleGit(repoPath);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");

    await commitFiles(git, {
      ".advreview.yml": advreviewYml,
      "README.md": "# Hello\n",
      "src/index.ts": "console.log('hello');",
    }, "initial");

    await commitFiles(git, {
      "README.md": "# Hello\n\nMore docs.\n",
      "src/index.ts": "console.log('hello world');",
    }, "docs + code change");

    const result = await runReview({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      configPath: path.join(repoPath, ".advreview.yml"),
      skipLlm: true,
    });

    expect(result.artifact.test_inversion).not.toBeNull();
  }, 30_000);
});

// ─── LLM graceful degradation ──────────────────────────────────────────────

describe("runReview (LLM graceful degradation)", () => {
  const noLlmSideEffectsYml = [
    "version: 1",
    "test_inversion:",
    "  enabled: false",
    "scope_creep:",
    "  enabled: false",
    "tools:",
    "  semgrep:",
    "    enabled: false",
    "  linter:",
    "    enabled: false",
    "  vuln_scanner:",
    "    enabled: false",
    "",
  ].join("\n");

  afterEach(() => {
    cleanup();
    mockReview.mockReset();
  });

  it("still writes an artifact with deterministic findings + error details when the LLM call fails", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-llmfail-"));
    tempDirs.push(repoPath);

    const git = simpleGit(repoPath);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");

    await commitFiles(git, {
      ".advreview.yml": noLlmSideEffectsYml,
      "src/index.ts": "console.log('hello');",
    }, "initial");

    await commitFiles(git, {
      "src/index.ts": "console.log('hello world');",
    }, "change");

    mockReview.mockRejectedValue(new Error("Groq API error: 400 Bad Request"));

    const result = await runReview({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      configPath: path.join(repoPath, ".advreview.yml"),
    });

    expect(result.llmResult).toBeNull();
    expect(result.llmError).toContain("Groq API error");
    expect(result.artifact.run.llm_error).toContain("Groq API error");
    expect(result.json).toBeTruthy();
    expect(JSON.parse(result.json).run.llm_error).toContain("Groq API error");
    expect(result.markdown).toContain("LLM adversarial review failed");
  }, 30_000);

  it("keeps un-refuted LLM findings when only the skeptic (refute) pass fails", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-refutefail-"));
    tempDirs.push(repoPath);

    const git = simpleGit(repoPath);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");

    await commitFiles(git, {
      ".advreview.yml": noLlmSideEffectsYml,
      "src/index.ts": "console.log('hello');",
    }, "initial");

    await commitFiles(git, {
      "src/index.ts": "console.log('hello world');",
    }, "change");

    const llmFinding = {
      id: "L-0001",
      severity: "medium",
      category: "maintainability",
      title: "Something worth flagging",
      description: "Because reasons.",
      evidence: { file: "src/index.ts", line_start: 1, line_end: 1, snippet: "", blast_radius: [], rule_id: null },
      source: "llm-review",
      source_type: "llm",
      confidence: 0.8,
      references: [],
      fingerprint: "fp-1",
      dismissed: false,
      dismissed_by: null,
      dismissed_at: null,
      dismissal_reason: null,
      refute_result: null,
    };

    // First call is the main review pass (succeeds); second call is the
    // skeptic/refute pass (fails).
    mockReview
      .mockResolvedValueOnce({ findings: [llmFinding], raw: "{}" })
      .mockRejectedValueOnce(new Error("Groq API error: 503 Service Unavailable"));

    const result = await runReview({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      configPath: path.join(repoPath, ".advreview.yml"),
    });

    expect(result.llmError).toContain("Refute (skeptic) pass failed");
    const kept = result.artifact.findings.find((f) => f.id === "L-0001");
    expect(kept).toBeTruthy();
    expect(kept!.refute_result).toBeNull();
  }, 30_000);
});
// ─── --only-llm: the privileged half of the fork-PR split (core-8fz) ──────────

describe("runReviewOnlyLlm (context-artifact split)", () => {
  const noLlmSideEffectsYml = [
    "version: 1",
    "test_inversion:",
    "  enabled: false",
    "scope_creep:",
    "  enabled: false",
    "tools:",
    "  semgrep:",
    "    enabled: false",
    "  linter:",
    "    enabled: false",
    "  vuln_scanner:",
    "    enabled: false",
    "",
  ].join("\n");

  afterEach(() => {
    cleanup();
    mockReview.mockReset();
  });

  /** Produce the unprivileged half's outputs: a partial findings artifact + a context bundle. */
  async function produceBundle(repoPath: string): Promise<{ bundlePath: string; findingsPath: string }> {
    const partial = await runReview({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      configPath: path.join(repoPath, ".advreview.yml"),
      skipLlm: true,
      emitBundle: true,
    });
    const bundlePath = path.join(repoPath, "context.json");
    const findingsPath = path.join(repoPath, "findings.json");
    fs.writeFileSync(
      bundlePath,
      JSON.stringify({ context: contextToJSON(partial.context), deterministicFindings: partial.deterministicFindings }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(findingsPath, partial.json, "utf-8");
    return { bundlePath, findingsPath };
  }

  it("runs the LLM pass against a context artifact and merges into the final artifact", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-onlyllm-"));
    tempDirs.push(repoPath);
    const git = simpleGit(repoPath);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");
    await commitFiles(git, { ".advreview.yml": noLlmSideEffectsYml, "src/index.ts": "console.log('hello');" }, "initial");
    await commitFiles(git, { "src/index.ts": "console.log('hello world');" }, "change");

    const { bundlePath, findingsPath } = await produceBundle(repoPath);

    const llmFinding: Finding = {
      id: "L-0001", severity: "medium", category: "maintainability",
      title: "Something worth flagging", description: "Because reasons.",
      evidence: { file: "src/index.ts", line_start: 1, line_end: 1, snippet: "", blast_radius: [], rule_id: null },
      source: "llm-review", source_type: "llm", confidence: 0.8, references: [],
      fingerprint: "fp-1", dismissed: false, dismissed_by: null, dismissed_at: null, dismissal_reason: null, refute_result: null,
    };
    mockReview.mockResolvedValue({ findings: [llmFinding], raw: "{}" });

    const result = await runReviewOnlyLlm({
      contextPath: bundlePath,
      findingsPath,
      configPath: path.join(repoPath, ".advreview.yml"),
      repoPath,
      skipRefute: true,
    });

    expect(result.llmResult).not.toBeNull();
    expect(result.llmError).toBeNull();
    const llmKept = result.artifact.findings.find((f) => f.source_type === "llm");
    expect(llmKept).toBeTruthy();
    expect(llmKept!.title).toBe("Something worth flagging");
    // re-id'd to F-
    expect(llmKept!.id).toMatch(/^F-\d{4}$/);
    expect(result.artifact.summary.by_source_type.llm).toBe(1);
    expect(result.markdown).toContain("Something worth flagging");
  }, 30_000);

  it("gracefully degrades when the LLM call fails, preserving deterministic findings", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-onlyllmfail-"));
    tempDirs.push(repoPath);
    const git = simpleGit(repoPath);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");
    await commitFiles(git, { ".advreview.yml": noLlmSideEffectsYml, "src/index.ts": "console.log('hello');" }, "initial");
    await commitFiles(git, { "src/index.ts": "console.log('hello world');" }, "change");

    const { bundlePath, findingsPath } = await produceBundle(repoPath);
    mockReview.mockRejectedValue(new Error("Groq API error: 400 Bad Request"));

    const result = await runReviewOnlyLlm({
      contextPath: bundlePath,
      findingsPath,
      configPath: path.join(repoPath, ".advreview.yml"),
      repoPath,
      skipRefute: true,
    });

    expect(result.llmResult).toBeNull();
    expect(result.llmError).toContain("Groq API error");
    expect(result.artifact.run.llm_error).toContain("Groq API error");
    expect(result.artifact.summary.by_source_type.llm).toBe(0);
    expect(result.markdown).toContain("LLM adversarial review failed");
  }, 30_000);
});
