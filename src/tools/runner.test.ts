import { describe, it, expect } from "vitest";
import { parseVulnJsonOutput } from "./runner.js";

describe("npm audit parser enrichment", () => {
  it("extracts advisory title, fix info, and dependency path from npm audit JSON", () => {
    const npmAuditJson = JSON.stringify({
      vulnerabilities: {
        vite: {
          name: "vite",
          severity: "high",
          isDirect: false,
          via: [
            {
              source: 1123525,
              name: "vite",
              dependency: "vite",
              title: "vite: `server.fs.deny` bypass on Windows alternate paths",
              url: "https://github.com/advisories/GHSA-fx2h-pf6j-xcff",
              severity: "high",
              cwe: ["CWE-22", "CWE-200"],
              cvss: { score: 7.5, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N" },
              range: "<=6.4.2",
            },
            "esbuild",
          ],
          effects: ["@vitest/mocker", "vite-node", "vitest"],
          range: "<=6.4.2",
          nodes: ["node_modules/vite"],
          fixAvailable: { name: "vitest", version: "4.1.11", isSemVerMajor: true },
        },
      },
    });

    const findings = parseVulnJsonOutput(npmAuditJson, "npm audit --json");

    expect(findings).toHaveLength(1);
    const f = findings[0]!;

    // Title should be "package: advisory title", not just the package name
    expect(f.title).toBe("vite: vite: `server.fs.deny` bypass on Windows alternate paths");

    // Severity mapped from npm audit format
    expect(f.severity).toBe("high");

    // Category
    expect(f.category).toBe("security");

    // Source
    expect(f.source).toBe("npm_audit");

    // Should pick up advisory URL as reference
    expect(f.reference).toBe("https://github.com/advisories/GHSA-fx2h-pf6j-xcff");

    // Vulnerability-specific enrichment fields
    expect(f.vuln_range).toBe("<=6.4.2");
    expect(f.vuln_is_direct).toBe(false);
    expect(f.vuln_effects).toEqual(["@vitest/mocker", "vite-node", "vitest"]);
    expect(f.vuln_fix).toBe("vitest@4.1.11");
    expect(f.vuln_fix_is_breaking).toBe(true);
    expect(f.vuln_cwe).toEqual(["CWE-22", "CWE-200"]);
    expect(f.vuln_cvss_score).toBe(7.5);
    expect(f.vuln_urls).toEqual(["https://github.com/advisories/GHSA-fx2h-pf6j-xcff"]);

    // Description (vuln_description) should include dependency path and fix info
    expect(f.vuln_description).toContain("Transitive dependency");
    expect(f.vuln_description).toContain("@vitest/mocker");
    expect(f.vuln_description).toContain("Fix available");
    expect(f.vuln_description).toContain("vitest to 4.1.11");
    expect(f.vuln_description).toContain("breaking change");

    // Snippet (evidence block) should be concise technical summary
    expect(f.snippet).toContain("Affected: vite <=6.4.2");
    expect(f.snippet).toContain("Fix: vitest@4.1.11 (breaking)");
  });

  it("handles a direct dependency vulnerability with single advisory", () => {
    const npmAuditJson = JSON.stringify({
      vulnerabilities: {
        "js-yaml": {
          name: "js-yaml",
          severity: "high",
          isDirect: true,
          via: [
            {
              source: 12345,
              name: "js-yaml",
              dependency: "js-yaml",
              title: "Prototype Pollution in js-yaml",
              url: "https://github.com/advisories/GHSA-xxxx-xxxx-xxxx",
              severity: "high",
              cwe: ["CWE-400"],
              cvss: { score: 9.8, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/S:U/C:H/I:H/A:H" },
              range: "<4.1.0",
            },
          ],
          effects: [],
          range: "<4.1.0",
          nodes: ["node_modules/js-yaml"],
          fixAvailable: { name: "js-yaml", version: "4.1.0", isSemVerMajor: false },
        },
      },
    });

    const findings = parseVulnJsonOutput(npmAuditJson, "npm audit --json");

    expect(findings).toHaveLength(1);
    const f = findings[0]!;

    expect(f.title).toBe("js-yaml: Prototype Pollution in js-yaml");
    expect(f.vuln_is_direct).toBe(true);
    expect(f.vuln_effects).toBeUndefined(); // empty array → undefined
    expect(f.vuln_fix).toBe("js-yaml@4.1.0");
    expect(f.vuln_fix_is_breaking).toBe(false);
    expect(f.vuln_cwe).toEqual(["CWE-400"]);
    expect(f.vuln_cvss_score).toBe(9.8);

    // Description should say "Direct dependency" not "Transitive"
    expect(f.snippet).toContain("Direct dependency");
    expect(f.snippet).not.toContain("Transitive");
  });

  it("handles vulnerability with no advisory objects (string-only via array)", () => {
    const npmAuditJson = JSON.stringify({
      vulnerabilities: {
        esbuild: {
          name: "esbuild",
          severity: "moderate",
          isDirect: false,
          via: ["vite"],
          effects: ["vite"],
          range: "<=0.24.2",
          nodes: ["node_modules/esbuild"],
          fixAvailable: { name: "vitest", version: "4.1.11", isSemVerMajor: true },
        },
      },
    });

    const findings = parseVulnJsonOutput(npmAuditJson, "npm audit --json");

    expect(findings).toHaveLength(1);
    const f = findings[0]!;

    // Title falls back to package name with range
    expect(f.title).toBe("esbuild: Vulnerability in esbuild (<=0.24.2)");
    expect(f.vuln_urls).toBeUndefined();
    expect(f.vuln_cwe).toBeUndefined();
    expect(f.vuln_cvss_score).toBeUndefined();
  });

  it("handles vulnerability with no fix available", () => {
    const npmAuditJson = JSON.stringify({
      vulnerabilities: {
        "some-pkg": {
          name: "some-pkg",
          severity: "critical",
          isDirect: true,
          via: [
            {
              source: 999,
              name: "some-pkg",
              dependency: "some-pkg",
              title: "Remote Code Execution in some-pkg",
              url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
              severity: "critical",
              cwe: ["CWE-78"],
              cvss: { score: 10.0, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" },
              range: "*",
            },
          ],
          effects: [],
          range: "*",
          nodes: ["node_modules/some-pkg"],
          fixAvailable: false,
        },
      },
    });

    const findings = parseVulnJsonOutput(npmAuditJson, "npm audit --json");

    expect(findings).toHaveLength(1);
    const f = findings[0]!;

    expect(f.title).toBe("some-pkg: Remote Code Execution in some-pkg");
    expect(f.vuln_fix).toBeUndefined();
    expect(f.vuln_fix_is_breaking).toBeUndefined();
    expect(f.snippet).toContain("No fix available");
  });

  it("handles empty vulnerabilities gracefully", () => {
    const npmAuditJson = JSON.stringify({
      vulnerabilities: {},
    });

    const findings = parseVulnJsonOutput(npmAuditJson, "npm audit --json");
    expect(findings).toHaveLength(0);
  });

  it("handles malformed JSON gracefully", () => {
    const findings = parseVulnJsonOutput("not json", "npm audit --json");
    expect(findings).toHaveLength(0);
  });

  it("handles pip-audit format", () => {
    const pipAuditJson = JSON.stringify({
      dependencies: [
        {
          name: "flask",
          version: "2.0.1",
          vulns: [
            {
              id: "PYSEC-2023-123",
              cve: "CVE-2023-1234",
              severity: "HIGH",
              description: "Open redirect in Flask",
              fix_versions: ["2.0.3"],
              urls: ["https://github.com/advisories/GHSA-xxx"],
            },
          ],
        },
      ],
    });

    const findings = parseVulnJsonOutput(pipAuditJson, "pip-audit --format json");

    expect(findings).toHaveLength(1);
    const f = findings[0]!;

    expect(f.title).toBe("flask: Open redirect in Flask");
    expect(f.severity).toBe("high");
    expect(f.source).toBe("pip_audit");
    expect(f.vuln_description).toBe("Open redirect in Flask");
    expect(f.vuln_installed_version).toBe("2.0.1");
    expect(f.vuln_fix).toBe("flask@2.0.3");
    expect(f.vuln_urls).toEqual(["https://github.com/advisories/GHSA-xxx"]);
  });
});