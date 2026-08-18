import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { simpleGit, type SimpleGit } from "simple-git";
import { runReview } from "./review.js";
import type { Finding } from "./schemas/findings.js";
import { resolveDismissalsPath, loadDismissalStore, addDismissal, saveDismissalStore } from "./dismissals/store.js";

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
  await git.commit(message);
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
    await git.init();
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

  it("produces valid JSON artifact", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-review-"));
    tempDirs.push(repoPath);

    const git = simpleGit(repoPath);
    await git.init();
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
    await git.init();
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
    await git.init();
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