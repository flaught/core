/**
 * Context assembly — stage 1 of the Flaught pipeline.
 *
 * Assembles:
 * 1. The unified diff (base...head)
 * 2. A list of changed files
 * 3. The one-hop dependency neighborhood (files that import/call changed symbols)
 * 4. Full content of changed files + neighborhood files
 *
 * This is the highest-leverage, most-often-underbuilt piece of code review tooling.
 * The blast radius of a change is not legible from the diff alone — you need to know
 * what depends on what changed.
 */

import * as path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { buildDependencyGraph, type DependencyGraph } from "./neighborhood.js";
import { loadConfig } from "../config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChangedFile {
  path: string;
  /** Lines added in this file */
  additions: number;
  /** Lines removed in this file */
  deletions: number;
  /** Whether this file was added, modified, renamed, or deleted */
  status: "added" | "modified" | "renamed" | "deleted";
}

export interface ReviewContext {
  /** The unified diff */
  diff: string;
  /** Files that changed */
  changedFiles: ChangedFile[];
  /** Files in the one-hop dependency neighborhood (depend on changed files) */
  neighborhoodFiles: string[];
  /** Full content of changed files (keyed by relative path) */
  changedFileContents: Map<string, string>;
  /** Full content of neighborhood files (keyed by relative path) */
  neighborhoodFileContents: Map<string, string>;
  /** The dependency graph (for blast radius analysis) */
  dependencyGraph: DependencyGraph;
  /** Base and head SHAs */
  baseSha: string;
  headSha: string;
  /** Repository root (absolute path) */
  repoRoot: string;
}

/** JSON-safe representation of ReviewContext (Maps converted to objects) */
export interface ReviewContextJSON {
  diff: string;
  changedFiles: ChangedFile[];
  neighborhoodFiles: string[];
  changedFileContents: Record<string, string>;
  neighborhoodFileContents: Record<string, string>;
  dependencyGraph: {
    forwardDeps: Record<string, string[]>;
    reverseDeps: Record<string, string[]>;
  };
  baseSha: string;
  headSha: string;
  repoRoot: string;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface ContextOptions {
  /** Path to the git repo (defaults to cwd) */
  repoPath?: string;
  /** Base ref (branch, tag, or SHA). Defaults to HEAD~1 or the PR base branch. */
  baseRef?: string;
  /** Head ref. Defaults to HEAD. */
  headRef?: string;
  /** Path to .advreview.yml config */
  configPath?: string;
  /** File paths to exclude from context */
  excludePaths?: string[];
  /** File patterns to exclude (regex) */
  excludePatterns?: string[];
}

// ─── Diff extraction ────────────────────────────────────────────────────────

export async function getDiff(
  git: SimpleGit,
  baseRef: string,
  headRef: string,
): Promise<string> {
  const result = await git.diff([baseRef, headRef]);
  return result;
}

export async function getChangedFiles(
  git: SimpleGit,
  baseRef: string,
  headRef: string,
): Promise<ChangedFile[]> {
  // Unused — getChangedFilesWithStatus is preferred
  return getChangedFilesWithStatus(git, baseRef, headRef);
}

export async function getChangedFilesWithStatus(
  git: SimpleGit,
  baseRef: string,
  headRef: string,
): Promise<ChangedFile[]> {
  // Use diff --name-status for proper status codes
  const nameStatus = await git.raw(["diff", "--name-status", baseRef, headRef]);
  const lines = nameStatus.trim().split("\n").filter(Boolean);

  const statusMap: Record<string, ChangedFile["status"]> = {
    A: "added",
    M: "modified",
    R: "renamed",
    D: "deleted",
  };

  const summary = await git.diffSummary([baseRef, headRef]);
  // Build a map from filename -> insertions/deletions, filtering out binary files
  const changeMap = new Map<string, { insertions: number; deletions: number }>();
  for (const f of summary.files) {
    if ("insertions" in f && "deletions" in f) {
      changeMap.set(f.file, { insertions: f.insertions, deletions: f.deletions });
    }
  }

  return lines.map((line) => {
    const [statusChar, ...rest] = line.split("\t");
    // For renames, format is "R100\told\tnew"
    const filePath =
      rest.length > 1 ? rest[rest.length - 1]! : rest[0]!;
    const change = changeMap.get(filePath);
    const status = statusChar ? (statusMap[statusChar[0]!] ?? "modified") : "modified";

    return {
      path: filePath,
      additions: change?.insertions ?? 0,
      deletions: change?.deletions ?? 0,
      status: status as ChangedFile["status"],
    } satisfies ChangedFile;
  });
}

// ─── File content reading ────────────────────────────────────────────────────

export async function readFileContent(
  git: SimpleGit,
  ref: string,
  filePath: string,
): Promise<string | null> {
  try {
    const content = await git.show([`${ref}:${filePath}`]);
    return content;
  } catch {
    // File might not exist at this ref (e.g., deleted or added)
    return null;
  }
}

export async function readFileContents(
  git: SimpleGit,
  ref: string,
  filePaths: string[],
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  // Read files in parallel batches to avoid overwhelming the process
  const batchSize = 10;

  for (let i = 0; i < filePaths.length; i += batchSize) {
    const batch = filePaths.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (filePath) => {
        const content = await readFileContent(git, ref, filePath);
        return [filePath, content] as const;
      }),
    );

