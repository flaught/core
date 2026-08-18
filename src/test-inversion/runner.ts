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
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import type { FlaughtConfig } from "../schemas/config.js";
import type { FlaggedTest, TestInversion } from "../schemas/findings.js";

// ─── Test result parsing ──────────────────────────────────────────────────────

export interface TestRunResult {
  /** The command that was run */
  command: string;
  /** Whether the test runner executed successfully (even if tests failed) */
  success: boolean;
  /** Exit code from the test runner */
  exitCode: number;
  /** Names of tests that passed */
  passed: string[];
  /** Names of tests that failed */
  failed: string[];
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
    const headPassedSet = new Set(headResult.passed);
    const basePassedSet = new Set(baseResult.passed);

    const flagged: FlaggedTest[] = [];

    for (const testName of headPassedSet) {
      if (basePassedSet.has(testName)) {
        flagged.push({
          test: testName,
          reason: "Test passes on both base and head — does not verify the change it claims to test",
        });
      }
    }

    if (flagged.length > 0) {
      progress(`  ⚠ ${flagged.length} test(s) pass on both base and head (don't test the change)`);
    } else {
      progress("  All passing tests fail on base — good test coverage of the change");
    }

    return {
      command: testCommand,
      base_passed: [...basePassedSet].sort(),
      head_passed: [...headPassedSet].sort(),
      flagged,
    };
  } finally {
    if (worktreePath) {
      await removeWorktree(repoPath, worktreePath);
    }
  }
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

function parseTestOutput(output: string, command: string): { passed: string[]; failed: string[] } {
  // Try JSON formats first
  const jsonResult = parseJsonTestOutput(output);
  if (jsonResult) return jsonResult;

  // Fall back to text parsing
  return parseTextTestOutput(output, command);
}

function parseJsonTestOutput(output: string): { passed: string[]; failed: string[] } | null {
  // Try to find JSON in the output (some runners wrap it in other text)
  const jsonMatch = output.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[0]);
      if (data.testResults && Array.isArray(data.testResults)) {
        // Jest format
        const passed: string[] = [];
        const failed: string[] = [];
        for (const suite of data.testResults) {
          for (const test of suite.assertionResults ?? []) {
            const name = `${suite.name}::${test.fullName ?? test.title}`;
            if (test.status === "passed") passed.push(name);
            else if (test.status === "failed") failed.push(name);
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
        const passed: string[] = [];
        const failed: string[] = [];
        for (const test of data.tests) {
          const name = `${test.filepath ?? test.file ?? ""}::${test.name ?? test.taskId ?? ""}`;
          if (test.type === "pass" || test.status === "pass") passed.push(name);
          else if (test.type === "fail" || test.status === "fail") failed.push(name);
        }
        if (passed.length > 0 || failed.length > 0) return { passed, failed };
      }
    } catch {
      // Not valid JSON
    }
  }

  return null;
}

function parseTextTestOutput(output: string, _command: string): { passed: string[]; failed: string[] } {
  const passed: string[] = [];
  const failed: string[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    // Jest: PASS src/foo.test.ts > test name
    const jestPass = line.match(/^PASS\s+(.+?)(?:\s+>|›)/);
    if (jestPass) {
      passed.push(jestPass[1]!.trim());
      continue;
    }

    // Jest: FAIL src/foo.test.ts > test name
    const jestFail = line.match(/^FAIL\s+(.+?)(?:\s+>|›)/);
    if (jestFail) {
      failed.push(jestFail[1]!.trim());
      continue;
    }

    // pytest: PASSED test_module::test_name
    const pytestPass = line.match(/^PASSED\s+(.+)/);
    if (pytestPass) {
      passed.push(pytestPass[1]!.trim());
      continue;
    }

    // pytest: FAILED test_module::test_name
    const pytestFail = line.match(/^FAILED\s+(.+)/);
    if (pytestFail) {
      failed.push(pytestFail[1]!.trim());
      continue;
    }

    // Vitest / generic: ✓ test name (Nms)
    const vitestPass = line.match(/^[\s]*✓\s+(.+?)(?:\s+\d)/);
    if (vitestPass) {
      passed.push(vitestPass[1]!.trim());
      continue;
    }

    // Vitest / generic: ✗ test name
    const vitestFail = line.match(/^[\s]*✗\s+(.+)/) || line.match(/^[\s]*FAIL\s+(.+)/);
    if (vitestFail) {
      failed.push(vitestFail[1]!.trim());
      continue;
    }

    // Go: --- PASS: TestName
    const goPass = line.match(/^--- PASS:\s+(.+)/);
    if (goPass) {
      passed.push(goPass[1]!.trim());
      continue;
    }

    // Go: --- FAIL: TestName
    const goFail = line.match(/^--- FAIL:\s+(.+)/);
    if (goFail) {
      failed.push(goFail[1]!.trim());
      continue;
    }

    // Rust: test name ... ok
    const rustPass = line.match(/^test\s+(.+?)\s+\.\.\.\s+ok/);
    if (rustPass) {
      passed.push(rustPass[1]!.trim());
      continue;
    }

    // Rust: test name ... FAILED
    const rustFail = line.match(/^test\s+(.+?)\s+\.\.\.\s+FAILED/);
    if (rustFail) {
      failed.push(rustFail[1]!.trim());
      continue;
    }
  }

  // Deduplicate
  return {
    passed: [...new Set(passed)],
    failed: [...new Set(failed)],
  };
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