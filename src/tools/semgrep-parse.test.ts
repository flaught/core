import { describe, it, expect } from "vitest";
import { parseSemgrepOutput, isGatedEnrichment } from "./runner.js";

// The "requires login" reframe (verified against src/tools/runner.ts): semgrep
// CE gates the `extra.lines` enrichment field behind an account and returns
// the literal "requires login" as its value. The finding is usually REAL
// (valid rule id, location, message); only the code-snippet field is gated.
// Our parser must prefer the CE-available `extra.message` over the gated
// sentinel, never rendering "requires login" as if it were code. Separately,
// a non-JSON stdout is a tool FAULT (silent zero is not a clean scan), not a
// 0-finding result.

describe("isGatedEnrichment", () => {
  it("flags the 'requires login' sentinel", () => {
    expect(isGatedEnrichment("requires login")).toBe(true);
    expect(isGatedEnrichment("Requires Login")).toBe(true);
    expect(isGatedEnrichment("  requires login  ")).toBe(true);
    expect(isGatedEnrichment("requires authentication")).toBe(true);
    expect(isGatedEnrichment("requires login (sign in at semgrep.dev)")).toBe(true);
  });

  it("does not flag real code or messages", () => {
    expect(isGatedEnrichment("requests.get(url, verify=False)")).toBe(false);
    expect(isGatedEnrichment("TLS verification disabled")).toBe(false);
    expect(isGatedEnrichment("")).toBe(false);
    expect(isGatedEnrichment(undefined)).toBe(false);
    expect(isGatedEnrichment(null)).toBe(false);
  });
});

describe("parseSemgrepOutput", () => {
  it("prefers extra.message over a gated extra.lines sentinel (the bug fix)", () => {
    const stdout = JSON.stringify({
      results: [
        {
          check_id: "package_managers.dependabot.dependabot-missing-cooldown",
          path: ".github/dependabot.yml",
          start: { line: 13 },
          extra: {
            severity: "INFO",
            message: "Dependabot config is missing a cooldown setting",
            lines: "requires login",
            metadata: { references: ["https://docs.github.com/en/dependabot"] },
          },
        },
      ],
    });

    const { findings, parseError } = parseSemgrepOutput(stdout);

    expect(parseError).toBeNull();
    expect(findings).toHaveLength(1);
    // The snippet is the REAL rule message, never the gated "requires login" sentinel.
    expect(findings[0]!.snippet).toBe("Dependabot config is missing a cooldown setting");
    expect(findings[0]!.snippet).not.toContain("requires login");
    // The finding itself is preserved — it was a real match, only the snippet field was gated.
    expect(findings[0]!.ruleId).toBe("package_managers.dependabot.dependabot-missing-cooldown");
    expect(findings[0]!.file).toBe(".github/dependabot.yml");
    expect(findings[0]!.line).toBe(13);
    expect(findings[0]!.reference).toBe("https://docs.github.com/en/dependabot");
  });

  it("uses the real code snippet (extra.lines) when it is NOT gated", () => {
    const stdout = JSON.stringify({
      results: [
        {
          check_id: "python.tls-verification-disabled",
          path: "app/client.py",
          start: { line: 12 },
          extra: {
            severity: "WARNING",
            message: "TLS certificate verification is disabled.",
            lines: "requests.get(url, verify=False)",
          },
        },
      ],
    });

    const { findings, parseError } = parseSemgrepOutput(stdout);

    expect(parseError).toBeNull();
    expect(findings[0]!.snippet).toBe("requests.get(url, verify=False)");
  });

  it("falls back to extra.message when extra.lines is absent", () => {
    const stdout = JSON.stringify({
      results: [
        {
          check_id: "x",
          path: "a.ts",
          start: { line: 4 },
          extra: { severity: "ERROR", message: "something wrong" },
        },
      ],
    });

    const { findings, parseError } = parseSemgrepOutput(stdout);
    expect(parseError).toBeNull();
    expect(findings[0]!.snippet).toBe("something wrong");
  });

  it("returns a parseError (NOT a silent 0-finding result) when stdout is not valid JSON", () => {
    // e.g. account/login noise polluting stdout before the JSON.
    const stdout = "Semgrep requires login to use this rule.\n{not valid json";

    const { findings, parseError } = parseSemgrepOutput(stdout);

    expect(findings).toEqual([]);
    expect(parseError).not.toBeNull();
    expect(parseError).toContain("not valid JSON");
    expect(parseError).toContain("not a clean 0-finding result");
  });

  it("a genuinely clean scan (valid JSON, zero results) is a clean 0-finding result, NOT a fault", () => {
    const stdout = JSON.stringify({ results: [] });

    const { findings, parseError } = parseSemgrepOutput(stdout);
    expect(findings).toEqual([]);
    expect(parseError).toBeNull();
  });

  it("maps severity via the existing vocabulary", () => {
    const stdout = JSON.stringify({
      results: [
        { check_id: "a", path: "f", start: { line: 1 }, extra: { severity: "ERROR", message: "e" } },
        { check_id: "b", path: "f", start: { line: 1 }, extra: { severity: "WARNING", message: "w" } },
        { check_id: "c", path: "f", start: { line: 1 }, extra: { severity: "INFO", message: "i" } },
        { check_id: "d", path: "f", start: { line: 1 }, extra: { severity: "WEIRD", message: "x" } },
        { check_id: "e", path: "f", start: { line: 1 }, extra: { message: "no severity" } },
      ],
    });

    const { findings } = parseSemgrepOutput(stdout);
    expect(findings.map((f) => f.severity)).toEqual(["critical", "high", "info", "medium", "medium"]);
  });
});
import { runSemgrep } from "./runner.js";
import { FlaughtConfigSchema } from "../schemas/config.js";

