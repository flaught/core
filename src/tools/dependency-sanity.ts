/**
 * Dependency sanity check - flags newly added npm packages that look
 * hallucinated, typosquatted, brand-new, or unused.
 *
 * Compares parsed package.json manifests (git show base vs head) so
 * reformatting / key reorder does not cancel genuine additions.
 * Queries the npm registry for existence / age / weekly downloads, and
 * compares names against a curated popular-package list with Levenshtein
 * distance. Network failures are warnings, never "this package is malicious."
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeterministicFinding } from "./runner.js";

const execFileAsync = promisify(execFile);

const REQUEST_TIMEOUT_MS = 10_000;
/** Bounded parallelism across packages. Each package still does metadata then downloads sequentially. */
export const REGISTRY_CONCURRENCY = 5;
const USER_AGENT = "flaught-dependency-sanity (https://github.com/flaught/core)";
const REGISTRY_URL = "https://registry.npmjs.org";
const DOWNLOADS_URL = "https://api.npmjs.org/downloads/point/last-week";

const DEP_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/**
 * Well-known npm packages that typosquatters impersonate. Exact matches are
 * never flagged. Includes common 1-edit neighbours (vuex, react-dom, ...) so
 * legitimate related packages aren't treated as impersonations of a sibling.
 *
 * This list is a first-cut net (~90 names): only typos of *these* packages
 * are detected. Unknown-but-popular names outside the list will not match.
 */
export const POPULAR_PACKAGES: readonly string[] = [
  "react", "react-dom", "react-native", "react-router", "react-router-dom",
  "vue", "vuex", "vue-router", "nuxt", "angular", "@angular/core",
  "next", "gatsby", "remix", "astro", "svelte", "preact", "solid-js", "jquery",
  "express", "koa", "fastify", "hapi", "@nestjs/core",
  "lodash", "underscore", "ramda",
  "axios", "got", "node-fetch", "superagent", "request",
  "webpack", "vite", "esbuild", "rollup", "parcel",
  "typescript", "eslint", "prettier", "@babel/core",
  "jest", "mocha", "vitest", "chai", "cypress", "playwright",
  "commander", "yargs", "minimist", "chalk", "debug", "glob", "rimraf",
  "semver", "js-yaml", "yaml", "zod", "joi", "ajv", "uuid",
  "moment", "dayjs", "luxon", "date-fns", "rxjs", "redux", "mobx",
  "socket.io", "ws", "cors", "body-parser", "dotenv", "jsonwebtoken", "bcrypt",
  "mongoose", "mongodb", "pg", "mysql2", "redis", "ioredis",
  "prisma", "knex", "sequelize", "typeorm", "graphql",
  "tailwindcss", "postcss", "sass", "classnames", "prop-types",
  "styled-components", "electron", "firebase", "stripe",
  "ts-node", "tsx", "nodemon", "husky", "lint-staged",
  "helmet", "passport", "multer", "compression", "morgan", "cookie-parser",
];

export interface AddedDependency {
  name: string;
  version: string;
  file: string;
  line: number;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DependencySanityOptions {
  /** Repo root used to `git show` base/head package.json files. */
  repoPath?: string;
  baseRef?: string;
  headRef?: string;
  /** Test injection: skip git and check these packages directly. */
  added?: AddedDependency[];
  minAgeDays?: number;
  minWeeklyDownloads?: number;
  typosquatMaxDistance?: number;
  fetch?: FetchLike;
  now?: Date;
  onWarn?: (message: string) => void;
  concurrency?: number;
}

export interface DependencySanityResult {
  findings: DeterministicFinding[];
  /** True when every registry metadata request failed - not a verdict. */
  fault: boolean;
  warnings: string[];
}

export type PackageMetadata =
  | { status: "ok"; created: string | null }
  | { status: "not_found" };

function isPackageJsonPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized === "package.json" || normalized.endsWith("/package.json");
}

/** Local/VCS specs are not npm registry names: a 404 would be a false positive. */
export function isRegistrySpecifier(version: string): boolean {
  const v = version.trim();
  if (
    v.startsWith("workspace:") ||
    v.startsWith("file:") ||
    v.startsWith("link:") ||
    v.startsWith("portal:") ||
    v.startsWith("catalog:")
  ) {
    return false;
  }
  if (/^(git\+|git:|ssh:|github:|gitlab:|bitbucket:|gist:)/i.test(v)) {
    return false;
  }
  if (/^https?:\/\//i.test(v)) return false;
  if (v.startsWith("./") || v.startsWith("../") || v.startsWith("/") || v.startsWith("~/")) {
    return false;
  }
  return true;
}

function depMap(pkg: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!pkg || typeof pkg !== "object") return map;
  const record = pkg as Record<string, unknown>;
  for (const key of DEP_KEYS) {
    const section = record[key];
    if (!section || typeof section !== "object") continue;
    for (const [name, version] of Object.entries(section as Record<string, unknown>)) {
      if (typeof version === "string" && !map.has(name)) {
        map.set(name, version);
      }
    }
  }
  return map;
}

