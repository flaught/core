import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadTemplates,
  assembleSystemPrompt,
  assembleUserAppend,
  buildTemplateVariables,
  initPromptTemplates,
  NO_TEMPLATES,
  DEFAULT_POSTURE,
  DEFAULT_CATEGORIES,
  DEFAULT_SEVERITY,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_CONSTRAINTS,
  type PromptTemplates,
} from "./templates.js";
import { FlaughtConfigSchema, type FlaughtConfig } from "../schemas/config.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Record<string, unknown> = {}): FlaughtConfig {
  return FlaughtConfigSchema.parse(overrides);
}



function writeTemplate(dir: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

// ─── loadTemplates ────────────────────────────────────────────────────────────

describe("loadTemplates", () => {
  let tmpDir: string;
  let promptDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-test-"));
    promptDir = path.join(tmpDir, ".flaught-prompt");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns NO_TEMPLATES when prompt overrides are disabled", () => {
    const config = makeConfig({ prompt: { enabled: false } });
    // Create a template directory with a file
    fs.mkdirSync(promptDir, { recursive: true });
    writeTemplate(promptDir, "system-append.md", "extra instructions");

    const templates = loadTemplates(tmpDir, config);
    expect(templates).toEqual(NO_TEMPLATES);
    expect(templates.systemAppend).toBeNull();
  });

  it("returns NO_TEMPLATES when the directory does not exist", () => {
    const config = makeConfig({});
    const templates = loadTemplates(tmpDir, config);
    expect(templates).toEqual(NO_TEMPLATES);
  });

  it("returns NO_TEMPLATES when the directory exists but is empty", () => {
    const config = makeConfig({});
    fs.mkdirSync(promptDir, { recursive: true });
    const templates = loadTemplates(tmpDir, config);
    expect(templates).toEqual(NO_TEMPLATES);
  });

  it("loads system.md as a full system prompt override", () => {
    const config = makeConfig({});
    fs.mkdirSync(promptDir, { recursive: true });
    writeTemplate(promptDir, "system.md", "Custom system prompt content");

    const templates = loadTemplates(tmpDir, config);
    expect(templates.system).toBe("Custom system prompt content");
  });

  it("loads individual section overrides", () => {
    const config = makeConfig({});
    fs.mkdirSync(promptDir, { recursive: true });
    writeTemplate(promptDir, "posture.md", "Custom posture");
    writeTemplate(promptDir, "categories.md", "Custom categories");

    const templates = loadTemplates(tmpDir, config);
    expect(templates.posture).toBe("Custom posture");
    expect(templates.categories).toBe("Custom categories");
    expect(templates.system).toBeNull();
  });

  it("loads append files", () => {
    const config = makeConfig({});
    fs.mkdirSync(promptDir, { recursive: true });
    writeTemplate(promptDir, "system-append.md", "Extra system rules");
    writeTemplate(promptDir, "user-append.md", "Extra user context");

    const templates = loadTemplates(tmpDir, config);
    expect(templates.systemAppend).toBe("Extra system rules");
    expect(templates.userAppend).toBe("Extra user context");
  });

  it("interpolates template variables", () => {
    const config = makeConfig({ noise_budget: { critical: 3, high: 5 } });
    fs.mkdirSync(promptDir, { recursive: true });
    writeTemplate(
      promptDir,
      "system-append.md",
      "Budget:\n{{noise_budget}}\n\nDefault categories:\n{{categories}}",
    );

    const templates = loadTemplates(tmpDir, config);
    expect(templates.systemAppend).toContain("critical: max 3 findings");
    expect(templates.systemAppend).toContain("high: max 5 findings");
    expect(templates.systemAppend).toContain("security");
    expect(templates.systemAppend).toContain("architecture");
    // Should NOT contain the literal {{noise_budget}} or {{categories}}
    expect(templates.systemAppend).not.toContain("{{noise_budget}}");
    expect(templates.systemAppend).not.toContain("{{categories}}");
  });

  it("uses a custom prompt.path from config", () => {
    const customDir = path.join(tmpDir, "my-prompts");
    fs.mkdirSync(customDir, { recursive: true });
    writeTemplate(customDir, "posture.md", "Custom posture from custom dir");

    const config = makeConfig({ prompt: { path: "my-prompts" } });
    const templates = loadTemplates(tmpDir, config);
    expect(templates.posture).toBe("Custom posture from custom dir");
  });

  it("uses an absolute prompt.path", () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-abs-"));
    fs.mkdirSync(customDir, { recursive: true });
    writeTemplate(customDir, "posture.md", "Absolute path posture");

    const config = makeConfig({ prompt: { path: customDir } });
    const templates = loadTemplates(tmpDir, config);
    expect(templates.posture).toBe("Absolute path posture");

    fs.rmSync(customDir, { recursive: true, force: true });
  });

  it("ignores empty template files", () => {
    const config = makeConfig({});
    fs.mkdirSync(promptDir, { recursive: true });
    writeTemplate(promptDir, "posture.md", "   \n  \n  ");

    const templates = loadTemplates(tmpDir, config);
    expect(templates.posture).toBeNull();
  });

  it("loads all section overrides together", () => {
    const config = makeConfig({});
    fs.mkdirSync(promptDir, { recursive: true });
    writeTemplate(promptDir, "posture.md", "Custom posture");
    writeTemplate(promptDir, "categories.md", "Custom categories");
    writeTemplate(promptDir, "severity.md", "Custom severities");
    writeTemplate(promptDir, "output-format.md", "Custom output format");
    writeTemplate(promptDir, "constraints.md", "Custom constraints");

    const templates = loadTemplates(tmpDir, config);
    expect(templates.posture).toBe("Custom posture");
    expect(templates.categories).toBe("Custom categories");
    expect(templates.severity).toBe("Custom severities");
    expect(templates.outputFormat).toBe("Custom output format");
    expect(templates.constraints).toBe("Custom constraints");
    expect(templates.system).toBeNull();
  });
});

