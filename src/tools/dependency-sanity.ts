/**
 * Dependency sanity check — flags newly added npm packages that look
 * hallucinated, typosquatted, brand-new, or unused.
 *
 * Queries the npm registry for existence / age / weekly downloads, and
 * compares names against a curated popular-package list with Levenshtein
 * distance. Network failures are warnings, never "this package is malicious."
 */

import type { DeterministicFinding } from "./runner.js";

const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "flaught-dependency-sanity (https://github.com/flaught/core)";
const REGISTRY_URL = "https://registry.npmjs.org";
const DOWNLOADS_URL = "https://api.npmjs.org/downloads/point/last-week";

const DEP_SECTIONS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);

const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const PLUS_FILE = /^\+\+\+ (?:b\/)?(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const SECTION_OPEN = /^([ +\-])(\s*)"([^"]+)":\s*\{/;
const SECTION_CLOSE = /^([ +\-])(\s*)\}/;
const PKG_ENTRY = /^([ +\-])(\s*)"((?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+)":\s*"([^"]*)"/;

/**
 * Well-known npm packages that typosquatters impersonate. Exact matches are
 * never flagged. Includes common 1-edit neighbours (vuex, react-dom, …) so
 * legitimate related packages aren't treated as impersonations of a sibling.
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
  diff: string;
  minAgeDays?: number;
  minWeeklyDownloads?: number;
  typosquatMaxDistance?: number;
  fetch?: FetchLike;
  now?: Date;
  onWarn?: (message: string) => void;
}

export interface DependencySanityResult {
  findings: DeterministicFinding[];
  /** True when every registry metadata request failed — not a verdict. */
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

/** Local/VCS specs are not npm registry names — a 404 would be a false positive. */
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