function lineOfPackage(source: string, name: string): number {
  const needle = `"${name}"`;
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes(needle) && /:\s*"/.test(line)) {
      return i + 1;
    }
  }
  return 0;
}

/**
 * Diff parsed package.json objects. Names present on head but not in any
 * dependency section on base are "added"; version bumps and key reorder
 * are ignored.
 */
export function extractAddedDependencies(
  headPkg: unknown,
  basePkg: unknown,
  file: string,
  headSource: string = "",
): AddedDependency[] {
  const head = depMap(headPkg);
  const base = depMap(basePkg);
  const added: AddedDependency[] = [];
  for (const [name, version] of head) {
    if (!base.has(name)) {
      added.push({ name, version, file, line: lineOfPackage(headSource, name) });
    }
  }
  return added;
}

async function gitShow(repoPath: string, spec: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["show", spec], {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

function parsePackageJson(raw: string | null): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** List packages added between two git refs by comparing parsed manifests. */
export async function collectAddedDependencies(
  repoPath: string,
  baseRef: string,
  headRef: string,
): Promise<AddedDependency[]> {
  let names = "";
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMR", baseRef, headRef],
      { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
    );
    names = stdout;
  } catch {
    return [];
  }

  const files = names.split(/\r?\n/).filter((f) => isPackageJsonPath(f));
  const added: AddedDependency[] = [];
  for (const file of files) {
    const headSource = await gitShow(repoPath, `${headRef}:${file}`);
    const baseSource = await gitShow(repoPath, `${baseRef}:${file}`);
    added.push(
      ...extractAddedDependencies(
        parsePackageJson(headSource),
        parsePackageJson(baseSource),
        file,
        headSource ?? "",
      ),
    );
  }
  return added;
}

export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }
  const n = items.length === 0 ? 0 : Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const cols = b.length + 1;
  const prev = new Array<number>(cols);
  const curr = new Array<number>(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j < cols; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? b.length;
}

export function findTyposquatMatch(
  packageName: string,
  maxDistance: number = 1,
  popular: readonly string[] = POPULAR_PACKAGES,
): string | null {
  const name = packageName.toLowerCase();
  if (popular.includes(name)) return null;
  if (name.length < 4) return null;

  let best: { name: string; distance: number } | null = null;
  for (const pop of popular) {
    if (Math.abs(pop.length - name.length) > maxDistance) continue;
    const distance = levenshteinDistance(name, pop);
    if (distance > 0 && distance <= maxDistance) {
      if (!best || distance < best.distance) {
        best = { name: pop, distance };
      }
    }
  }
  return best?.name ?? null;
}

