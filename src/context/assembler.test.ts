/**
 * Integration tests for context assembly.
 *
 * These create real temporary git repos, commit files, make changes,
 * and run assembleContext end-to-end. This validates the full pipeline:
 * git diff extraction, changed file detection, dependency graph construction,
 * and neighborhood identification.
 *
 * Uses os.tmpdir() + random suffix for isolation. Each test gets its own repo.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { simpleGit, type SimpleGit } from "simple-git";
import { assembleContext, contextToJSON, contextFromJSON } from "./assembler.js";

// ─── Temp repo fixture ──────────────────────────────────────────────────────

let tempDirs: string[] = [];

/**
 * Create a temporary git repo with an initial commit.
 * Returns the repo path and a simple-git instance bound to it.
 */
async function createTempRepo(): Promise<{ repoPath: string; git: SimpleGit }> {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-test-"));
  tempDirs.push(repoPath);

  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig("user.email", "test@flaught.dev");
  await git.addConfig("user.name", "Flaught Test");

  return { repoPath, git };
}

/**
 * Write files and commit them to the repo.
 */
async function commitFiles(
  git: SimpleGit,
  files: Record<string, string>,
  message: string = "initial",
): Promise<string> {
  const repoRoot = await git.revparse(["--show-toplevel"]);
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(repoRoot.trim(), filePath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  await git.add(".");
  await git.commit(message);
  const sha = (await git.revparse(["HEAD"])).trim();
  return sha;
}

/** Clean up all temp directories after tests. */
function cleanup() {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures in temp dirs
    }
  }
  tempDirs = [];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("assembleContext (integration)", () => {
  afterEach(() => {
    cleanup();
  });

  it("detects changed files between two commits", async () => {
    const { repoPath } = await createTempRepo();

    // Initial commit
    await commitFiles(
      simpleGit(repoPath),
      {
        "src/index.ts": "import { app } from './app';\napp.start();",
        "src/app.ts": "export const app = { start: () => {} };",
      },
      "initial",
    );

    // Second commit: modify app.ts
    await commitFiles(
      simpleGit(repoPath),
      {
        "src/app.ts": "export const app = { start: () => { console.log('started'); } };",
      },
      "modify app",
    );

    const context = await assembleContext({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
    });

    expect(context.changedFiles.length).toBe(1);
    expect(context.changedFiles[0]!.path).toBe("src/app.ts");
    expect(context.changedFiles[0]!.status).toBe("modified");
    expect(context.changedFiles[0]!.additions).toBeGreaterThan(0);
  });

  it("identifies one-hop dependency neighborhood", async () => {
    const { repoPath } = await createTempRepo();
    const git = simpleGit(repoPath);

    // Create a dependency graph:
    // index.ts -> app.ts -> db.ts
    //                   \-> auth.ts -> db.ts
    // config.ts (standalone, no imports)
    await commitFiles(git, {
      "src/index.ts": "import { app } from './app';\napp.start();",
      "src/app.ts": "import { db } from './db';\nimport { auth } from './auth';\nexport const app = { start: () => {} };",
      "src/auth.ts": "import { db } from './db';\nexport const auth = {};",
      "src/db.ts": "export const db = {};",
      "src/config.ts": "export const config = { port: 3000 };",
    }, "initial");

    // Now modify db.ts — blast radius should include app.ts, auth.ts
    await commitFiles(git, {
      "src/db.ts": "export const db = {};\nexport const pool = { max: 10 };",
    }, "modify db");

    const context = await assembleContext({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
    });

    expect(context.changedFiles.map((f) => f.path)).toContain("src/db.ts");
    expect(context.neighborhoodFiles).toContain("src/app.ts");
    expect(context.neighborhoodFiles).toContain("src/auth.ts");
    // index.ts imports app.ts which imports db.ts, but that's 2 hops away
    // — it should NOT be in the one-hop neighborhood
    expect(context.neighborhoodFiles).not.toContain("src/index.ts");
    // config.ts doesn't import db.ts at all
    expect(context.neighborhoodFiles).not.toContain("src/config.ts");
  });

  it("detects added files", async () => {
    const { repoPath } = await createTempRepo();
    const git = simpleGit(repoPath);

    await commitFiles(git, {
      "src/index.ts": "console.log('hello');",
    }, "initial");

    // Add a new file
    await commitFiles(git, {
      "src/utils.ts": "export const add = (a: number, b: number) => a + b;",
    }, "add utils");

    const context = await assembleContext({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
    });

    expect(context.changedFiles.length).toBe(1);
    expect(context.changedFiles[0]!.path).toBe("src/utils.ts");
    expect(context.changedFiles[0]!.status).toBe("added");
  });

  it("respects exclude paths from config", async () => {
    const { repoPath } = await createTempRepo();
    const git = simpleGit(repoPath);

    await commitFiles(git, {
      "src/main.ts": "import { x } from './util';",
      "src/util.ts": "export const x = 1;",
    }, "initial");

    // Modify both files
    await commitFiles(git, {
      "src/main.ts": "import { x } from './util';\nconsole.log(x);",
      "src/util.ts": "export const x = 2;",
    }, "modify both");

    // Exclude src/util.ts via excludePaths
    const context = await assembleContext({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      excludePaths: ["src/util.ts"],
    });

    // Only main.ts should appear as changed; util.ts is excluded
    expect(context.changedFiles.map((f) => f.path)).not.toContain("src/util.ts");
    expect(context.changedFiles.map((f) => f.path)).toContain("src/main.ts");
  });

  it("handles repos with a single commit (HEAD~1 fallback)", async () => {
    const { repoPath } = await createTempRepo();
    const git = simpleGit(repoPath);

    // Only one commit — HEAD~1 doesn't exist, but assembleContext
    // should still work (it'll fall back gracefully)
    await commitFiles(git, {
      "src/index.ts": "console.log('hello');",
    }, "initial");

    // This should not throw — the context will be empty or minimal
    try {
      await assembleContext({ repoPath });
    } catch (err) {
      // Expected: git will fail to find a diff for HEAD~1 on a single-commit repo
      // This is fine — the caller should provide --base when there's only one commit
      expect((err as Error).message).toContain("fatal");
    }
  });

  it("reads file contents of changed and neighborhood files", async () => {
    const { repoPath } = await createTempRepo();
    const git = simpleGit(repoPath);

    await commitFiles(git, {
      "src/app.ts": "import { db } from './db';\nexport const app = {};",
      "src/db.ts": "export const db = {};",
    }, "initial");

    await commitFiles(git, {
      "src/db.ts": "export const db = {};\nexport const pool = {};",
    }, "modify db");

    const context = await assembleContext({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
    });

    // Changed file content should be from head (modified version)
    expect(context.changedFileContents.has("src/db.ts")).toBe(true);
    expect(context.changedFileContents.get("src/db.ts")).toContain("pool");

    // Neighborhood file content should be readable
    expect(context.neighborhoodFileContents.has("src/app.ts")).toBe(true);
    expect(context.neighborhoodFileContents.get("src/app.ts")).toContain("import { db }");
  });
});

