/**
 * Test inversion — run changed tests against both pre- and post-change code.
 *
 * If a test passes on BOTH base and head, it doesn't actually test the change.
 * This is cheap mutation testing and the backbone of the test-quality section.
 *
 * Approach:
 * 1. Detect the test command for the repo's stack
 * 2. Run tests on HEAD (post-change) — record which pass
 * 3. Create a temporary git worktree at the base SHA — run tests there
 * 4. Compare: tests that pass on BOTH sides are flagged as not testing the change
 * 5. Scope step 4's results to tests whose file is a changed file or in its
 *    blast radius — the whole test command runs regardless (that's how we
 *    learn what passes on both sides at all), but a test file the diff
 *    couldn't possibly have affected passing unchanged isn't a quality
 *    signal, it's just... unrelated. See `isRelevantTestFile` below.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import type { FlaughtConfig } from "../schemas/config.js";
import type { FlaggedTest, TestInversion } from "../schemas/findings.js";

// ─── Test result parsing ──────────────────────────────────────────────────────

/**
 * A single test result. `file` is the best-effort source file it belongs to
 * (repo-relative or absolute, format-dependent) — null when the test
 * runner's output doesn't let us determine it (e.g. Go, Rust).
 */
export interface TestEntry {
  name: string;
  file: string | null;
}

export interface TestRunResult {
  /** The command that was run */
  command: string;
  /** Whether the test runner executed successfully (even if tests failed) */
  success: boolean;
  /** Exit code from the test runner */
  exitCode: number;
  /** Tests that passed */
  passed: TestEntry[];
  /** Tests that failed */
  failed: TestEntry[];
  /** Raw stdout */
  stdout: string;
  /** Raw stderr */
  stderr: string;
  /** Duration in ms */
  durationMs: number;
}

// ─── Main test inversion runner ──────────────────────────────────────────────

export async function runTestInversion(
  config: FlaughtConfig,
  repoPath: string,
  baseSha: string,
  _headSha: string,
  /**
   * Changed files + their one-hop dependency blast radius (repo-relative
   * paths), used to scope which "passes on both sides" tests get flagged.
   * Ignored when `test_inversion.scope_to_blast_radius` is false.
   */
  relevantFiles: Set<string>,
  onProgress?: (message: string) => void,
): Promise<TestInversion | null> {
  const progress = onProgress ?? (() => {});

  if (!config.test_inversion.enabled) {
    progress("  Test inversion disabled in config — skipping.");
    return null;
  }

  // Detect the test command
  const testCommand = config.test_inversion.command ?? await detectTestCommand(repoPath);
  if (!testCommand) {
    progress("  No test command detected — skipping test inversion.");
    return null;
  }

  progress(`  Test command: ${testCommand}`);
  progress("  Running tests on HEAD (post-change)...");

  // 1. Run tests on HEAD
  const headResult = await runTests(testCommand, repoPath);
  progress(`    HEAD: ${headResult.passed.length} passed, ${headResult.failed.length} failed (${headResult.durationMs}ms)`);

  // 2. Create a worktree at the base SHA and run tests there
  let worktreePath: string | null = null;
  try {
    worktreePath = await createWorktree(repoPath, baseSha);
    if (!worktreePath) {
      progress("  Could not create worktree for base — skipping test inversion.");
      return null;
    }

    progress("  Running tests on BASE (pre-change)...");
    const baseResult = await runTests(testCommand, worktreePath);
    progress(`    BASE: ${baseResult.passed.length} passed, ${baseResult.failed.length} failed (${baseResult.durationMs}ms)`);

    // 3. Compare: tests that pass on BOTH sides don't test the change
    const headPassedNames = new Set(headResult.passed.map((t) => t.name));
    const basePassedNames = new Set(baseResult.passed.map((t) => t.name));
    // File lookup for scoping — head and base should agree on a test's file,
    // but prefer head's (the version actually being reviewed) if they differ.
    const fileByName = new Map<string, string | null>();
    for (const t of baseResult.passed) fileByName.set(t.name, t.file);
    for (const t of headResult.passed) fileByName.set(t.name, t.file);

    const flagged: FlaggedTest[] = [];
    let scopedOutCount = 0;

    for (const testName of headPassedNames) {
      if (!basePassedNames.has(testName)) continue;

      const file = fileByName.get(testName) ?? null;
      // Scope to the diff's blast radius when we could determine the file —
      // an unrelated test file passing unchanged isn't a quality signal.
      // When the file couldn't be determined (Go, Rust, unrecognized
      // formats), keep it unscoped rather than silently dropping it.
      if (
        config.test_inversion.scope_to_blast_radius &&
        file !== null &&
        !isRelevantTestFile(file, relevantFiles)
      ) {
        scopedOutCount++;
        continue;
      }

      flagged.push({
        test: testName,
        reason: "Test passes on both base and head — does not verify the change it claims to test",
      });
    }

    if (scopedOutCount > 0) {
      progress(`  (scoped out ${scopedOutCount} test(s) unrelated to this diff's changed/blast-radius files)`);
    }
    if (flagged.length > 0) {
      progress(`  ⚠ ${flagged.length} test(s) pass on both base and head (don't test the change)`);
    } else {
      progress("  All passing tests fail on base — good test coverage of the change");
    }

    return {
      command: testCommand,
      base_passed: [...basePassedNames].sort(),
      head_passed: [...headPassedNames].sort(),
      flagged,
    };
  } finally {
    if (worktreePath) {
      await removeWorktree(repoPath, worktreePath);
    }
  }
}

