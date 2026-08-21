import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, findConfigFile } from "./config.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-config-"));
  tempDirs.push(dir);
  return dir;
}

describe("loadConfig", () => {
  it("finds .advreview.yml via repoPath even when it differs from cwd", async () => {
    // Regression test: loadConfig used to only search configPath's dirname
    // or process.cwd(), completely ignoring repoPath. Anyone calling
    // `flaught review --repo /some/other/repo` from an unrelated cwd (the
    // most common way to test/wrap Flaught against a different checkout)
    // silently got full defaults instead of that repo's config.
    const repoPath = tempRepo();
    fs.writeFileSync(
      path.join(repoPath, ".advreview.yml"),
      "version: 1\nllm:\n  provider: anthropic\n  model: claude-sonnet-5\n  api_key_env: ANTHROPIC_API_KEY\n",
    );

    // process.cwd() during `npm test` is the repo root, which has no
    // .advreview.yml — so if repoPath weren't honored, this would silently
    // fall back to defaults (provider: groq) instead of throwing/finding.
    expect(path.resolve(process.cwd(), ".advreview.yml")).not.toBe(path.join(repoPath, ".advreview.yml"));

    const config = await loadConfig(undefined, repoPath);
    expect(config.llm.provider).toBe("anthropic");
    expect(config.llm.model).toBe("claude-sonnet-5");
  });

  it("prefers an explicit configPath over repoPath", async () => {
    const repoPath = tempRepo();
    fs.writeFileSync(path.join(repoPath, ".advreview.yml"), "version: 1\nllm:\n  provider: groq\n");

    const otherDir = tempRepo();
    const explicitConfigPath = path.join(otherDir, ".advreview.yml");
    fs.writeFileSync(explicitConfigPath, "version: 1\nllm:\n  provider: gemini\n");

    const config = await loadConfig(explicitConfigPath, repoPath);
    expect(config.llm.provider).toBe("gemini");
  });

  it("falls back to defaults when repoPath has no config file", async () => {
    const repoPath = tempRepo(); // empty, no .advreview.yml
    const config = await loadConfig(undefined, repoPath);
    expect(config.llm.provider).toBe("groq"); // schema default
  });

  it("still falls back to process.cwd() when neither configPath nor repoPath is given", async () => {
    // No assertion beyond "doesn't throw" — cwd during tests has no
    // .advreview.yml, so this exercises the original default path.
    const config = await loadConfig();
    expect(config.version).toBe(1);
  });
});

describe("findConfigFile", () => {
  it("finds a config file in the given directory", () => {
    const dir = tempRepo();
    fs.writeFileSync(path.join(dir, ".advreview.yml"), "version: 1\n");
    expect(findConfigFile(dir)).toBe(path.join(dir, ".advreview.yml"));
  });

  it("walks up to a parent directory", () => {
    const root = tempRepo();
    fs.writeFileSync(path.join(root, ".advreview.yml"), "version: 1\n");
    const nested = path.join(root, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    expect(findConfigFile(nested)).toBe(path.join(root, ".advreview.yml"));
  });

  it("returns null when no config file exists up the tree", () => {
    const dir = tempRepo(); // fresh temp dir; no .advreview.yml anywhere in its ancestry
    expect(findConfigFile(dir)).toBeNull();
  });
});
