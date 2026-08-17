/**
 * Dependency neighborhood analysis — the one-hop dependency graph.
 *
 * For each changed file, we find all files that import/require/rely on it.
 * This gives us the "blast radius" — files that might be affected by the change
 * even though they weren't directly modified.
 *
 * Current implementation uses regex-based import analysis. This handles the
 * common cases (ESM, CJS, Python imports) correctly and can be upgraded to
 * tree-sitter for more robust AST-based analysis later. The interface is
 * designed so tree-sitter can be swapped in without changing consumers.
 */

// ─── File type detection ───────────────────────────────────────────────────

type LanguageFamily = "js" | "python" | "go" | "unknown";

function detectLanguage(filePath: string): LanguageFamily {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "js";
  if (["py", "pyi"].includes(ext)) return "python";
  if (ext === "go") return "go";
  return "unknown";
}

// ─── Import parsing ────────────────────────────────────────────────────────

export interface ImportEntry {
  /** The imported module path (as written in the import statement) */
  specifier: string;
  /** The resolved file path relative to repo root, or null if unresolvable */
  resolvedPath: string | null;
  /** The file that contains this import */
  sourceFile: string;
  /** Line number in the source file */
  line: number;
}

/**
 * Parse import/require statements from source code.
 *
 * Applies language-specific parsers based on file extension:
 * - JS/TS: ESM imports, dynamic imports, CJS require
 * - Python: import x, from x import y, from .x import y
 * - Go: import "x", import ( "x" "y" )
 */
export function parseImports(
  sourceFile: string,
  content: string,
): ImportEntry[] {
  const lang = detectLanguage(sourceFile);
  const imports: ImportEntry[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (lang === "js") {
      // ESM: import ... from 'specifier'  |  import 'specifier'
      for (const match of line.matchAll(
        /import\s+(?:[\w{},\s]+\s+from\s+)?['"]([^'"]+)['"]/g,
      )) {
        imports.push({
          specifier: match[1]!,
          resolvedPath: null,
          sourceFile,
          line: i + 1,
        });
      }

      // Dynamic import: import('specifier')
      for (const match of line.matchAll(/import\(\s*['"]([^'"]+)['"]/g)) {
        imports.push({
          specifier: match[1]!,
          resolvedPath: null,
          sourceFile,
          line: i + 1,
        });
      }

      // CJS: require('specifier')
      for (const match of line.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        imports.push({
          specifier: match[1]!,
          resolvedPath: null,
          sourceFile,
          line: i + 1,
        });
      }
    }

    if (lang === "python") {
      // Python: import x.y
      for (const match of line.matchAll(/^import\s+([\w.]+)/gm)) {
        imports.push({
          specifier: match[1]!,
          resolvedPath: null,
          sourceFile,
          line: i + 1,
        });
      }

      // Python: from x.y import z  |  from .x import z
      for (const match of line.matchAll(/^from\s+([\w.]+)\s+import/gm)) {
        imports.push({
          specifier: match[1]!,
          resolvedPath: null,
          sourceFile,
          line: i + 1,
        });
      }
    }

    if (lang === "go") {
      // Go: import "x" (single line)
      for (const match of line.matchAll(/^import\s+"([^"]+)"/gm)) {
        imports.push({
          specifier: match[1]!,
          resolvedPath: null,
          sourceFile,
          line: i + 1,
        });
      }
    }
  }

  // Go multi-line import blocks: import ( "x" "y" )
  if (lang === "go") {
    for (const blockMatch of content.matchAll(/import\s*\(\s*([\s\S]*?)\s*\)/g)) {
      for (const lineMatch of blockMatch[1]!.matchAll(/"([^"]+)"/g)) {
        imports.push({
          specifier: lineMatch[1]!,
          resolvedPath: null,
          sourceFile,
          line: 0, // Multi-line blocks don't map cleanly
        });
      }
    }
  }

  return imports;
}

// ─── Module resolution ──────────────────────────────────────────────────────

/**
 * Resolve a bare specifier to a file path in the repo.
 *
 * Strategy:
 * - Relative JS/TS specifiers (./foo, ../foo): try extensions and /index variants
 * - Relative Python specifiers (.foo, ..foo): try .py and /__init__.py variants
 * - Bare specifiers (react, lodash): don't resolve — conservative, avoids false edges
 *
 * For unknown file types, tries both JS and Python resolution.
 */
export function resolveSpecifier(
  specifier: string,
  sourceFile: string,
  allFilePaths: Set<string>,
): string | null {
  const lang = detectLanguage(sourceFile);

  // Python relative imports (from .foo import bar, from ..baz import qux)
  // These start with one or more dots followed by a name (not a slash)
  const isPythonRelative =
    lang === "python" && /^\.{1,2}\w/.test(specifier);

  // JS/TS relative imports (./foo, ../foo)
  const isJsRelative =
    (lang === "js" || lang === "unknown") &&
    (specifier.startsWith("./") || specifier.startsWith("../"));

  // For mixed-language repos or unknown types, try both
  if (lang === "unknown") {
    const jsResult = resolveJsRelative(specifier, sourceFile, allFilePaths);
    if (jsResult) return jsResult;
    const pyResult = resolvePythonRelative(specifier, sourceFile, allFilePaths);
    if (pyResult) return pyResult;
    return null;
  }

  if (isPythonRelative) {
    return resolvePythonRelative(specifier, sourceFile, allFilePaths);
  }

  if (isJsRelative) {
    return resolveJsRelative(specifier, sourceFile, allFilePaths);
  }

  // Bare specifiers (node_modules, stdlib) — don't resolve
  return null;
}