// ─── Blast-radius scoping ──────────────────────────────────────────────────────

/**
 * Whether a test file counts as within the diff's blast radius. Handles
 * absolute-vs-repo-relative mismatches (some test runners report absolute
 * paths) by allowing a suffix match on path segments, not just exact equality.
 */
export function isRelevantTestFile(file: string, relevantFiles: Set<string>): boolean {
  const normalized = file.replace(/^\.\//, "");
  for (const rel of relevantFiles) {
    if (normalized === rel) return true;
    if (normalized.endsWith(`/${rel}`)) return true;
    if (rel.endsWith(`/${normalized}`)) return true;
  }
  return false;
}

// ─── Test command detection ──────────────────────────────────────────────────

async function detectTestCommand(repoPath: string): Promise<string | null> {
  // Check for known test frameworks based on project files
  const fs = await import("node:fs");
  const path = await import("node:path");

  // JavaScript/TypeScript: npm test / yarn test / pnpm test
  if (fs.existsSync(path.join(repoPath, "package.json"))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, "package.json"), "utf-8"));
      if (pkg.scripts?.test && pkg.scripts.test !== "echo \\\"Error: no test specified\\\" && exit 1") {
        return "npm test";
      }
    } catch {
      // Couldn't parse package.json
    }
  }

  // Python: pytest
  if (fs.existsSync(path.join(repoPath, "pyproject.toml")) ||
      fs.existsSync(path.join(repoPath, "setup.py")) ||
      fs.existsSync(path.join(repoPath, "requirements.txt"))) {
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(exec)("pytest --version", { cwd: repoPath });
      return "pytest";
    } catch {
      // pytest not available
    }
  }

  // Go: go test
  if (fs.existsSync(path.join(repoPath, "go.mod"))) {
    return "go test ./...";
  }

  // Rust: cargo test
  if (fs.existsSync(path.join(repoPath, "Cargo.toml"))) {
    return "cargo test";
  }

  return null;
}

// ─── Test execution ──────────────────────────────────────────────────────────

async function runTests(command: string, cwd: string): Promise<TestRunResult> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  const startTime = Date.now();

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000, // 5 minute timeout for tests
      env: {
        ...process.env,
        // Force non-interactive mode for most test runners
        CI: "true",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    });

    const durationMs = Date.now() - startTime;
    const parsed = parseTestOutput(stdout + "\n" + stderr, command);

    return {
      command,
      success: true,
      exitCode: 0,
      passed: parsed.passed,
      failed: parsed.failed,
      stdout,
      stderr,
      durationMs,
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;

    // Many test runners exit non-zero when tests fail, but still produce output
    const stdout = err.stdout ?? "";
    const stderr = err.stderr ?? "";
    const parsed = parseTestOutput(stdout + "\n" + stderr, command);

    return {
      command,
      success: true, // The runner ran, even if tests failed
      exitCode: err.code ?? 1,
      passed: parsed.passed,
      failed: parsed.failed,
      stdout,
      stderr,
      durationMs,
    };
  }
}

// ─── Test output parsing ──────────────────────────────────────────────────────

function parseTestOutput(output: string, command: string): { passed: TestEntry[]; failed: TestEntry[] } {
  // Try JSON formats first
  const jsonResult = parseJsonTestOutput(output);
  if (jsonResult) return jsonResult;

  // Fall back to text parsing
  return parseTextTestOutput(output, command);
}

