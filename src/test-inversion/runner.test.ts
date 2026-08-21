import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { simpleGit, type SimpleGit } from "simple-git";
import {
  runTestInversion,
  isRelevantTestFile,
  extractPytestFile,
  extractVitestFile,
  parseTextTestOutput,
} from "./runner.js";
import { FlaughtConfigSchema } from "../schemas/config.js";

// ─── Unit tests: file extraction / relevance ──────────────────────────────────

describe("isRelevantTestFile", () => {
  it("matches an exact repo-relative path", () => {
    expect(isRelevantTestFile("src/foo.test.ts", new Set(["src/foo.test.ts"]))).toBe(true);
  });

  it("matches an absolute path against a relative one via suffix", () => {
    expect(isRelevantTestFile("/home/runner/work/repo/src/foo.test.ts", new Set(["src/foo.test.ts"]))).toBe(true);
  });

  it("does not match an unrelated file", () => {
    expect(isRelevantTestFile("src/bar.test.ts", new Set(["src/foo.test.ts"]))).toBe(false);
  });

  it("does not false-positive on a suffix that isn't a path boundary", () => {
    // "notfoo.test.ts" ends with "foo.test.ts" as a raw string but not on a "/" boundary
    expect(isRelevantTestFile("src/notfoo.test.ts", new Set(["foo.test.ts"]))).toBe(false);
  });
});

describe("extractPytestFile", () => {
  it("extracts the file from a path-like node id", () => {
    expect(extractPytestFile("tests/test_foo.py::test_bar")).toBe("tests/test_foo.py");
  });

  it("returns null when there's no :: separator", () => {
    expect(extractPytestFile("test_always_passes")).toBeNull();
  });

  it("returns null when the prefix doesn't look like a path", () => {
    expect(extractPytestFile("SomeModule::test_bar")).toBeNull();
  });
});

describe("extractVitestFile", () => {
  it("extracts the file from a default-reporter per-file summary line", () => {
    expect(extractVitestFile("src/schemas/config.test.ts (7 tests)")).toBe("src/schemas/config.test.ts");
  });

  it("returns null for a verbose per-test line with no file path", () => {
    expect(extractVitestFile("buildUserPrompt > includes the diff")).toBeNull();
  });
});

describe("parseTextTestOutput — vitest default reporter", () => {
  it("scopes findings to the file, not individual test count", () => {
    const output = [
      "✓ src/schemas/config.test.ts (7 tests) 4ms",
      "✓ src/llm/prompt.test.ts (20 tests) 5ms",
    ].join("\n");

    const { passed } = parseTextTestOutput(output, "npm test");
    expect(passed).toHaveLength(2);
    expect(passed[0]).toEqual({ name: "src/schemas/config.test.ts (7 tests)", file: "src/schemas/config.test.ts" });
    expect(passed[1]).toEqual({ name: "src/llm/prompt.test.ts (20 tests)", file: "src/llm/prompt.test.ts" });
  });
});

describe("parseTextTestOutput — go/rust have no file info", () => {
  it("go: file is always null", () => {
    const { passed } = parseTextTestOutput("--- PASS: TestSomething", "go test ./...");
    expect(passed).toEqual([{ name: "TestSomething", file: null }]);
  });

  it("rust: file is always null", () => {
    const { passed } = parseTextTestOutput("test tests::it_works ... ok", "cargo test");
    expect(passed).toEqual([{ name: "tests::it_works", file: null }]);
  });
});

// ─── Integration: runTestInversion scoping ────────────────────────────────────

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs = [];
});

async function commitFiles(git: SimpleGit, files: Record<string, string>, message: string): Promise<string> {
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

describe("runTestInversion — blast-radius scoping", () => {
  afterEach(() => {
    // handled by top-level afterEach
  });

  it("only flags tests whose file is in the relevant set, by default", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-testinv-"));
    tempDirs.push(repoPath);

    const git = simpleGit(repoPath);
    await git.init();
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");

    // A fixed "test command" that always reports the same two tests passing,
    // regardless of code state — both "pass on both base and head" by construction.
    const fakeCommand =
      "node -e \"console.log('PASSED src/relevant.test.ts::t1'); console.log('PASSED src/irrelevant.test.ts::t2')\"";

    await commitFiles(git, { "src/relevant.ts": "export const x = 1;" }, "initial");
    const baseSha = (await git.revparse(["HEAD"])).trim();
    const headSha = await commitFiles(git, { "src/relevant.ts": "export const x = 2;" }, "change x");

    const config = FlaughtConfigSchema.parse({ test_inversion: { command: fakeCommand } });

    const relevantFiles = new Set(["src/relevant.ts", "src/relevant.test.ts"]);
    const result = await runTestInversion(config, repoPath, baseSha, headSha, relevantFiles);

    expect(result).toBeTruthy();
    expect(result!.flagged.map((f) => f.test)).toEqual(["src/relevant.test.ts::t1"]);
  }, 30_000);

  it("falls back to unscoped when scope_to_blast_radius is false", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-testinv-"));
    tempDirs.push(repoPath);

    const git = simpleGit(repoPath);
    await git.init();
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");

    const fakeCommand =
      "node -e \"console.log('PASSED src/relevant.test.ts::t1'); console.log('PASSED src/irrelevant.test.ts::t2')\"";

    await commitFiles(git, { "src/relevant.ts": "export const x = 1;" }, "initial");
    const baseSha = (await git.revparse(["HEAD"])).trim();
    const headSha = await commitFiles(git, { "src/relevant.ts": "export const x = 2;" }, "change x");

    const config = FlaughtConfigSchema.parse({
      test_inversion: { command: fakeCommand, scope_to_blast_radius: false },
    });

    const relevantFiles = new Set(["src/relevant.ts", "src/relevant.test.ts"]);
    const result = await runTestInversion(config, repoPath, baseSha, headSha, relevantFiles);

    expect(result).toBeTruthy();
    expect(result!.flagged.map((f) => f.test).sort()).toEqual([
      "src/irrelevant.test.ts::t2",
      "src/relevant.test.ts::t1",
    ]);
  }, 30_000);
});
