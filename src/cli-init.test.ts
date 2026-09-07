import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";

const originalArgv = process.argv;
const tempDirs: string[] = [];

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("flaught init", () => {
  it.each([false, true])("scaffolds config and prompts with paranoid=%s", async (paranoid) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-cli-init-"));
    tempDirs.push(dir);
    process.argv = [process.execPath, "flaught", "init", "--dir", dir];
    if (paranoid) process.argv.push("--paranoid");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Unexpected CLI exit: ${code}`);
    });
    vi.resetModules();

    await import("./cli.js");

    const raw = yaml.load(fs.readFileSync(path.join(dir, ".advreview.yml"), "utf-8"));
    if (paranoid) {
      expect(raw).toHaveProperty("tools.semgrep.enabled", true);
      expect(raw).toHaveProperty("severity_gate.fail_on", "high");
    } else {
      expect(raw).not.toHaveProperty("tools");
    }
    expect(raw).toHaveProperty("llm.provider", "groq");
    expect(fs.existsSync(path.join(dir, ".flaught-prompt", "system-append.md.example"))).toBe(true);
    expect(console.log).toHaveBeenCalledWith(`Created ${path.join(dir, ".advreview.yml")}`);
  });
});
