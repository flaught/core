import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import {
  extractAddedDependencies,
  collectAddedDependencies,
  levenshteinDistance,
  findTyposquatMatch,
  isRegistrySpecifier,
  runDependencySanityCheck,
  mapPool,
  REGISTRY_CONCURRENCY,
  type AddedDependency,
  type FetchLike,
} from "./dependency-sanity.js";
import { FlaughtConfigSchema } from "../schemas/config.js";
import { runDeterministicTools } from "./runner.js";

function dep(name: string, version = "^1.0.0", file = "package.json", line = 3): AddedDependency {
  return { name, version, file, line };
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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extractAddedDependencies", () => {
  it("extracts a newly added production dependency", () => {
    const head = { dependencies: { react: "^18.0.0", lodash: "^4.17.21" } };
    const base = { dependencies: { react: "^18.0.0" } };
    const source = '{\n  "dependencies": {\n    "react": "^18.0.0",\n    "lodash": "^4.17.21"\n  }\n}';
    expect(extractAddedDependencies(head, base, "package.json", source)).toEqual([
      expect.objectContaining({ name: "lodash", version: "^4.17.21", file: "package.json", line: 4 }),
    ]);
  });

  it("extracts devDependencies, peerDependencies, and optionalDependencies", () => {
    const head = {
      devDependencies: { vitest: "^3.0.0" },
      peerDependencies: { react: "^18.0.0" },
      optionalDependencies: { fsevents: "^2.3.0" },
    };
    const names = extractAddedDependencies(head, {}, "package.json").map((d) => d.name).sort();
    expect(names).toEqual(["fsevents", "react", "vitest"]);
  });

  it("supports scoped npm packages", () => {
    const head = { dependencies: { "@scope/pkg": "^1.0.0" } };
    expect(extractAddedDependencies(head, {}, "package.json").map((d) => d.name)).toEqual(["@scope/pkg"]);
  });

  it("ignores version-only changes", () => {
    const base = { dependencies: { react: "^18.0.0" } };
    const head = { dependencies: { react: "^19.0.0" } };
    expect(extractAddedDependencies(head, base, "package.json")).toEqual([]);
  });

  it("ignores scripts and unrelated JSON keys", () => {
    const head = { scripts: { lint: "eslint ." }, name: "app", version: "1.0.1" };
    expect(extractAddedDependencies(head, {}, "package.json")).toEqual([]);
  });

  it("still reports a genuine add when the rest of the file was reformatted", () => {
    const base = { dependencies: { react: "^18.0.0", lodash: "^4.0.0" } };
    const head = { dependencies: { axios: "^1.0.0", lodash: "^4.0.0", react: "^18.0.0" } };
    expect(extractAddedDependencies(head, base, "package.json").map((d) => d.name)).toEqual(["axios"]);
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

describe("mapPool", () => {
  it("caps in-flight work at the concurrency limit", async () => {
    let inflight = 0;
    let max = 0;
    await mapPool(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inflight += 1;
      max = Math.max(max, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight -= 1;
    });
    expect(max).toBe(3);
  });
});

describe("collectAddedDependencies", () => {
  it("diffs parsed package.json files across git refs", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-depsan-"));
    tempDirs.push(repoPath);
    const git = simpleGit(repoPath);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@flaught.dev");
    await git.addConfig("user.name", "Flaught Test");
    fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({
      dependencies: { react: "^18.0.0", lodash: "^4.0.0" },
    }, null, 2));
    await git.add(".");
    await git.commit("base", undefined, { "--author": "Flaught Test <test@flaught.dev>" });
    const baseSha = (await git.revparse(["HEAD"])).trim();

    fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({
      dependencies: { axios: "^1.0.0", lodash: "^4.0.0", react: "^18.0.0" },
    }, null, 2));
    await git.add(".");
    await git.commit("reformat plus axios", undefined, { "--author": "Flaught Test <test@flaught.dev>" });

    const added = await collectAddedDependencies(repoPath, baseSha, "HEAD");
    expect(added.map((d) => d.name)).toEqual(["axios"]);
  });
});