    for (const [filePath, content] of results) {
      if (content !== null) {
        contents.set(filePath, content);
      }
    }
  }

  return contents;
}

// ─── Exclusion filtering ────────────────────────────────────────────────────

function isExcluded(
  filePath: string,
  excludePaths: string[],
  excludePatterns: string[],
): boolean {
  // Check glob-style path exclusions
  for (const pattern of excludePaths) {
    // Simple glob matching: * matches anything, ** matches any path segment
    const globRegex = pattern
      .replace(/\*\*/g, "§§") // temp placeholder for **
      .replace(/\*/g, "[^/]*") // * matches anything except /
      .replace(/§§/g, ".*") // ** matches anything including /
      .replace(/\?/g, "[^/]");

    const regex = new RegExp(`^${globRegex}$`);
    if (regex.test(filePath)) return true;
  }

  // Check regex patterns
  for (const pattern of excludePatterns) {
    try {
      const regex = new RegExp(pattern);
      if (regex.test(filePath)) return true;
    } catch {
      // Invalid regex pattern — skip it
    }
  }

  return false;
}

// ─── Main context assembler ──────────────────────────────────────────────────

export async function assembleContext(
  options: ContextOptions = {},
): Promise<ReviewContext> {
  const repoPath = path.resolve(options.repoPath ?? process.cwd());
  const git = simpleGit(repoPath);

  // Load config for exclusions
  const config = await loadConfig(options.configPath);
  const excludePaths = [
    ...config.exclude.paths,
    ...(options.excludePaths ?? []),
  ];
  const excludePatterns = [
    ...config.exclude.patterns,
    ...(options.excludePatterns ?? []),
  ];

  // Resolve base and head refs
  const headRef = options.headRef ?? "HEAD";
  let baseRef = options.baseRef;

  if (!baseRef) {
    // Default: try the merge base with the default branch, fall back to HEAD~1
    try {
      const defaultBranch = await detectDefaultBranch(git);
      baseRef = await git.raw([
        "merge-base",
        defaultBranch,
        headRef,
      ]);
      baseRef = baseRef.trim();
    } catch {
      // Fall back to HEAD~1
      baseRef = "HEAD~1";
    }
  }

  // Resolve refs to SHAs
  const headSha = (await git.revparse([headRef])).trim();
  const baseSha = (await git.revparse([baseRef])).trim();

  // 1. Get the unified diff
  const diff = await getDiff(git, baseRef, headRef);

  // 2. Get changed files with proper status
  let changedFiles = await getChangedFilesWithStatus(
    git,
    baseRef,
    headRef,
  );

  // Filter out excluded files
  changedFiles = changedFiles.filter(
    (f) => !isExcluded(f.path, excludePaths, excludePatterns),
  );

  // 3. Read changed file contents (from head ref — the version being reviewed)
  const changedFilePaths = changedFiles
    .filter((f) => f.status !== "deleted")
    .map((f) => f.path);

  const changedFileContents = await readFileContents(
    git,
    headRef,
    changedFilePaths,
  );

  // 4. Build the dependency graph and find the one-hop neighborhood
  // We need to read ALL source files in the repo to build the graph,
  // but only include those in the one-hop neighborhood.
  const allFilePaths = await listSourceFiles(git, headRef, config.stack.languages);
  const allFileContents = await readFileContents(git, headRef, allFilePaths);

  const dependencyGraph = buildDependencyGraph(allFileContents);

  const changedPaths = new Set(changedFilePaths);
  const neighborhoodFiles = dependencyGraph
    .getDependentsOf(changedPaths)
    .filter((f) => !changedPaths.has(f)) // Don't double-count changed files
    .filter((f) => !isExcluded(f, excludePaths, excludePatterns));

  const neighborhoodFileContents = await readFileContents(
    git,
    headRef,
    neighborhoodFiles,
  );

  return {
    diff,
    changedFiles,
    neighborhoodFiles,
    changedFileContents,
    neighborhoodFileContents,
    dependencyGraph,
    baseSha,
    headSha,
    repoRoot: repoPath,
  };
}

