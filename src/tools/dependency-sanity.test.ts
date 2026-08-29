import { describe, it, expect, vi } from "vitest";
import {
  extractAddedDependencies,
  levenshteinDistance,
  findTyposquatMatch,
  isRegistrySpecifier,
  runDependencySanityCheck,
  type FetchLike,
} from "./dependency-sanity.js";
import { FlaughtConfigSchema } from "../schemas/config.js";
import { runDeterministicTools } from "./runner.js";

function pkgJsonHunk(body: string, startLine = 10, file = "package.json"): string {
  const lines = body.replace(/^\n/, "").replace(/\n$/, "").split("\n");
  return [
    `diff --git a/${file} b/${file}`,
    `index 1111111..2222222 100644`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${startLine},${Math.max(lines.length - 1, 1)} +${startLine},${lines.length} @@`,
    ...lines,
  ].join("\n");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (url: string) => Response | Promise<Response>): FetchLike {
  return vi.fn(async (input: string | URL | Request) => handler(String(input))) as FetchLike;
}

const NOW = new Date("2026-08-28T00:00:00.000Z");

describe("extractAddedDependencies", () => {
  it("extracts a newly added production dependency", () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
     "react": "^18.0.0",
+    "lodash": "^4.17.21"
   }
`);
    const added = extractAddedDependencies(diff);
    expect(added).toEqual([
      expect.objectContaining({ name: "lodash", version: "^4.17.21", file: "package.json" }),
    ]);
  });

  it("extracts devDependencies, peerDependencies, and optionalDependencies", () => {
    const diff = [
      pkgJsonHunk(`
   "devDependencies": {
+    "vitest": "^3.0.0"
   }
`),
      pkgJsonHunk(`
   "peerDependencies": {
+    "react": "^18.0.0"
   }
`, 10, "packages/ui/package.json"),
      pkgJsonHunk(`
   "optionalDependencies": {
+    "fsevents": "^2.3.0"
   }
`, 10, "packages/cli/package.json"),
    ].join("\n");
    const names = extractAddedDependencies(diff).map((d) => d.name).sort();
    expect(names).toEqual(["fsevents", "react", "vitest"]);
  });

  it("supports scoped npm packages", () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
+    "@scope/pkg": "^1.0.0"
   }
`);
    expect(extractAddedDependencies(diff).map((d) => d.name)).toEqual(["@scope/pkg"]);
  });

  it("handles multiple added dependencies", () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
+    "axios": "^1.0.0",
+    "zod": "^3.0.0"
   }
`);
    expect(extractAddedDependencies(diff).map((d) => d.name).sort()).toEqual(["axios", "zod"]);
  });

  it("ignores version-only changes", () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
-    "react": "^18.0.0",
+    "react": "^19.0.0"
   }
`);
    expect(extractAddedDependencies(diff)).toEqual([]);
  });

  it("ignores additions under scripts or unrelated JSON objects", () => {
    const diff = pkgJsonHunk(`
   "scripts": {
+    "lint": "eslint ."
   },
   "name": "app",
+  "version": "1.0.1"
`);
    expect(extractAddedDependencies(diff)).toEqual([]);
  });

  it("ignores changes to non-package.json files", () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
+    "lodash": "^4.17.21"
   }
`, 10, "src/config.json");
    expect(extractAddedDependencies(diff)).toEqual([]);
  });
});

describe("isRegistrySpecifier", () => {
  it("accepts semver ranges and rejects local/git specs", () => {
    expect(isRegistrySpecifier("^1.0.0")).toBe(true);
    expect(isRegistrySpecifier("workspace:*")).toBe(false);
    expect(isRegistrySpecifier("file:../pkg")).toBe(false);
    expect(isRegistrySpecifier("git+https://github.com/a/b.git")).toBe(false);
  });
});

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings and 1 for a single insertion", () => {
    expect(levenshteinDistance("react", "react")).toBe(0);
    expect(levenshteinDistance("react", "reactt")).toBe(1);
    expect(levenshteinDistance("express", "expresss")).toBe(1);
  });
});

describe("findTyposquatMatch", () => {
  it("detects reactt as similar to react", () => {
    expect(findTyposquatMatch("reactt")).toBe("react");
  });

  it("does not flag exact popular-package names", () => {
    expect(findTyposquatMatch("react")).toBeNull();
    expect(findTyposquatMatch("express")).toBeNull();
    expect(findTyposquatMatch("vuex")).toBeNull();
  });
});