function registryHeaders(): HeadersInit {
  return {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
}

export async function fetchPackageMetadata(
  packageName: string,
  fetchFn: FetchLike = globalThis.fetch,
): Promise<PackageMetadata> {
  const url = `${REGISTRY_URL}/${encodeURIComponent(packageName)}`;
  const response = await fetchFn(url, {
    headers: registryHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return { status: "not_found" };
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status} for ${packageName}`);
  }
  const body = (await response.json()) as { time?: { created?: unknown } };
  const created = typeof body.time?.created === "string" ? body.time.created : null;
  return { status: "ok", created };
}

export async function fetchWeeklyDownloads(
  packageName: string,
  fetchFn: FetchLike = globalThis.fetch,
): Promise<number | null> {
  const url = `${DOWNLOADS_URL}/${encodeURIComponent(packageName)}`;
  const response = await fetchFn(url, {
    headers: registryHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`npm downloads API returned HTTP ${response.status} for ${packageName}`);
  }
  const body = (await response.json()) as { downloads?: unknown };
  return typeof body.downloads === "number" ? body.downloads : null;
}

function npmPackageUrl(packageName: string): string {
  return `https://www.npmjs.com/package/${packageName}`;
}

function finding(partial: {
  title: string;
  severity: "high" | "medium" | "low";
  category?: "security" | "maintainability";
  file: string;
  line: number;
  snippet: string;
  ruleId: string;
  reference?: string;
}): DeterministicFinding {
  return {
    title: partial.title,
    severity: partial.severity,
    category: partial.category ?? "security",
    file: partial.file,
    line: partial.line,
    snippet: partial.snippet,
    source: "dependency_sanity",
    ruleId: partial.ruleId,
    reference: partial.reference ?? npmPackageUrl(partial.snippet),
  };
}

function daysBetween(createdIso: string, now: Date): number | null {
  const created = Date.parse(createdIso);
  if (Number.isNaN(created)) return null;
  return (now.getTime() - created) / (1000 * 60 * 60 * 24);
}

interface PackageCheck {
  findings: DeterministicFinding[];
  metadataSuccess: boolean;
  metadataFailure: boolean;
  warnings: string[];
}

export async function runDependencySanityCheck(
  options: DependencySanityOptions,
): Promise<DependencySanityResult> {
  const minAgeDays = options.minAgeDays ?? 30;
  const minWeeklyDownloads = options.minWeeklyDownloads ?? 10;
  const typosquatMaxDistance = options.typosquatMaxDistance ?? 1;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? new Date();
  const concurrency = options.concurrency ?? REGISTRY_CONCURRENCY;
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    options.onWarn?.(message);
  };

  const added = options.added
    ?? (options.repoPath
      ? await collectAddedDependencies(
          options.repoPath,
          options.baseRef ?? "HEAD~1",
          options.headRef ?? "HEAD",
        )
      : []);

  const checks = await mapPool(added, concurrency, async (dep): Promise<PackageCheck> => {
    const localFindings: DeterministicFinding[] = [];
    const localWarnings: string[] = [];
    const localWarn = (message: string): void => {
      localWarnings.push(message);
    };

    if (!isRegistrySpecifier(dep.version)) {
      return { findings: localFindings, metadataSuccess: false, metadataFailure: false, warnings: localWarnings };
    }

    const typosquat = findTyposquatMatch(dep.name, typosquatMaxDistance);
    if (typosquat) {
      localFindings.push(finding({
        title: `Possible typosquat: '${dep.name}' is similar to '${typosquat}'`,
        severity: "high",
        file: dep.file,
        line: dep.line,
        snippet: dep.name,
        ruleId: "dependency-typosquat",
        reference: npmPackageUrl(typosquat),
      }));
    }

    try {
      const meta = await fetchPackageMetadata(dep.name, fetchFn);

      if (meta.status === "not_found") {
        localFindings.push(finding({
          title: `Package '${dep.name}' does not exist on the npm registry`,
          severity: "high",
          file: dep.file,
          line: dep.line,
          snippet: dep.name,
          ruleId: "dependency-nonexistent",
          reference: npmPackageUrl(dep.name),
        }));
        return { findings: localFindings, metadataSuccess: true, metadataFailure: false, warnings: localWarnings };
      }

      if (meta.created) {
        const ageDays = daysBetween(meta.created, now);
        if (ageDays !== null && ageDays < minAgeDays) {
          const rounded = Math.max(0, Math.floor(ageDays));
          localFindings.push(finding({
            title: `Package '${dep.name}' was published ${rounded} day${rounded === 1 ? "" : "s"} ago (minimum ${minAgeDays})`,
            severity: "medium",
            file: dep.file,
            line: dep.line,
            snippet: dep.name,
            ruleId: "dependency-too-new",
          }));
        }
      }

      try {
        const downloads = await fetchWeeklyDownloads(dep.name, fetchFn);
        if (downloads !== null && downloads < minWeeklyDownloads) {
          localFindings.push(finding({
            title: `Package '${dep.name}' has ${downloads} weekly download${downloads === 1 ? "" : "s"} (minimum ${minWeeklyDownloads})`,
            severity: "low",
            category: "maintainability",
            file: dep.file,
            line: dep.line,
            snippet: dep.name,
            ruleId: "dependency-low-downloads",
          }));
        }
      } catch (err) {
        localWarn(`Downloads check failed for '${dep.name}': ${err instanceof Error ? err.message : String(err)}`);
      }

      return { findings: localFindings, metadataSuccess: true, metadataFailure: false, warnings: localWarnings };
    } catch (err) {
      localWarn(`Registry lookup failed for '${dep.name}': ${err instanceof Error ? err.message : String(err)}`);
      return { findings: localFindings, metadataSuccess: false, metadataFailure: true, warnings: localWarnings };
    }
  });

  const findings: DeterministicFinding[] = [];
  let metadataSuccesses = 0;
  let metadataFailures = 0;
  for (const check of checks) {
    findings.push(...check.findings);
    if (check.metadataSuccess) metadataSuccesses += 1;
    if (check.metadataFailure) metadataFailures += 1;
    for (const message of check.warnings) warn(message);
  }

  const registryLookups = added.filter((dep) => isRegistrySpecifier(dep.version)).length;
  const fault = registryLookups > 0 && metadataSuccesses === 0 && metadataFailures > 0;
  return { findings, fault, warnings };
}