function parseJsonTestOutput(output: string): { passed: TestEntry[]; failed: TestEntry[] } | null {
  // Try to find JSON in the output (some runners wrap it in other text)
  const jsonMatch = output.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[0]);
      if (data.testResults && Array.isArray(data.testResults)) {
        // Jest format — suite.name is the test file's path
        const passed: TestEntry[] = [];
        const failed: TestEntry[] = [];
        for (const suite of data.testResults) {
          const file = typeof suite.name === "string" ? suite.name : null;
          for (const test of suite.assertionResults ?? []) {
            const name = `${suite.name}::${test.fullName ?? test.title}`;
            if (test.status === "passed") passed.push({ name, file });
            else if (test.status === "failed") failed.push({ name, file });
          }
        }
        if (passed.length > 0 || failed.length > 0) return { passed, failed };
      }
    } catch {
      // Not valid JSON
    }
  }

  // Vitest format
  const vitestMatch = output.match(/\{[\s\S]*"tests"[\s\S]*\}/);
  if (vitestMatch) {
    try {
      const data = JSON.parse(vitestMatch[0]);
      if (data.tests && Array.isArray(data.tests)) {
        const passed: TestEntry[] = [];
        const failed: TestEntry[] = [];
        for (const test of data.tests) {
          const file = typeof (test.filepath ?? test.file) === "string" ? (test.filepath ?? test.file) : null;
          const name = `${file ?? ""}::${test.name ?? test.taskId ?? ""}`;
          if (test.type === "pass" || test.status === "pass") passed.push({ name, file });
          else if (test.type === "fail" || test.status === "fail") failed.push({ name, file });
        }
        if (passed.length > 0 || failed.length > 0) return { passed, failed };
      }
    } catch {
      // Not valid JSON
    }
  }

  return null;
}

/**
 * Best-effort file extraction from a pytest node id ("tests/test_foo.py::test_bar").
 * Returns null when the prefix before "::" doesn't look like a real path —
 * conservative, so an unrecognized shape falls back to "unknown" rather than
 * a wrong file.
 */
export function extractPytestFile(nodeId: string): string | null {
  const idx = nodeId.indexOf("::");
  if (idx === -1) return null;
  const candidate = nodeId.slice(0, idx);
  return candidate.includes("/") || candidate.endsWith(".py") ? candidate : null;
}

/**
 * Best-effort file extraction from vitest's per-file summary line: "src/foo.test.ts
 * (7 tests)". Returns null for anything else (e.g. an individual "describe >
 * test name" line) rather than guessing.
 *
 * Note this per-file line isn't the only shape vitest's *default* reporter
 * emits, even without `--reporter=verbose`: any individual test slower than
 * the slow-test threshold (~300ms) also gets its own indented line, printed
 * right after its file's summary line. That line has no file info of its
 * own — `parseTextTestOutput` below associates it with the file line that
 * most recently preceded it, rather than treating the absence of a match
 * here as unscopable.
 */
export function extractVitestFile(raw: string): string | null {
  const match = /^(.+?)\s+\(\d+\s+tests?\)$/.exec(raw);
  const candidate = match ? match[1]! : raw;
  return candidate.includes("/") && /\.(test|spec)\.[jt]sx?$/.test(candidate) ? candidate : null;
}