// F-0001 from PR #82's own review: the runSemgrep parseError -> success:false
// wiring (the no-silent-zero fix) must be exercised end-to-end, not just the
// pure parser. runSemgrep takes an injectable exec so we can feed a non-JSON
// stdout without spawning real semgrep.
describe("runSemgrep no-silent-zero wiring (F-0001)", () => {
  const config = FlaughtConfigSchema.parse({});

  it("surfaces a non-JSON stdout as a tool fault (success:false, 0 findings), not a clean 0-finding scan", async () => {
    const fakeExec = async () => ({
      success: true,
      exitCode: 0,
      stdout: "Semgrep requires login to use this rule.\n{not valid json",
      stderr: "",
    });
    const result = await runSemgrep(config, process.cwd(), fakeExec);

    expect(result.success).toBe(false); // fault, not clean
    expect(result.findings).toEqual([]); // 0 findings, but NOT reported as clean
    expect(result.stderr).toContain("not valid JSON");
  });

  it("returns success:true with findings for valid JSON output", async () => {
    const fakeExec = async () => ({
      success: true,
      exitCode: 0,
      stdout: JSON.stringify({
        results: [
          {
            check_id: "ts.eval",
            path: "a.ts",
            start: { line: 4 },
            extra: { severity: "WARNING", message: "eval is dangerous", lines: "eval(x)" },
          },
        ],
      }),
      stderr: "",
    });
    const result = await runSemgrep(config, process.cwd(), fakeExec);
    expect(result.success).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.snippet).toBe("eval(x)"); // real lines, not gated
  });

  it("returns success:true with 0 findings for a genuinely clean scan (valid JSON, no results)", async () => {
    const fakeExec = async () => ({ success: true, exitCode: 0, stdout: JSON.stringify({ results: [] }), stderr: "" });
    const result = await runSemgrep(config, process.cwd(), fakeExec);
    expect(result.success).toBe(true);
    expect(result.findings).toEqual([]);
  });
});