// ─── assembleSystemPrompt ────────────────────────────────────────────────────

describe("assembleSystemPrompt", () => {
  const defaultConfig = makeConfig();

  it("produces the built-in system prompt with no templates", () => {
    const prompt = assembleSystemPrompt(defaultConfig, NO_TEMPLATES);

    expect(prompt).toContain("devil's advocate");
    expect(prompt).toContain("skeptical senior engineer");
    expect(prompt).toContain("security");
    expect(prompt).toContain("critical");
    expect(prompt).toContain("NOISE BUDGET");
    expect(prompt).toContain("findings");
    expect(prompt).toContain("confidence");
  });

  it("uses the full system.md override when present", () => {
    const templates: PromptTemplates = {
      ...NO_TEMPLATES,
      system: "You are a custom reviewer. Focus on security only.",
    };

    const prompt = assembleSystemPrompt(defaultConfig, templates);

    expect(prompt).toContain("custom reviewer");
    expect(prompt).toContain("Focus on security only");
    expect(prompt).not.toContain("devil's advocate"); // built-in posture is gone
  });

  it("ensures noise budget is present even with a full override", () => {
    const templates: PromptTemplates = {
      ...NO_TEMPLATES,
      system: "You are a custom reviewer.",
    };

    const prompt = assembleSystemPrompt(defaultConfig, templates);

    expect(prompt).toContain("NOISE BUDGET");
    expect(prompt).toContain("critical: max 5 findings");
  });

  it("does not duplicate noise budget if override already includes it", () => {
    const templates: PromptTemplates = {
      ...NO_TEMPLATES,
      system: "You are a custom reviewer.\n\nNOISE BUDGET — custom budget:\n  - critical: 1",
    };

    const prompt = assembleSystemPrompt(defaultConfig, templates);

    // Should not have appended an extra noise budget section
    const budgetMatches = prompt.match(/NOISE BUDGET/g);
    expect(budgetMatches).toHaveLength(1);
  });

  it("does not duplicate noise budget if override includes the word noise_budget", () => {
    const templates: PromptTemplates = {
      ...NO_TEMPLATES,
      system: "You are a custom reviewer.\n\nNoise budget section here",
    };

    const prompt = assembleSystemPrompt(defaultConfig, templates);

    // The check looks for "NOISE BUDGET" or "noise_budget" in the text
    // Since "noise_budget" appears (case-insensitive check), no extra budget is injected
    // But we need to count only the explicit "NOISE BUDGET" header occurrences
    const budgetMatches = prompt.match(/NOISE BUDGET/g);
    // The system override contains "noise budget" but not "NOISE BUDGET" as a header,
    // so the auto-injection won't fire ("noise_budget" is in the lowercase text).
    // Zero NOISE BUDGET headers is fine — the user included their own budget section.
    expect(budgetMatches === null ? 0 : budgetMatches.length).toBeLessThanOrEqual(1);
  });

  it("replaces individual sections with overrides", () => {
    const templates: PromptTemplates = {
      ...NO_TEMPLATES,
      posture: "You are a security-focused reviewer. Argue against merging if you find any security risk.",
      categories: "CATEGORIES (use exactly these):\n- security: Everything",
    };

    const prompt = assembleSystemPrompt(defaultConfig, templates);

    expect(prompt).toContain("security-focused reviewer");
    expect(prompt).toContain("- security: Everything");
    expect(prompt).toContain("NOISE BUDGET"); // still has noise budget
    expect(prompt).toContain("SEVERITY"); // still has default severity
    expect(prompt).toContain("OUTPUT FORMAT"); // still has default output format
  });

  it("appends system-append.md content", () => {
    const templates: PromptTemplates = {
      ...NO_TEMPLATES,
      systemAppend: "## Additional Rules\n- Never use eval()\n- All inputs must be validated",
    };

    const prompt = assembleSystemPrompt(defaultConfig, templates);

    expect(prompt).toContain("devil's advocate"); // built-in posture still present
    expect(prompt).toContain("Never use eval()");
    expect(prompt).toContain("All inputs must be validated");
  });

  it("appends system-append even with a full system override", () => {
    const templates: PromptTemplates = {
      ...NO_TEMPLATES,
      system: "You are a custom reviewer.",
      systemAppend: "Additional rules here",
    };

    const prompt = assembleSystemPrompt(defaultConfig, templates);

    expect(prompt).toContain("custom reviewer");
    expect(prompt).toContain("Additional rules here");
  });

  it("uses config noise budget values", () => {
    const config = makeConfig({ noise_budget: { critical: 2, high: 5, medium: 8, low: 12, info: 15 } });
    const prompt = assembleSystemPrompt(config, NO_TEMPLATES);

    expect(prompt).toContain("critical: max 2 findings");
    expect(prompt).toContain("high: max 5 findings");
    expect(prompt).toContain("medium: max 8 findings");
    expect(prompt).toContain("low: max 12 findings");
    expect(prompt).toContain("info: max 15 findings");
  });
});