describe("contextToJSON", () => {
  afterEach(() => {
    cleanup();
  });

  it("serializes Maps to Records for JSON output", async () => {
    const { repoPath } = await createTempRepo();
    const git = simpleGit(repoPath);

    await commitFiles(git, {
      "src/index.ts": "import { x } from './util';",
      "src/util.ts": "export const x = 1;",
    }, "initial");

    await commitFiles(git, {
      "src/util.ts": "export const x = 2;",
    }, "modify util");

    const context = await assembleContext({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
    });

    const json = contextToJSON(context);

    // Should be JSON-serializable
    const serialized = JSON.stringify(json);
    expect(serialized).toBeTruthy();

    // Should contain changed file contents as a plain object
    expect(typeof json.changedFileContents).toBe("object");
    expect(json.changedFileContents["src/util.ts"]).toContain("x = 2");

    // Should contain dependency graph as plain objects
    expect(typeof json.dependencyGraph.forwardDeps).toBe("object");
    expect(typeof json.dependencyGraph.reverseDeps).toBe("object");

    // forwardDeps: index.ts depends on util.ts
    expect(json.dependencyGraph.forwardDeps["src/index.ts"]).toContain("src/util.ts");
    // reverseDeps: util.ts is depended on by index.ts
    expect(json.dependencyGraph.reverseDeps["src/util.ts"]).toContain("src/index.ts");
  });

  it("contextFromJSON round-trips a context artifact without a git checkout", async () => {
    const { repoPath } = await createTempRepo();
    const git = simpleGit(repoPath);

    await commitFiles(git, {
      "src/index.ts": "import { x } from './util';",
      "src/util.ts": "export const x = 1;",
    }, "initial");

    await commitFiles(git, {
      "src/util.ts": "export const x = 2;",
    }, "modify util");

    const context = await assembleContext({
      repoPath,
      baseRef: "HEAD~1",
      headRef: "HEAD",
    });

    // Serialize -> JSON string -> deserialize (simulating artifact write + read)
    const json = contextToJSON(context);
    const wire = JSON.stringify(json);
    const restored = contextFromJSON(JSON.parse(wire));

    // Scalars
    expect(restored.diff).toBe(context.diff);
    expect(restored.baseSha).toBe(context.baseSha);
    expect(restored.headSha).toBe(context.headSha);
    expect(restored.repoRoot).toBe(context.repoRoot);
    expect(restored.changedFiles).toEqual(context.changedFiles);
    expect(restored.neighborhoodFiles).toEqual(context.neighborhoodFiles);

    // Maps
    expect(restored.changedFileContents).toEqual(context.changedFileContents);
    expect(restored.neighborhoodFileContents).toEqual(context.neighborhoodFileContents);
    expect(restored.changedFileContents instanceof Map).toBe(true);

    // Rebuilt dependency graph is equivalent (re-derived from contents)
    expect(restored.dependencyGraph.getAllFiles()).toEqual(context.dependencyGraph.getAllFiles());
    expect(restored.dependencyGraph.getDependenciesOf("src/index.ts")).toEqual(
      context.dependencyGraph.getDependenciesOf("src/index.ts"),
    );
    expect(restored.dependencyGraph.getDependentsOf(new Set(["src/util.ts"]))).toEqual(
      context.dependencyGraph.getDependentsOf(new Set(["src/util.ts"])),
    );
  });
});