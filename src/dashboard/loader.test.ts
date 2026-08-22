import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { findJsonFiles, loadJsonFiles } from "./loader.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-dashboard-"));
  tempDirs.push(dir);
  return dir;
}

describe("findJsonFiles", () => {
  it("finds JSON files recursively", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "a.json"), "{}");
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "nested", "b.json"), "{}");
    fs.writeFileSync(path.join(dir, "not-json.txt"), "hi");

    const files = findJsonFiles(dir).sort();
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith("a.json"))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join("nested", "b.json")))).toBe(true);
  });

  it("returns an empty array for a directory that doesn't exist", () => {
    expect(findJsonFiles("/nonexistent/path/for/sure")).toEqual([]);
  });
});

describe("loadJsonFiles", () => {
  it("parses valid JSON files and skips invalid ones instead of throwing", () => {
    const dir = makeTempDir();
    const goodPath = path.join(dir, "good.json");
    const badPath = path.join(dir, "bad.json");
    fs.writeFileSync(goodPath, JSON.stringify({ hello: "world" }));
    fs.writeFileSync(badPath, "{ not valid json");

    const parsed = loadJsonFiles([goodPath, badPath]);
    expect(parsed).toEqual([{ hello: "world" }]);
  });

  it("skips unreadable file paths without throwing", () => {
    expect(() => loadJsonFiles(["/nonexistent/file.json"])).not.toThrow();
    expect(loadJsonFiles(["/nonexistent/file.json"])).toEqual([]);
  });
});
