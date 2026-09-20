import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolvePrIntent,
  buildIntentProvenance,
  appearsTitleOnly,
  warnOnSparseIntent,
} from "./intent.js";

function withTempFile(content: string, fn: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-intent-"));
  const filePath = path.join(dir, "pr-intent.txt");
  fs.writeFileSync(filePath, content, "utf-8");
  try {
    fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("resolvePrIntent (GH#86)", () => {
  it("returns undefined when neither option is given", () => {
    const result = resolvePrIntent({});
    expect(result.text).toBeUndefined();
    expect(result.source).toBeUndefined();
  });

  it("passes inline --pr-description text through verbatim", () => {
    const result = resolvePrIntent({ prDescription: "Fix auth retry" });
    expect(result.text).toBe("Fix auth retry");
    expect(result.source).toBe("cli-text");
  });

  it("reads --pr-description-file verbatim, preserving multiline text, quotes, and literal shell metacharacters", () => {
    // Acceptance criterion: "Tests preserve multiline text, quotes and
    // literal shell metacharacters safely." The file's content is DATA —
    // it must arrive unchanged and is never executed or interpolated.
    const hostile = [
      "docs: fix push notifications",
      "",
      "## Why",
      "",
      "We don't retry `APNs` sends; the \"on call\" runbook said we'd $(rm -rf /) — literal text, not a command.",
      "Also acceptable: `echo hi > /tmp/x` as a *documented example* only.",
      "",
      "## Acceptance",
      "- [ ] adds scripts/diagnostics/push_probe.py",
    ].join("\n");

    withTempFile(hostile, (filePath) => {
      const result = resolvePrIntent({ prDescriptionFile: filePath });
      expect(result.text).toBe(hostile);
      expect(result.source).toBe("cli-file");
    });
  });

  it("rejects --pr-description AND --pr-description-file together (ambiguous intent fails loudly)", () => {
    withTempFile("x", (filePath) => {
      expect(() =>
        resolvePrIntent({ prDescription: "inline", prDescriptionFile: filePath }),
      ).toThrow(/either --pr-description <text> or --pr-description-file <path>/);
    });
  });

  it("fails loudly when the intent file is missing", () => {
    expect(() =>
      resolvePrIntent({ prDescriptionFile: "/nonexistent/dir/intent.txt" }),
    ).toThrow(/Could not read --pr-description-file/);
  });
});

describe("buildIntentProvenance / appearsTitleOnly (GH#86)", () => {
  it("records source, size, and title-only-ness WITHOUT the text itself", () => {
    const text = "docs: fix push notifications";
    const prov = buildIntentProvenance(text, "cli-text");
    expect(prov).toEqual({
      source: "cli-text",
      chars: text.length,
      lines: 1,
      appears_title_only: true,
    });
    // Provenance must not leak the text the artifact already stores (or not)
    expect(JSON.stringify(prov)).not.toContain("docs");
  });

  it("a multiline body is never 'title-only'", () => {
    expect(appearsTitleOnly("Fix auth\n\n## Why\n\nDetailed explanation.")).toBe(false);
  });

  it("a single long line is not treated as title-only", () => {
    expect(appearsTitleOnly("x".repeat(200))).toBe(false);
  });

  it("a short single line IS title-only", () => {
    expect(appearsTitleOnly("docs: fix runbook")).toBe(true);
  });

  it("trailing blank lines do not rescue a title-only intent", () => {
    expect(appearsTitleOnly("docs: fix runbook\n\n")).toBe(true);
  });
});

describe("warnOnSparseIntent (GH#86)", () => {
  it("warns when NO intent is provided but scope-creep detection is on", () => {
    const messages: string[] = [];
    warnOnSparseIntent((m) => messages.push(m), true, true, undefined);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("WITHOUT an intent anchor");
  });

  it("warns when the intent looks title-only", () => {
    const messages: string[] = [];
    warnOnSparseIntent((m) => messages.push(m), true, true, "docs: fix runbook");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("title-only");
    expect(messages[0]).toContain("GH#86");
  });

  it("stays silent for a full-body intent", () => {
    const messages: string[] = [];
    warnOnSparseIntent(
      (m) => messages.push(m),
      true,
      true,
      "docs: fix push notifications\n\n## Why\n\nThe body authorizes the work — no warning.",
    );
    expect(messages).toHaveLength(0);
  });

  it("never warns when scope-creep detection is disabled", () => {
    const messages: string[] = [];
    warnOnSparseIntent((m) => messages.push(m), false, true, undefined);
    expect(messages).toHaveLength(0);
  });

  it("never warns when the LLM pass is skipped (no scope-creep LLM layer runs)", () => {
    const messages: string[] = [];
    warnOnSparseIntent((m) => messages.push(m), true, false, undefined);
    expect(messages).toHaveLength(0);
  });
});