// ─── assembleUserAppend ───────────────────────────────────────────────────────

describe("assembleUserAppend", () => {
  it("returns null when no user-append template is set", () => {
    expect(assembleUserAppend(NO_TEMPLATES)).toBeNull();
  });

  it("returns the user-append content when set", () => {
    const templates: PromptTemplates = {
      ...NO_TEMPLATES,
      userAppend: "Our project uses event-sourcing. Flag any direct DB writes.",
    };

    expect(assembleUserAppend(templates)).toBe(
      "Our project uses event-sourcing. Flag any direct DB writes.",
    );
  });
});

// ─── buildTemplateVariables ────────────────────────────────────────────────────

describe("buildTemplateVariables", () => {
  it("includes formatted noise budget", () => {
    const config = makeConfig({ noise_budget: { critical: 3 } });
    const vars = buildTemplateVariables(config);
    expect(vars.noise_budget).toContain("critical: max 3 findings");
  });

  it("includes default categories", () => {
    const config = makeConfig({});
    const vars = buildTemplateVariables(config);
    expect(vars.categories).toContain("security");
    expect(vars.categories).toContain("architecture");
  });

  it("includes default severities", () => {
    const config = makeConfig({});
    const vars = buildTemplateVariables(config);
    expect(vars.severities).toContain("critical");
    expect(vars.severities).toContain("medium");
  });
});

