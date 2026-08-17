import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { FlaughtConfigSchema } from "../schemas/config.js";
import type { ReviewContext } from "../context/assembler.js";

describe("buildSystemPrompt", () => {
  it("includes the adversarial posture", () => {
    const config = FlaughtConfigSchema.parse({});
    const prompt = buildSystemPrompt(config);

    expect(prompt).toContain("devil's advocate");
    expect(prompt).toContain("case against merging");
    expect(prompt).toContain("skeptical senior engineer");
  });

  it("includes the noise budget", () => {
    const config = FlaughtConfigSchema.parse({
      noise_budget: { critical: 3, high: 8, medium: 12 },
    });
    const prompt = buildSystemPrompt(config);

    expect(prompt).toContain("critical: max 3 findings");
    expect(prompt).toContain("high: max 8 findings");
    expect(prompt).toContain("medium: max 12 findings");
  });

  it("specifies the exact JSON output format", () => {
    const config = FlaughtConfigSchema.parse({});
    const prompt = buildSystemPrompt(config);

    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"severity"');
    expect(prompt).toContain('"category"');
    expect(prompt).toContain('"confidence"');
  });

  it("lists all valid categories", () => {
    const config = FlaughtConfigSchema.parse({});
    const prompt = buildSystemPrompt(config);

    expect(prompt).toContain("security");
    expect(prompt).toContain("architecture");
    expect(prompt).toContain("scope-creep");
    expect(prompt).toContain("test-quality");
    expect(prompt).toContain("performance");
    expect(prompt).toContain("maintainability");
  });

  it("lists all valid severities", () => {
    const config = FlaughtConfigSchema.parse({});
    const prompt = buildSystemPrompt(config);

    expect(prompt).toContain("critical");
    expect(prompt).toContain("high");
    expect(prompt).toContain("medium");
    expect(prompt).toContain("low");
    expect(prompt).toContain("info");
  });
});

// ─── Mock dependency graph for tests ────────────────────────────────────────

function mockDependencyGraph(): { getDependentsOf: (files: Set<string>) => string[]; getDependenciesOf: (file: string) => string[]; getImportsFor: (file: string) => never[]; getAllFiles: () => string[] } {
  return {
    getDependentsOf: () => [],
    getDependenciesOf: () => [],
    getImportsFor: () => [],
    getAllFiles: () => ["src/index.ts", "src/app.ts", "src/db.ts"],
  };
}

function mockContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    diff: 'diff --git a/src/app.ts b/src/app.ts\n+export const app = {};\n',
    changedFiles: [
      { path: "src/app.ts", additions: 1, deletions: 0, status: "modified" as const },
    ],
    neighborhoodFiles: [],
    changedFileContents: new Map([["src/app.ts", "export const app = {};\n"]]),
    neighborhoodFileContents: new Map(),
    dependencyGraph: mockDependencyGraph(),
    baseSha: "abc123",
    headSha: "def456",
    repoRoot: "/tmp/test-repo",
    ...overrides,
  };
}

describe("buildUserPrompt", () => {
  it("includes the diff", () => {
    const config = FlaughtConfigSchema.parse({});
    const context = mockContext();
    const prompt = buildUserPrompt(context, config);

    expect(prompt).toContain("Unified Diff");
    expect(prompt).toContain("diff --git");
  });

  it("includes changed file contents", () => {
    const config = FlaughtConfigSchema.parse({});
    const context = mockContext();
    const prompt = buildUserPrompt(context, config);

    expect(prompt).toContain("src/app.ts");
    expect(prompt).toContain("Changed File Contents");
  });

  it("includes the PR description when provided", () => {
    const config = FlaughtConfigSchema.parse({});
    const context = mockContext();
    const prompt = buildUserPrompt(context, config, "Add authentication middleware");

    expect(prompt).toContain("PR Description");
    expect(prompt).toContain("Add authentication middleware");
  });

  it("includes blast radius when neighborhood files exist", () => {
    const config = FlaughtConfigSchema.parse({});
    const context = mockContext({
      neighborhoodFiles: ["src/routes.ts", "src/auth.ts"],
    });
    const prompt = buildUserPrompt(context, config);

    expect(prompt).toContain("Blast Radius");
    expect(prompt).toContain("src/routes.ts");
    expect(prompt).toContain("src/auth.ts");
  });

  it("includes changed files summary", () => {
    const config = FlaughtConfigSchema.parse({});
    const context = mockContext({
      changedFiles: [
        { path: "src/app.ts", additions: 10, deletions: 2, status: "modified" as const },
        { path: "src/new.ts", additions: 5, deletions: 0, status: "added" as const },
      ],
    });
    const prompt = buildUserPrompt(context, config);

    expect(prompt).toContain("~ src/app.ts (+10/-2)");
    expect(prompt).toContain("+ src/new.ts (+5/-0)");
  });

  it("includes review instructions", () => {
    const config = FlaughtConfigSchema.parse({});
    const context = mockContext();
    const prompt = buildUserPrompt(context, config);

    expect(prompt).toContain("Review Instructions");
    expect(prompt).toContain("adversarially");
    expect(prompt).toContain("valid JSON");
  });
});