import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDashboard } from "./command.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-dashboard-command-"));
  tempDirs.push(dir);
  return dir;
}

describe("runDashboard", () => {
  it("fails with an actionable message without writing an empty dashboard", () => {
    const input = makeTempDir();
    const output = path.join(input, "dashboard.html");

    expect(() => runDashboard({ input, output })).toThrow(
      `No findings artifacts found under ${input}. ` +
        `Populate it with \`gh run download -n flaught-findings -D "${input}"\` first; ` +
        "`flaught dashboard` reads them recursively.",
    );
    expect(fs.existsSync(output)).toBe(false);
  });

  it("does not overwrite an existing output when JSON files are not findings artifacts", () => {
    const input = makeTempDir();
    const output = path.join(input, "dashboard.html");
    fs.writeFileSync(path.join(input, "unrelated.json"), JSON.stringify({ hello: "world" }));
    fs.writeFileSync(output, "existing dashboard");

    expect(() => runDashboard({ input, output })).toThrow("No findings artifacts found");
    expect(fs.readFileSync(output, "utf-8")).toBe("existing dashboard");
  });

  it("renders a valid artifact even when that review contains zero findings", () => {
    const input = makeTempDir();
    const output = path.join(input, "dashboard.html");
    fs.writeFileSync(
      path.join(input, "findings.json"),
      JSON.stringify({
        generated_at: "2026-08-23T00:00:00Z",
        repository: { name: "flaught/core" },
        pull_request: { number: 27, title: "Empty findings" },
        run: { id: "run-27", llm_error: null },
        summary: {
          total_findings: 0,
          by_severity: {},
          by_source_type: {},
          dismissed_count: 0,
        },
        findings: [],
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    runDashboard({ input, output });

    const html = fs.readFileSync(output, "utf-8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("#27 — Empty findings");
  });
});