describe("runDependencySanityCheck", () => {
  it("emits high severity for a 404", async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes("registry.npmjs.org") && url.includes("unknown-package-xyz")) {
        return new Response("Not found", { status: 404 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({
      added: [dep("unknown-package-xyz")],
      fetch: fetchFn,
      now: NOW,
    });
    expect(result.fault).toBe(false);
    const missing = result.findings.find((f) => f.ruleId === "dependency-nonexistent");
    expect(missing?.severity).toBe("high");
    expect(missing?.reference).toBe("https://www.npmjs.com/package/unknown-package-xyz");
  });

  it("emits medium severity for a young package", async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes("registry.npmjs.org")) {
        return jsonResponse({ time: { created: "2026-08-23T00:00:00.000Z" } });
      }
      if (url.includes("downloads")) return jsonResponse({ downloads: 1000 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({
      added: [dep("brand-new-pkg")],
      fetch: fetchFn,
      now: NOW,
    });
    expect(result.findings.find((f) => f.ruleId === "dependency-too-new")?.severity).toBe("medium");
  });

  it("emits low severity maintainability for low downloads", async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes("registry.npmjs.org")) {
        return jsonResponse({ time: { created: "2020-01-01T00:00:00.000Z" } });
      }
      if (url.includes("downloads")) return jsonResponse({ downloads: 2 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({
      added: [dep("quiet-pkg")],
      fetch: fetchFn,
      now: NOW,
    });
    const dl = result.findings.find((f) => f.ruleId === "dependency-low-downloads");
    expect(dl?.severity).toBe("low");
    expect(dl?.category).toBe("maintainability");
    expect(dl?.title).toContain("2 weekly downloads");
  });

  it("detects reactt as a typosquat even when the name 404s", async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes("registry.npmjs.org")) return new Response("Not found", { status: 404 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({
      added: [dep("reactt")],
      fetch: fetchFn,
      now: NOW,
    });
    expect(result.findings.map((f) => f.ruleId).sort()).toEqual(["dependency-nonexistent", "dependency-typosquat"]);
  });

  it("does not flag an exact popular-package name that exists", async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes("registry.npmjs.org")) {
        return jsonResponse({ time: { created: "2011-10-26T00:00:00.000Z" } });
      }
      if (url.includes("downloads")) return jsonResponse({ downloads: 20_000_000 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({
      added: [dep("react", "^18.0.0")],
      fetch: fetchFn,
      now: NOW,
    });
    expect(result.findings).toEqual([]);
  });

  it("continues when one package request fails", async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes("flaky-pkg") && url.includes("registry.npmjs.org")) {
        throw new Error("ECONNRESET");
      }
      if (url.includes("registry.npmjs.org")) {
        return new Response("Not found", { status: 404 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({
      added: [dep("ok-pkg"), dep("flaky-pkg")],
      fetch: fetchFn,
      now: NOW,
    });
    expect(result.fault).toBe(false);
    expect(result.warnings.some((w) => w.includes("flaky-pkg"))).toBe(true);
    expect(result.findings.some((f) => f.snippet === "ok-pkg" && f.ruleId === "dependency-nonexistent")).toBe(true);
  });

  it("treats a registry outage as a tool fault", async () => {
    const fetchFn = mockFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    });
    const result = await runDependencySanityCheck({
      added: [dep("unknown-package-xyz")],
      fetch: fetchFn,
      now: NOW,
    });
    expect(result.fault).toBe(true);
    expect(result.findings.filter((f) => f.ruleId === "dependency-nonexistent")).toEqual([]);
  });

  it("skips registry lookups and typosquat for workspace specifiers", async () => {
    const fetchFn = mockFetch((url) => {
      throw new Error(`should not fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({
      added: [dep("reactt", "workspace:*"), dep("@acme/pkg", "workspace:*")],
      fetch: fetchFn,
      now: NOW,
    });
    expect(result.fault).toBe(false);
    expect(result.findings).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("URL-encodes scoped package names", async () => {
    const fetchFn = mockFetch((url) => {
      expect(url).toContain(encodeURIComponent("@scope/missing"));
      return new Response("Not found", { status: 404 });
    });
    const result = await runDependencySanityCheck({
      added: [dep("@scope/missing")],
      fetch: fetchFn,
      now: NOW,
    });
    expect(result.findings.some((f) => f.ruleId === "dependency-nonexistent")).toBe(true);
  });

  it("warns when the downloads endpoint returns a non-ok status", async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes("registry.npmjs.org")) {
        return jsonResponse({ time: { created: "2020-01-01T00:00:00.000Z" } });
      }
      if (url.includes("downloads")) return new Response("nope", { status: 500 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({
      added: [dep("quiet-pkg")],
      fetch: fetchFn,
      now: NOW,
    });
    expect(result.fault).toBe(false);
    expect(result.findings.some((f) => f.ruleId === "dependency-low-downloads")).toBe(false);
    expect(result.warnings.some((w) => w.includes("Downloads check failed") && w.includes("500"))).toBe(true);
  });

  it("skips only the download check when that request throws", async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes("registry.npmjs.org")) {
        return jsonResponse({ time: { created: "2020-01-01T00:00:00.000Z" } });
      }
      if (url.includes("downloads")) throw new Error("downloads API down");
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await runDependencySanityCheck({
      added: [dep("quiet-pkg")],
      fetch: fetchFn,
      now: NOW,
    });
    expect(result.fault).toBe(false);
    expect(result.findings.some((f) => f.ruleId === "dependency-low-downloads")).toBe(false);
    expect(result.warnings.some((w) => w.includes("Downloads check failed"))).toBe(true);
  });

  it("checks added packages with bounded concurrency", async () => {
    let inflight = 0;
    let max = 0;
    const fetchFn = mockFetch(async () => {
      inflight += 1;
      max = Math.max(max, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight -= 1;
      throw new Error("ENOTFOUND");
    });
    const added = Array.from({ length: 10 }, (_, i) => dep(`pkg-${i}`));
    const result = await runDependencySanityCheck({
      added,
      fetch: fetchFn,
      now: NOW,
      concurrency: REGISTRY_CONCURRENCY,
    });
    expect(result.fault).toBe(true);
    expect(max).toBeLessThanOrEqual(REGISTRY_CONCURRENCY);
    expect(max).toBeGreaterThan(1);
  });
});

describe("runDeterministicTools wiring", () => {
  it("records a dependency_sanity execution when enabled", async () => {
    const config = FlaughtConfigSchema.parse({
      tools: {
        semgrep: { enabled: false },
        linter: { enabled: false },
        vuln_scanner: { enabled: false },
        test_weakening: { enabled: false },
      },
    });
    const result = await runDeterministicTools(config, process.cwd(), {});
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