/** Convert a ReviewContext to a JSON-serializable object (Maps -> Records) */
export function contextToJSON(ctx: ReviewContext): ReviewContextJSON {
  const forwardDeps: Record<string, string[]> = {};
  const reverseDeps: Record<string, string[]> = {};

  for (const file of ctx.dependencyGraph.getAllFiles()) {
    forwardDeps[file] = ctx.dependencyGraph.getDependenciesOf(file);
    reverseDeps[file] = ctx.dependencyGraph.getDependentsOf(new Set([file]));
  }

  return {
    diff: ctx.diff,
    changedFiles: ctx.changedFiles,
    neighborhoodFiles: ctx.neighborhoodFiles,
    changedFileContents: Object.fromEntries(ctx.changedFileContents),
    neighborhoodFileContents: Object.fromEntries(ctx.neighborhoodFileContents),
    dependencyGraph: { forwardDeps, reverseDeps },
    baseSha: ctx.baseSha,
    headSha: ctx.headSha,
    repoRoot: ctx.repoRoot,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function detectDefaultBranch(git: SimpleGit): Promise<string> {
  // Try common default branch names
  for (const candidate of ["main", "master"]) {
    try {
      await git.revparse([candidate]);
      return candidate;
    } catch {
      continue;
    }
  }

  // Fall back to first remote HEAD
  try {
    const remoteHead = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return remoteHead.trim().replace("refs/remotes/origin/", "");
  } catch {
    return "main"; // Ultimate fallback
  }
}

async function listSourceFiles(
  git: SimpleGit,
  ref: string,
  _languages: "auto" | string[],
): Promise<string[]> {
  // List all tracked files at the given ref
  const output = await git.raw(["ls-tree", "-r", "--name-only", ref]);

  const allFiles = output
    .trim()
    .split("\n")
    .filter(Boolean);

  // Filter to source files only (skip binaries, images, lockfiles, etc.)
  const sourceExtensions = new Set([
    // TypeScript / JavaScript
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    // Python
    ".py", ".pyi",
    // Go
    ".go",
    // Rust
    ".rs",
    // Java / Kotlin
    ".java", ".kt",
    // Ruby
    ".rb",
    // Config / markup
    ".yaml", ".yml", ".json", ".toml", ".xml",
    // Web
    ".html", ".css", ".scss",
    // Shell
    ".sh", ".bash",
  ]);

  const excludePatterns = [
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /\.min\./,
    /\.generated\./,
    /node_modules\//,
    /vendor\//,
    /\.git\//,
  ];

  return allFiles.filter((file) => {
    const ext = path.extname(file);
    if (!sourceExtensions.has(ext)) return false;
    return !excludePatterns.some((p) => p.test(file));
  });
}