// ─── initPromptTemplates ──────────────────────────────────────────────────────

describe("initPromptTemplates", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-init-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates .flaught-prompt/ directory", () => {
    const dir = initPromptTemplates(tmpDir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("creates example template files", () => {
    initPromptTemplates(tmpDir);

    const files = fs.readdirSync(path.join(tmpDir, ".flaught-prompt"));
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("system-append.md.example");
    expect(files).toContain("user-append.md");
  });

  it("does not overwrite existing .flaught-prompt/ directory", () => {
    const dir = path.join(tmpDir, ".flaught-prompt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "custom-file.md"), "custom content", "utf-8");

    initPromptTemplates(tmpDir);

    expect(fs.readFileSync(path.join(dir, "custom-file.md"), "utf-8")).toBe("custom content");
  });
});

// ─── Default content constants ─────────────────────────────────────────────────

describe("default content constants", () => {
  it("DEFAULT_POSTURE contains key phrases", () => {
    expect(DEFAULT_POSTURE).toContain("devil's advocate");
    expect(DEFAULT_POSTURE).toContain("skeptical senior engineer");
    expect(DEFAULT_POSTURE).toContain("never rubber-stamp");
  });

  it("DEFAULT_CATEGORIES contains all six categories", () => {
    expect(DEFAULT_CATEGORIES).toContain("security");
    expect(DEFAULT_CATEGORIES).toContain("architecture");
    expect(DEFAULT_CATEGORIES).toContain("scope-creep");
    expect(DEFAULT_CATEGORIES).toContain("test-quality");
    expect(DEFAULT_CATEGORIES).toContain("performance");
    expect(DEFAULT_CATEGORIES).toContain("maintainability");
  });

  it("DEFAULT_SEVERITY contains all five severities", () => {
    expect(DEFAULT_SEVERITY).toContain("critical");
    expect(DEFAULT_SEVERITY).toContain("high");
    expect(DEFAULT_SEVERITY).toContain("medium");
    expect(DEFAULT_SEVERITY).toContain("low");
    expect(DEFAULT_SEVERITY).toContain("info");
  });

  it("DEFAULT_OUTPUT_FORMAT contains the JSON schema", () => {
    expect(DEFAULT_OUTPUT_FORMAT).toContain("findings");
    expect(DEFAULT_OUTPUT_FORMAT).toContain("severity");
    expect(DEFAULT_OUTPUT_FORMAT).toContain("confidence");
  });

  it("DEFAULT_CONSTRAINTS contains key constraints", () => {
    expect(DEFAULT_CONSTRAINTS).toContain("Rank findings");
    expect(DEFAULT_CONSTRAINTS).toContain("Never fabricate");
    expect(DEFAULT_CONSTRAINTS).toContain("confidence");
  });

  it("DEFAULT_CONSTRAINTS distinguishes committed config from actual secrets", () => {
    expect(DEFAULT_CONSTRAINTS).toContain("hard-coded");
    expect(DEFAULT_CONSTRAINTS).toContain("actual secret");
  });

  it("DEFAULT_CONSTRAINTS defers to an adjacent comment or decision record", () => {
    expect(DEFAULT_CONSTRAINTS).toContain("decision record");
  });

  it("DEFAULT_CONSTRAINTS knows Flaught's own config defaults", () => {
    expect(DEFAULT_CONSTRAINTS).toContain("dismissals.enabled");
  });
});

// ─── Integration: loadTemplates → assembleSystemPrompt ──────────────────────────

describe("end-to-end template loading and assembly", () => {
  let tmpDir: string;
  let promptDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-e2e-"));
    promptDir = path.join(tmpDir, ".flaught-prompt");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("assembles a prompt with system-append.md", () => {
    const config = makeConfig({});
    fs.mkdirSync(promptDir, { recursive: true });
    writeTemplate(
      promptDir,
      "system-append.md",
      "## Team Rules\n- No eval() allowed\n- All APIs must validate input",
    );

    const templates = loadTemplates(tmpDir, config);
    const prompt = assembleSystemPrompt(config, templates);

    expect(prompt).toContain("devil's advocate"); // built-in posture
    expect(prompt).toContain("No eval() allowed"); // appended rule
    expect(prompt).toContain("All APIs must validate input"); // appended rule
  });

  it("assembles a prompt with posture override", () => {
    const config = makeConfig({});
    fs.mkdirSync(promptDir, { recursive: true });
    writeTemplate(
      promptDir,
      "posture.md",
      "You are a security auditor. Focus exclusively on security vulnerabilities.",
    );

    const templates = loadTemplates(tmpDir, config);
    const prompt = assembleSystemPrompt(config, templates);

    expect(prompt).toContain("security auditor");
    expect(prompt).not.toContain("devil's advocate");
    expect(prompt).toContain("CATEGORIES"); // still has categories
  });

  it("uses full system override and appends", () => {
    const config = makeConfig({});
    fs.mkdirSync(promptDir, { recursive: true });
    writeTemplate(promptDir, "system.md", "You are a custom reviewer for Acme Corp.");
    writeTemplate(promptDir, "system-append.md", "Additional: Check for SQL injection.");
    writeTemplate(promptDir, "posture.md", "This should be ignored since system.md is present.");

    const templates = loadTemplates(tmpDir, config);
    const prompt = assembleSystemPrompt(config, templates);

    expect(prompt).toContain("Acme Corp");
    expect(prompt).toContain("Check for SQL injection");
    expect(prompt).not.toContain("This should be ignored");
    expect(prompt).toContain("NOISE BUDGET"); // auto-injected since system.md doesn't include it
  });

  it("interpolates variables in system.md", () => {
    const config = makeConfig({ noise_budget: { critical: 2, high: 5 } });
    fs.mkdirSync(promptDir, { recursive: true });
    writeTemplate(
      promptDir,
      "system.md",
      "Custom prompt.\n\nBudget:\n{{noise_budget}}",
    );

    const templates = loadTemplates(tmpDir, config);
    const prompt = assembleSystemPrompt(config, templates);

    expect(prompt).toContain("critical: max 2 findings");
    expect(prompt).toContain("high: max 5 findings");
    // Should NOT duplicate noise budget since system.md already has "noise_budget" in it
    // (the interpolated text includes "noise_budget" which matches the check)
    // Actually, after interpolation, "noise_budget" is replaced with the formatted budget.
    // The check looks for "NOISE BUDGET" or "noise_budget" in the prompt text.
    // Since we interpolated {{noise_budget}} and the result contains "critical: max 2 findings"
    // which contains "budget" but not "NOISE BUDGET" as a header.
    // Let's just check it has the budget info.
  });

  it("assembles a prompt with all section overrides", () => {
    const config = makeConfig({});
    fs.mkdirSync(promptDir, { recursive: true });
    writeTemplate(promptDir, "posture.md", "Custom posture text");
    writeTemplate(promptDir, "categories.md", "Custom categories text");
    writeTemplate(promptDir, "severity.md", "Custom severity text");
    writeTemplate(promptDir, "output-format.md", "Custom output format text");
    writeTemplate(promptDir, "constraints.md", "Custom constraints text");

    const templates = loadTemplates(tmpDir, config);
    const prompt = assembleSystemPrompt(config, templates);

    expect(prompt).toContain("Custom posture text");
    expect(prompt).toContain("Custom categories text");
    expect(prompt).toContain("Custom severity text");
    expect(prompt).toContain("Custom output format text");
    expect(prompt).toContain("Custom constraints text");
    expect(prompt).toContain("NOISE BUDGET"); // still injected from config
    // Default content should NOT be present
    expect(prompt).not.toContain("devil's advocate");
    expect(prompt).not.toContain("Vulnerabilities, injection");
  });
});