export function parseTextTestOutput(output: string, _command: string): { passed: TestEntry[]; failed: TestEntry[] } {
  const passed: TestEntry[] = [];
  const failed: TestEntry[] = [];
  const seenPassed = new Set<string>();
  const seenFailed = new Set<string>();
  const lines = output.split("\n");
  // Vitest prints a file's slow sub-test lines immediately after that file's
  // own summary line — track the most recent one as a fallback for a
  // sub-test line that doesn't parse as a file summary on its own.
  let currentVitestFile: string | null = null;

  for (const line of lines) {
    // Jest: PASS src/foo.test.ts > test name
    const jestPass = line.match(/^PASS\s+(.+?)(?:\s+>|›)/);
    if (jestPass) {
      const name = jestPass[1]!.trim();
      if (!seenPassed.has(name)) { seenPassed.add(name); passed.push({ name, file: name }); }
      continue;
    }

    // Jest: FAIL src/foo.test.ts > test name
    const jestFail = line.match(/^FAIL\s+(.+?)(?:\s+>|›)/);
    if (jestFail) {
      const name = jestFail[1]!.trim();
      if (!seenFailed.has(name)) { seenFailed.add(name); failed.push({ name, file: name }); }
      continue;
    }

    // pytest: PASSED test_module::test_name
    const pytestPass = line.match(/^PASSED\s+(.+)/);
    if (pytestPass) {
      const name = pytestPass[1]!.trim();
      if (!seenPassed.has(name)) { seenPassed.add(name); passed.push({ name, file: extractPytestFile(name) }); }
      continue;
    }

    // pytest: FAILED test_module::test_name
    const pytestFail = line.match(/^FAILED\s+(.+)/);
    if (pytestFail) {
      const name = pytestFail[1]!.trim();
      if (!seenFailed.has(name)) { seenFailed.add(name); failed.push({ name, file: extractPytestFile(name) }); }
      continue;
    }

    // Vitest / generic: ✓ test name (Nms)
    const vitestPass = line.match(/^[\s]*✓\s+(.+?)(?:\s+\d)/);
    if (vitestPass) {
      const name = vitestPass[1]!.trim();
      const extracted = extractVitestFile(name);
      if (extracted) currentVitestFile = extracted;
      if (!seenPassed.has(name)) { seenPassed.add(name); passed.push({ name, file: extracted ?? currentVitestFile }); }
      continue;
    }

    // Vitest / generic: ✗ test name
    const vitestFail = line.match(/^[\s]*✗\s+(.+)/) || line.match(/^[\s]*FAIL\s+(.+)/);
    if (vitestFail) {
      const name = vitestFail[1]!.trim();
      const extracted = extractVitestFile(name);
      if (extracted) currentVitestFile = extracted;
      if (!seenFailed.has(name)) { seenFailed.add(name); failed.push({ name, file: extracted ?? currentVitestFile }); }
      continue;
    }

    // Go: --- PASS: TestName (no file info in this output format)
    const goPass = line.match(/^--- PASS:\s+(.+)/);
    if (goPass) {
      const name = goPass[1]!.trim();
      if (!seenPassed.has(name)) { seenPassed.add(name); passed.push({ name, file: null }); }
      continue;
    }

    // Go: --- FAIL: TestName
    const goFail = line.match(/^--- FAIL:\s+(.+)/);
    if (goFail) {
      const name = goFail[1]!.trim();
      if (!seenFailed.has(name)) { seenFailed.add(name); failed.push({ name, file: null }); }
      continue;
    }

    // Rust: test name ... ok (no file info in this output format)
    const rustPass = line.match(/^test\s+(.+?)\s+\.\.\.\s+ok/);
    if (rustPass) {
      const name = rustPass[1]!.trim();
      if (!seenPassed.has(name)) { seenPassed.add(name); passed.push({ name, file: null }); }
      continue;
    }

    // Rust: test name ... FAILED
    const rustFail = line.match(/^test\s+(.+?)\s+\.\.\.\s+FAILED/);
    if (rustFail) {
      const name = rustFail[1]!.trim();
      if (!seenFailed.has(name)) { seenFailed.add(name); failed.push({ name, file: null }); }
      continue;
    }
  }

  return { passed, failed };
}

// ─── Git worktree management ──────────────────────────────────────────────────

async function createWorktree(repoPath: string, baseSha: string): Promise<string | null> {
  const worktreePath = path.join(repoPath, `.flaught-worktree-${Date.now()}`);

  const git = simpleGit(repoPath);

  try {
    // Create a temporary worktree at the base SHA
    await git.raw(["worktree", "add", "--detach", worktreePath, baseSha]);

    // Install dependencies if needed (npm install, pip install, etc.)
    await installDependencies(worktreePath);

    return worktreePath;
  } catch (err) {
    // Worktree creation failed — clean up and return null
    try {
      await fs.promises.rm(worktreePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures
    }
    return null;
  }
}

async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const git = simpleGit(repoPath);
  try {
    await git.raw(["worktree", "remove", "--force", worktreePath]);
  } catch {
    // If git worktree remove fails, try manual cleanup
    try {
      await fs.promises.rm(worktreePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures — temporary directories are fine
    }
  }
}

async function installDependencies(worktreePath: string): Promise<void> {
  // Install dependencies in the worktree so tests can run
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  const packageJsonPath = path.join(worktreePath, "package.json");
  const requirementsTxtPath = path.join(worktreePath, "requirements.txt");
  const pyprojectPath = path.join(worktreePath, "pyproject.toml");
  const goModPath = path.join(worktreePath, "go.mod");
  const cargoPath = path.join(worktreePath, "Cargo.toml");

  try {
    if (fs.existsSync(packageJsonPath)) {
      await execAsync("npm install --ignore-scripts --no-audit --no-fund", {
        cwd: worktreePath,
        timeout: 120_000,
      });
    } else if (fs.existsSync(requirementsTxtPath) || fs.existsSync(pyprojectPath)) {
      // Try pip install (in a virtualenv if possible)
      await execAsync("pip install -e . 2>/dev/null || pip install -r requirements.txt 2>/dev/null || true", {
        cwd: worktreePath,
        timeout: 120_000,
      });
    } else if (fs.existsSync(goModPath)) {
      await execAsync("go mod download", {
        cwd: worktreePath,
        timeout: 120_000,
      });
    } else if (fs.existsSync(cargoPath)) {
      await execAsync("cargo build 2>/dev/null || true", {
        cwd: worktreePath,
        timeout: 120_000,
      });
    }
  } catch {
    // Dependency installation failure is not fatal — tests may still work
    // with existing dependencies from the main checkout
  }
}