import { describe, it, expect } from "vitest";
import { FlaughtConfigSchema, mergeWithDefaults } from "./config.js";

describe("FlaughtConfigSchema", () => {
  it("applies full defaults to empty config", () => {
    const config = FlaughtConfigSchema.parse({});

    expect(config.version).toBe(1);
    expect(config.stack.languages).toBe("auto");
    expect(config.stack.frameworks).toEqual([]);
    expect(config.stack.runtime).toBe("auto");
    expect(config.llm.provider).toBe("groq");
    expect(config.llm.model).toBe("groq/compound-mini");
    expect(config.llm.api_key_env).toBe("GROQ_API_KEY");
    expect(config.llm.temperature).toBe(0.2);
    expect(config.llm.max_tokens).toBe(4096);
    expect(config.tools.semgrep.enabled).toBe(true);
    expect(config.tools.linter.enabled).toBe(true);
    expect(config.tools.vuln_scanner.enabled).toBe(true);
    expect(config.test_inversion.enabled).toBe(true);
    expect(config.scope_creep.enabled).toBe(true);
    expect(config.scope_creep.intent_source).toBe("pr_description");
    expect(config.lighthouse.enabled).toBe(false);
    expect(config.noise_budget.critical).toBe(5);
    expect(config.noise_budget.high).toBe(10);
    expect(config.noise_budget.medium).toBe(15);
    expect(config.noise_budget.low).toBe(20);
    expect(config.noise_budget.info).toBe(25);
    expect(config.severity_gate.fail_on).toBe("high");
    expect(config.dismissals.enabled).toBe(true);
    expect(config.dismissals.path).toBe(".flaught-dismissals.json");
    expect(config.exclude.paths).toContain("node_modules/**");
    expect(config.exclude.patterns).toEqual([]);
  });

  it("validates a complete config", () => {
    const raw = {
      version: 1,
      stack: {
        languages: ["python", "typescript"],
        frameworks: ["fastapi", "react"],
        runtime: "mixed",
      },
      llm: {
        provider: "groq",
        model: "llama-3.1-70b",
        api_key_env: "GROQ_API_KEY",
        temperature: 0.3,
        max_tokens: 8192,
      },
      tools: {
        semgrep: { enabled: false },
        linter: { enabled: true, command: "ruff check" },
        vuln_scanner: { enabled: true, command: "pip-audit" },
      },
      test_inversion: {
        enabled: true,
        command: "pytest -x",
      },
      scope_creep: {
        enabled: true,
        intent_source: "both",
      },
      lighthouse: {
        enabled: true,
        preview_url: "https://deploy-preview.example.com",
      },
      noise_budget: {
        critical: 3,
        high: 8,
        medium: 12,
        low: 15,
        info: 20,
      },
      severity_gate: {
        fail_on: "critical",
      },
      exclude: {
        paths: ["src/generated/**", "**/*.pb.ts"],
        patterns: ["\\.spec\\.ts$"],
      },
    };

    const config = FlaughtConfigSchema.parse(raw);

    expect(config.stack.languages).toEqual(["python", "typescript"]);
    expect(config.llm.provider).toBe("groq");
    expect(config.llm.model).toBe("llama-3.1-70b");
    expect(config.tools.semgrep.enabled).toBe(false);
    expect(config.tools.linter.command).toBe("ruff check");
    expect(config.lighthouse.preview_url).toBe("https://deploy-preview.example.com");
    expect(config.severity_gate.fail_on).toBe("critical");
    expect(config.exclude.patterns).toEqual(["\\.spec\\.ts$"]);
  });

  it("rejects invalid provider", () => {
    expect(() =>
      FlaughtConfigSchema.parse({ llm: { provider: "invalid" } })
    ).toThrow();
  });

  it("accepts anthropic as a provider", () => {
    const config = FlaughtConfigSchema.parse({
      llm: { provider: "anthropic", model: "claude-sonnet-5", api_key_env: "ANTHROPIC_API_KEY" },
    });
    expect(config.llm.provider).toBe("anthropic");
    expect(config.llm.model).toBe("claude-sonnet-5");
  });

  it("rejects temperature outside 0-1", () => {
    expect(() =>
      FlaughtConfigSchema.parse({ llm: { temperature: 1.5 } })
    ).toThrow();
    expect(() =>
      FlaughtConfigSchema.parse({ llm: { temperature: -0.1 } })
    ).toThrow();
  });

  it("rejects invalid severity gate values", () => {
    expect(() =>
      FlaughtConfigSchema.parse({ severity_gate: { fail_on: "low" } })
    ).toThrow();
  });

  it("mergeWithDefaults preserves explicit values and fills defaults", () => {
    const merged = mergeWithDefaults({
      llm: { provider: "ollama", model: "codellama" },
      test_inversion: { enabled: false },
    });

    expect(merged.llm.provider).toBe("ollama");
    expect(merged.llm.model).toBe("codellama");
    expect(merged.llm.temperature).toBe(0.2); // default
    expect(merged.test_inversion.enabled).toBe(false);
    expect(merged.scope_creep.enabled).toBe(true); // default
  });
});