export function extractAddedDependencies(diff: string): AddedDependency[] {
  const addedByFile = new Map<string, Map<string, AddedDependency>>();
  const removedByFile = new Map<string, Set<string>>();

  let file: string | null = null;
  let newLine = 0;
  let section: string | null = null;
  let sectionIndent = -1;

  const ensureAdded = (path: string): Map<string, AddedDependency> => {
    let map = addedByFile.get(path);
    if (!map) {
      map = new Map();
      addedByFile.set(path, map);
    }
    return map;
  };
  const ensureRemoved = (path: string): Set<string> => {
    let set = removedByFile.get(path);
    if (!set) {
      set = new Set();
      removedByFile.set(path, set);
    }
    return set;
  };

  for (const line of diff.split(/\r?\n/)) {
    const fileHeader = FILE_HEADER.exec(line);
    if (fileHeader) {
      file = isPackageJsonPath(fileHeader[2] ?? "") ? (fileHeader[2] ?? null) : null;
      section = null;
      sectionIndent = -1;
      continue;
    }

    const plusFile = PLUS_FILE.exec(line);
    if (plusFile) {
      const candidate = plusFile[1] ?? "";
      if (candidate !== "/dev/null" && isPackageJsonPath(candidate)) {
        file = candidate;
      } else if (candidate === "/dev/null") {
        file = null;
      }
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      newLine = parseInt(hunk[1] ?? "0", 10);
      continue;
    }

    if (!file) continue;
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ")) continue;
    if (line.startsWith("\\") || line.length === 0) continue;
    const prefix = line[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") continue;

    const sectionOpen = SECTION_OPEN.exec(line);
    if (sectionOpen) {
      const indent = (sectionOpen[2] ?? "").length;
      const key = sectionOpen[3] ?? "";
      if (section !== null && indent <= sectionIndent) {
        section = null;
        sectionIndent = -1;
      }
      if (DEP_SECTIONS.has(key)) {
        section = key;
        sectionIndent = indent;
      } else if (section !== null && indent <= sectionIndent) {
        section = null;
        sectionIndent = -1;
      }
    } else {
      const sectionClose = SECTION_CLOSE.exec(line);
      if (sectionClose && section !== null) {
        const indent = (sectionClose[2] ?? "").length;
        if (indent <= sectionIndent) {
          section = null;
          sectionIndent = -1;
        }
      }
    }

    const pkg = PKG_ENTRY.exec(line);
    if (pkg && section !== null && DEP_SECTIONS.has(section)) {
      const name = pkg[3] ?? "";
      const version = pkg[4] ?? "";
      if (prefix === "+") {
        ensureAdded(file).set(name, { name, version, file, line: newLine });
      } else if (prefix === "-") {
        ensureRemoved(file).add(name);
      }
    }

    if (prefix === "+" || prefix === " ") {
      newLine += 1;
    }
  }

  const result: AddedDependency[] = [];
  for (const [path, added] of addedByFile) {
    const removed = removedByFile.get(path) ?? new Set();
    for (const [name, dep] of added) {
      if (!removed.has(name)) {
        result.push(dep);
      }
    }
  }
  return result;
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
  if (!response.ok) return null;
  const body = (await response.json()) as { downloads?: unknown };
  return typeof body.downloads === "number" ? body.downloads : null;
}

function npmPackageUrl(packageName: string): string {
  return `https://www.npmjs.com/package/${packageName}`;
}

function finding(partial: {
  title: string;
  severity: "high" | "medium" | "low";
  file: string;
  line: number;
  snippet: string;
  ruleId: string;
  reference?: string;
}): DeterministicFinding {
  return {
    title: partial.title,
    severity: partial.severity,
    category: "security",
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

export async function runDependencySanityCheck(
  options: DependencySanityOptions,
): Promise<DependencySanityResult> {
  const minAgeDays = options.minAgeDays ?? 30;
  const minWeeklyDownloads = options.minWeeklyDownloads ?? 10;
  const typosquatMaxDistance = options.typosquatMaxDistance ?? 1;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? new Date();
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    options.onWarn?.(message);
  };

  const added = extractAddedDependencies(options.diff);
  const findings: DeterministicFinding[] = [];
  let metadataSuccesses = 0;
  let metadataFailures = 0;

  for (const dep of added) {
    const typosquat = findTyposquatMatch(dep.name, typosquatMaxDistance);
    if (typosquat) {
      findings.push(finding({
        title: `Possible typosquat: '${dep.name}' is similar to '${typosquat}'`,
        severity: "high",
        file: dep.file,
        line: dep.line,
        snippet: dep.name,
        ruleId: "dependency-typosquat",
        reference: npmPackageUrl(typosquat),
      }));
    }

    if (!isRegistrySpecifier(dep.version)) continue;

    try {
      const meta = await fetchPackageMetadata(dep.name, fetchFn);
      metadataSuccesses += 1;

      if (meta.status === "not_found") {
        findings.push(finding({
          title: `Package '${dep.name}' does not exist on the npm registry`,
          severity: "high",
          file: dep.file,
          line: dep.line,
          snippet: dep.name,
          ruleId: "dependency-nonexistent",
          reference: `${REGISTRY_URL}/${encodeURIComponent(dep.name)}`,
        }));
        continue;
      }

      if (meta.created) {
        const ageDays = daysBetween(meta.created, now);
        if (ageDays !== null && ageDays < minAgeDays) {
          const rounded = Math.max(0, Math.floor(ageDays));
          findings.push(finding({
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
          findings.push(finding({
            title: `Package '${dep.name}' has ${downloads} weekly download${downloads === 1 ? "" : "s"} (minimum ${minWeeklyDownloads})`,
            severity: "low",
            file: dep.file,
            line: dep.line,
            snippet: dep.name,
            ruleId: "dependency-low-downloads",
          }));
        }
      } catch (err) {
        warn(`Downloads check failed for '${dep.name}': ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      metadataFailures += 1;
      warn(`Registry lookup failed for '${dep.name}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const fault = added.length > 0 && metadataSuccesses === 0 && metadataFailures > 0;
  return { findings, fault, warnings };
}
