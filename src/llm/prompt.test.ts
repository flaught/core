import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserPrompt, formatDismissalsForPrompt } from "./prompt.js";
import { FlaughtConfigSchema } from "../schemas/config.js";
import type { ReviewContext } from "../context/assembler.js";
import { NO_TEMPLATES, type PromptTemplates } from "../prompt/templates.js";
import type { DismissalEntry } from "../schemas/dismissals.js";

function makeDismissal(overrides: Partial<DismissalEntry> = {}): DismissalEntry {
  return {
    fingerprint: "sha256:abc123",
    dismissed_by: "jane@example.com",
    dismissed_at: "2025-01-15T10:30:00Z",
    reason: "Doc/ADR diff size is expected for a CI-wiring change",
    context: { title: "Extensive ADR and documentation changes unrelated to functional code", file: "docs/adr/0018-example.md" },
    expires_at: null,
    ...overrides,
  };
}

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

  it("accepts template overrides", () => {
    const config = FlaughtConfigSchema.parse({});
    const templates: PromptTemplates = {
      ...NO_TEMPLATES,
      systemAppend: "## Team Rules\n- No eval() allowed",
    };

    const prompt = buildSystemPrompt(config, templates);

    expect(prompt).toContain("devil's advocate"); // built-in still present
    expect(prompt).toContain("No eval() allowed"); // appended
  });

  it("uses full system override when provided", () => {
    const config = FlaughtConfigSchema.parse({});
    const templates: PromptTemplates = {
      ...NO_TEMPLATES,
      system: "You are a custom security reviewer.",
    };

    const prompt = buildSystemPrompt(config, templates);

    expect(prompt).toContain("custom security reviewer");
    expect(prompt).toContain("NOISE BUDGET"); // auto-injected
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

  it("appends user-append template content", () => {
    const config = FlaughtConfigSchema.parse({});
    const context = mockContext();
    const templates: PromptTemplates = {
      ...NO_TEMPLATES,
      userAppend: "Our project uses event-sourcing. Flag any direct DB writes.",
    };

    const prompt = buildUserPrompt(context, config, undefined, templates);

    expect(prompt).toContain("event-sourcing");
    expect(prompt).toContain("Flag any direct DB writes");
  });

  it("appends user-append after review instructions", () => {
    const config = FlaughtConfigSchema.parse({});
    const context = mockContext();
    const templates: PromptTemplates = {
      ...NO_TEMPLATES,
      userAppend: "## Team Rules\n- All inputs must be validated",
    };

    const prompt = buildUserPrompt(context, config, undefined, templates);
    const reviewIdx = prompt.indexOf("Review Instructions");
    const appendIdx = prompt.indexOf("Team Rules");

    expect(reviewIdx).toBeGreaterThan(-1);
    expect(appendIdx).toBeGreaterThan(reviewIdx);
  });

  it("omits the dismissals section when there are no active dismissals", () => {
    const config = FlaughtConfigSchema.parse({});
    const context = mockContext();
    const prompt = buildUserPrompt(context, config, undefined, NO_TEMPLATES, []);

    expect(prompt).not.toContain("Previously Reviewed & Dismissed");
  });

  it("injects active dismissals as a don't-re-raise digest", () => {
    const config = FlaughtConfigSchema.parse({});
    const context = mockContext();
    const dismissals = [makeDismissal()];
    const prompt = buildUserPrompt(context, config, undefined, NO_TEMPLATES, dismissals);

    expect(prompt).toContain("Previously Reviewed & Dismissed");
    expect(prompt).toContain("Extensive ADR and documentation changes unrelated to functional code");
    expect(prompt).toContain("docs/adr/0018-example.md");
    expect(prompt).toContain("Doc/ADR diff size is expected for a CI-wiring change");
    expect(prompt).toContain("Do not re-raise");
  });

  it("places the dismissals digest before the review instructions", () => {
    const config = FlaughtConfigSchema.parse({});
    const context = mockContext();
    const prompt = buildUserPrompt(context, config, undefined, NO_TEMPLATES, [makeDismissal()]);

    const dismissalsIdx = prompt.indexOf("Previously Reviewed & Dismissed");
    const reviewIdx = prompt.indexOf("Review Instructions");
    expect(dismissalsIdx).toBeGreaterThan(-1);
    expect(reviewIdx).toBeGreaterThan(dismissalsIdx);
  });
});

describe("formatDismissalsForPrompt", () => {
  it("returns an empty string for no entries", () => {
    expect(formatDismissalsForPrompt([])).toBe("");
  });

  it("caps the list and notes how many were omitted", () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      makeDismissal({ fingerprint: `sha256:${i}`, context: { title: `Finding ${i}`, file: "f.ts" } }),
    );
    const formatted = formatDismissalsForPrompt(entries);

    expect(formatted).toContain("Finding 0");
    expect(formatted).toContain("Finding 24");
    expect(formatted).not.toContain("Finding 25");
    expect(formatted).toContain("…and 5 older dismissal(s)");
  });
});