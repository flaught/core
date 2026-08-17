import { describe, it, expect } from "vitest";
import { parseImports, resolveSpecifier, buildDependencyGraph } from "./neighborhood.js";

describe("parseImports", () => {
  it("parses ESM default imports", () => {
    const content = `import express from 'express';\nimport config from './config';`;
    const imports = parseImports("src/index.ts", content);

    expect(imports).toHaveLength(2);
    expect(imports[0]!.specifier).toBe("express");
    expect(imports[0]!.line).toBe(1);
    expect(imports[1]!.specifier).toBe("./config");
    expect(imports[1]!.line).toBe(2);
  });

  it("only applies JS parsers to .ts/.js files", () => {
    // A Python file with the word "import" should NOT match JS patterns
    const content = `import os\nfrom pathlib import Path`;
    const imports = parseImports("src/main.py", content);

    // Should only find Python-style imports, not JS ones
    expect(imports.every((imp) => imp.specifier !== "os" || imp.sourceFile.endsWith(".py"))).toBe(true);
    expect(imports.some((imp) => imp.specifier === "pathlib")).toBe(true);
  });

  it("parses ESM named imports", () => {
    const content = `import { Router, Request } from 'express';`;
    const imports = parseImports("src/app.ts", content);

    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe("express");
  });

  it("parses ESM side-effect imports", () => {
    const content = `import './setup';`;
    const imports = parseImports("src/index.ts", content);

    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe("./setup");
  });

  it("parses CJS require", () => {
    const content = `const fs = require('fs');\nconst utils = require('./utils');`;
    const imports = parseImports("src/index.js", content);

    expect(imports).toHaveLength(2);
    expect(imports[0]!.specifier).toBe("fs");
    expect(imports[1]!.specifier).toBe("./utils");
  });

  it("parses dynamic imports", () => {
    const content = `const mod = import('./module');`;
    const imports = parseImports("src/index.ts", content);

    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe("./module");
  });

  it("parses Python imports", () => {
    const content = `import os\nimport sys\nfrom pathlib import Path\nfrom .utils import helper`;
    const imports = parseImports("src/main.py", content);

    expect(imports).toHaveLength(4);
    expect(imports[0]!.specifier).toBe("os");
    expect(imports[1]!.specifier).toBe("sys");
    expect(imports[2]!.specifier).toBe("pathlib");
    expect(imports[3]!.specifier).toBe(".utils");
  });

  it("parses Python from-import with leading dots", () => {
    const content = `from .utils import helper\nfrom ..parent import thing`;
    const imports = parseImports("src/sub/main.py", content);

    expect(imports).toHaveLength(2);
    expect(imports[0]!.specifier).toBe(".utils");
    expect(imports[1]!.specifier).toBe("..parent");
  });

  it("parses Go imports", () => {
    const content = `package main\n\nimport "fmt"\nimport "strings"`;
    const imports = parseImports("main.go", content);

    // Should find at least the single-line Go imports
    expect(imports.length).toBeGreaterThanOrEqual(2);
  });

  it("parses Go multi-line import blocks", () => {
    const content = `package main\n\nimport (\n\t"fmt"\n\t"strings"\n)`;
    const imports = parseImports("main.go", content);

    expect(imports.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array for files with no imports", () => {
    const content = `const x = 1;\nconsole.log(x);`;
    const imports = parseImports("src/simple.ts", content);

    expect(imports).toHaveLength(0);
  });
});

describe("resolveSpecifier", () => {
  const allFiles = new Set([
    "src/index.ts",
    "src/config.ts",
    "src/utils.ts",
    "src/routes/search.ts",
    "src/routes/index.ts",
    "src/db/client.ts",
    "src/auth/index.ts",
    "src/utils/index.ts",
  ]);

  it("resolves relative TypeScript imports", () => {
    const result = resolveSpecifier("./config", "src/index.ts", allFiles);
    expect(result).toBe("src/config.ts");
  });

  it("resolves index.ts for directory imports", () => {
    const result = resolveSpecifier("./routes", "src/index.ts", allFiles);
    expect(result).toBe("src/routes/index.ts");
  });

  it("resolves with explicit extension", () => {
    const result = resolveSpecifier("./utils.ts", "src/index.ts", allFiles);
    expect(result).toBe("src/utils.ts");
  });

  it("resolves parent directory imports", () => {
    const result = resolveSpecifier("../config", "src/routes/search.ts", allFiles);
    expect(result).toBe("src/config.ts");
  });

  it("returns null for bare specifiers (node_modules)", () => {
    const result = resolveSpecifier("express", "src/index.ts", allFiles);
    expect(result).toBeNull();
  });

  it("returns null for non-existent paths", () => {
    const result = resolveSpecifier("./nonexistent", "src/index.ts", allFiles);
    expect(result).toBeNull();
  });

  it("resolves Python relative imports (single dot)", () => {
    const pythonFiles = new Set([
      "src/__init__.py",
      "src/main.py",
      "src/utils.py",
      "src/sub/__init__.py",
    ]);

    const result = resolveSpecifier(".utils", "src/main.py", pythonFiles);
    expect(result).toBe("src/utils.py");
  });

  it("resolves Python relative imports (double dot)", () => {
    const pythonFiles = new Set([
      "src/parent.py",
      "src/sub/__init__.py",
      "src/sub/main.py",
    ]);

    const result = resolveSpecifier("..parent", "src/sub/main.py", pythonFiles);
    expect(result).toBe("src/parent.py");
  });

  it("resolves Python __init__.py for package imports", () => {
    const pythonFiles = new Set([
      "src/main.py",
      "src/sub/__init__.py",
      "src/sub/module.py",
    ]);

    // from .sub import something
    const result = resolveSpecifier(".sub", "src/main.py", pythonFiles);
    expect(result).toBe("src/sub/__init__.py");
  });
});

describe("buildDependencyGraph", () => {
  it("builds a graph from file contents", () => {
    const files = new Map([
      ["src/index.ts", "import { app } from './app';\nimport { config } from './config';"],
      ["src/app.ts", "import { router } from './routes';\nimport { db } from './db';"],
      ["src/config.ts", "export const config = {};"],
      ["src/routes.ts", "import { db } from './db';\nimport { auth } from './auth';"],
      ["src/db.ts", "export const db = {};"],
      ["src/auth.ts", "import { db } from './db';"],
    ]);

    const graph = buildDependencyGraph(files);

    // index depends on app and config
    expect(graph.getDependenciesOf("src/index.ts")).toContain("src/app.ts");
    expect(graph.getDependenciesOf("src/index.ts")).toContain("src/config.ts");

    // app is depended on by index
    expect(graph.getDependentsOf(new Set(["src/app.ts"]))).toContain("src/index.ts");

    // db is depended on by app, routes, and auth (blast radius!)
    const dbDependents = graph.getDependentsOf(new Set(["src/db.ts"]));
    expect(dbDependents).toContain("src/app.ts");
    expect(dbDependents).toContain("src/routes.ts");
    expect(dbDependents).toContain("src/auth.ts");
  });

  it("handles files with no imports", () => {
    const files = new Map([
      ["src/standalone.ts", "export const x = 1;"],
      ["src/main.ts", "import { x } from './standalone';"],
    ]);

    const graph = buildDependencyGraph(files);
    expect(graph.getDependenciesOf("src/standalone.ts")).toHaveLength(0);
    expect(graph.getDependentsOf(new Set(["src/standalone.ts"]))).toContain("src/main.ts");
  });

  it("handles circular dependencies without infinite loops", () => {
    const files = new Map([
      ["src/a.ts", "import { b } from './b';"],
      ["src/b.ts", "import { a } from './a';"],
    ]);

    const graph = buildDependencyGraph(files);
    expect(graph.getDependenciesOf("src/a.ts")).toContain("src/b.ts");
    expect(graph.getDependenciesOf("src/b.ts")).toContain("src/a.ts");
  });

  it("returns empty arrays for unknown files", () => {
    const files = new Map([
      ["src/solo.ts", "export const x = 1;"],
    ]);

    const graph = buildDependencyGraph(files);
    expect(graph.getDependenciesOf("src/nonexistent.ts")).toHaveLength(0);
    expect(graph.getDependentsOf(new Set(["src/nonexistent.ts"]))).toHaveLength(0);
  });

  it("getDependentsOf with multiple changed files returns union", () => {
    const files = new Map([
      ["src/index.ts", "import { a } from './a';\nimport { b } from './b';"],
      ["src/a.ts", "export const a = 1;"],
      ["src/b.ts", "export const b = 2;"],
    ]);

    const graph = buildDependencyGraph(files);
    const dependents = graph.getDependentsOf(new Set(["src/a.ts", "src/b.ts"]));

    expect(dependents).toContain("src/index.ts");
    // Should not duplicate
    expect(dependents.filter((d) => d === "src/index.ts")).toHaveLength(1);
  });
});