function resolveJsRelative(
  specifier: string,
  sourceFile: string,
  allFilePaths: Set<string>,
): string | null {
  const dir = pathDirname(sourceFile);
  const candidates = [
    specifier,
    `${specifier}.ts`,
    `${specifier}.tsx`,
    `${specifier}.js`,
    `${specifier}.jsx`,
    `${specifier}/index.ts`,
    `${specifier}/index.tsx`,
    `${specifier}/index.js`,
    `${specifier}/index.jsx`,
  ];

  for (const candidate of candidates) {
    const resolved = pathNormalize(pathJoin(dir, candidate));
    if (allFilePaths.has(resolved)) {
      return resolved;
    }
  }

  return null;
}

function resolvePythonRelative(
  specifier: string,
  sourceFile: string,
  allFilePaths: Set<string>,
): string | null {
  const dir = pathDirname(sourceFile);

  // Handle Python relative imports: .foo -> ./foo, ..foo -> ../foo, ..sub -> ../sub
  let modulePath: string;
  if (/^\.\./.test(specifier)) {
    // ..foo -> parent/foo
    const name = specifier.slice(2);
    modulePath = `../${name}`;
  } else if (/^\./.test(specifier)) {
    // .foo -> ./foo
    const name = specifier.slice(1);
    modulePath = `./${name}`;
  } else {
    // Absolute Python import: foo.bar -> foo/bar
    modulePath = specifier.replace(/\./g, "/");
  }

  const candidates = [
    `${modulePath}.py`,
    `${modulePath}/__init__.py`,
  ];

  for (const candidate of candidates) {
    const resolved = pathNormalize(pathJoin(dir, candidate));
    if (allFilePaths.has(resolved)) {
      return resolved;
    }
  }

  return null;
}

// ─── Dependency graph ───────────────────────────────────────────────────────

export interface DependencyGraph {
  /**
   * Get all files that depend on (import from) the given set of files.
   * This is the one-hop "dependents" — the blast radius.
   */
  getDependentsOf(files: Set<string>): string[];

  /**
   * Get all files that the given file imports/depends on.
   */
  getDependenciesOf(file: string): string[];

  /**
   * Get all imports found in a file.
   */
  getImportsFor(file: string): ImportEntry[];

  /**
   * Get all files in the graph.
   */
  getAllFiles(): string[];
}

export function buildDependencyGraph(
  fileContents: Map<string, string>,
): DependencyGraph {
  // Forward: file -> files it imports
  const forwardDeps = new Map<string, Set<string>>();
  // Reverse: file -> files that import it (dependents)
  const reverseDeps = new Map<string, Set<string>>();
  // All imports parsed, keyed by source file
  const importsMap = new Map<string, ImportEntry[]>();

  const allFilePaths = new Set(fileContents.keys());

  // Initialize maps for all files
  for (const filePath of allFilePaths) {
    forwardDeps.set(filePath, new Set());
    reverseDeps.set(filePath, new Set());
  }

  // Parse imports and build the graph
  for (const [filePath, content] of fileContents) {
    const imports = parseImports(filePath, content);
    importsMap.set(filePath, imports);

    for (const imp of imports) {
      const resolved = resolveSpecifier(
        imp.specifier,
        filePath,
        allFilePaths,
      );
      imp.resolvedPath = resolved;

      if (resolved && allFilePaths.has(resolved)) {
        forwardDeps.get(filePath)!.add(resolved);
        if (!reverseDeps.has(resolved)) {
          reverseDeps.set(resolved, new Set());
        }
        reverseDeps.get(resolved)!.add(filePath);
      }
    }
  }

  return {
    getDependentsOf(files: Set<string>): string[] {
      const dependents = new Set<string>();
      for (const file of files) {
        const deps = reverseDeps.get(file);
        if (deps) {
          for (const dep of deps) {
            dependents.add(dep);
          }
        }
      }
      return [...dependents].sort();
    },

    getDependenciesOf(file: string): string[] {
      const deps = forwardDeps.get(file);
      return deps ? [...deps].sort() : [];
    },

    getImportsFor(file: string): ImportEntry[] {
      return importsMap.get(file) ?? [];
    },

    getAllFiles(): string[] {
      return [...allFilePaths].sort();
    },
  };
}

// ─── Minimal path utilities (no dependency on Node path module for testability) ─

function pathDirname(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "." : filePath.slice(0, idx);
}

function pathJoin(...segments: string[]): string {
  return segments.join("/").replace(/\/+/g, "/");
}

function pathNormalize(filePath: string): string {
  const parts = filePath.split("/");
  const result: string[] = [];

  for (const part of parts) {
    if (part === "..") {
      result.pop();
    } else if (part !== "." && part !== "") {
      result.push(part);
    }
  }

  return result.join("/");
}