describe("runDependencySanityCheck", () => {
  it("emits high severity for a 404", async () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
+    "unknown-package-xyz": "^1.0.0"
   }
`);
    const fetchFn = mockFetch((url) => {
      if (url.includes("registry.npmjs.org") && url.includes("unknown-package-xyz")) {
        return new Response("Not found", { status: 404 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({ diff, fetch: fetchFn, now: NOW });
    expect(result.fault).toBe(false);
    expect(result.findings.some((f) => f.ruleId === "dependency-nonexistent" && f.severity === "high")).toBe(true);
  });

  it("emits medium severity for a young package", async () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
+    "brand-new-pkg": "^1.0.0"
   }
`);
    const fetchFn = mockFetch((url) => {
      if (url.includes("registry.npmjs.org")) {
        return jsonResponse({ time: { created: "2026-08-23T00:00:00.000Z" } });
      }
      if (url.includes("downloads")) return jsonResponse({ downloads: 1000 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({ diff, fetch: fetchFn, now: NOW });
    const age = result.findings.find((f) => f.ruleId === "dependency-too-new");
    expect(age?.severity).toBe("medium");
  });

  it("emits low severity for low downloads", async () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
+    "quiet-pkg": "^1.0.0"
   }
`);
    const fetchFn = mockFetch((url) => {
      if (url.includes("registry.npmjs.org")) {
        return jsonResponse({ time: { created: "2020-01-01T00:00:00.000Z" } });
      }
      if (url.includes("downloads")) return jsonResponse({ downloads: 2 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({ diff, fetch: fetchFn, now: NOW });
    const dl = result.findings.find((f) => f.ruleId === "dependency-low-downloads");
    expect(dl?.severity).toBe("low");
    expect(dl?.title).toContain("2 weekly downloads");
  });

  it("detects reactt as a typosquat even when the name 404s", async () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
+    "reactt": "^1.0.0"
   }
`);
    const fetchFn = mockFetch((url) => {
      if (url.includes("registry.npmjs.org")) return new Response("Not found", { status: 404 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({ diff, fetch: fetchFn, now: NOW });
    const ids = result.findings.map((f) => f.ruleId).sort();
    expect(ids).toEqual(["dependency-nonexistent", "dependency-typosquat"]);
    expect(result.findings.every((f) => f.severity === "high")).toBe(true);
    expect(result.findings.every((f) => f.source === "dependency_sanity")).toBe(true);
  });

  it("does not flag an exact popular-package name that exists", async () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
+    "react": "^18.0.0"
   }
`);
    const fetchFn = mockFetch((url) => {
      if (url.includes("registry.npmjs.org")) {
        return jsonResponse({ time: { created: "2011-10-26T00:00:00.000Z" } });
      }
      if (url.includes("downloads")) return jsonResponse({ downloads: 20_000_000 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({ diff, fetch: fetchFn, now: NOW });
    expect(result.findings).toEqual([]);
  });

  it("continues when one package request fails", async () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
+    "ok-pkg": "^1.0.0",
+    "flaky-pkg": "^1.0.0"
   }
`);
    const fetchFn = mockFetch((url) => {
      if (url.includes("flaky-pkg") && url.includes("registry.npmjs.org")) {
        throw new Error("ECONNRESET");
      }
      if (url.includes("registry.npmjs.org")) {
        return new Response("Not found", { status: 404 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({ diff, fetch: fetchFn, now: NOW });
    expect(result.fault).toBe(false);
    expect(result.warnings.some((w) => w.includes("flaky-pkg"))).toBe(true);
    expect(result.findings.some((f) => f.snippet === "ok-pkg" && f.ruleId === "dependency-nonexistent")).toBe(true);
  });

  it("treats a registry outage as a tool fault", async () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
+    "unknown-package-xyz": "^1.0.0"
   }
`);
    const fetchFn = mockFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    });
    const result = await runDependencySanityCheck({ diff, fetch: fetchFn, now: NOW });
    expect(result.fault).toBe(true);
    expect(result.findings.filter((f) => f.ruleId === "dependency-nonexistent")).toEqual([]);
  });

  it("skips registry lookups for workspace specifiers", async () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
+    "@acme/pkg": "workspace:*"
   }
`);
    const fetchFn = mockFetch((url) => {
      throw new Error(`should not fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({ diff, fetch: fetchFn, now: NOW });
    expect(result.fault).toBe(false);
    expect(result.findings).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("URL-encodes scoped package names", async () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
+    "@scope/missing": "^1.0.0"
   }
`);
    const fetchFn = mockFetch((url) => {
      expect(url).toContain(encodeURIComponent("@scope/missing"));
      return new Response("Not found", { status: 404 });
    });
    const result = await runDependencySanityCheck({ diff, fetch: fetchFn, now: NOW });
    expect(result.findings.some((f) => f.ruleId === "dependency-nonexistent")).toBe(true);
  });

  it("skips only the download check when that request fails", async () => {
    const diff = pkgJsonHunk(`
   "dependencies": {
+    "quiet-pkg": "^1.0.0"
   }
`);
    const fetchFn = mockFetch((url) => {
      if (url.includes("registry.npmjs.org")) {
        return jsonResponse({ time: { created: "2020-01-01T00:00:00.000Z" } });
      }
      if (url.includes("downloads")) throw new Error("downloads API down");
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({ diff, fetch: fetchFn, now: NOW });
    expect(result.fault).toBe(false);
    expect(result.findings.some((f) => f.ruleId === "dependency-low-downloads")).toBe(false);
    expect(result.warnings.some((w) => w.includes("Downloads check failed"))).toBe(true);
  });
});

describe("runDeterministicTools wiring", () => {
  it("records a dependency_sanity execution when enabled", async () => {
    const config = FlaughtConfigSchema.parse({
      tools: {
        semgrep: { enabled: false },
        linter: { enabled: false },
        vuln_scanner: { enabled: false },
      },
    });
    const result = await runDeterministicTools(config, process.cwd(), undefined, "");
    expect(result.executions).toEqual([
      expect.objectContaining({
        tool: "dependency_sanity",
        version: "builtin",
        exit_code: 0,
        raw_findings_count: 0,
        command: "npm-registry",
      }),
    ]);
    expect(result.findings).toEqual([]);
  });
});
