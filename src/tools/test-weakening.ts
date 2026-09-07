import type { DeterministicFinding } from "./runner.js";

const ASSERTION = /\b(?:expect|assert|require|should)\s*\(/;
const SKIP_MARKER = /(?:\.skip\b|\bx(?:it|describe)\b|@Disabled\b|pytest\.mark\.skip\b|\b(?:test|it)\.skip\b)/;

interface DiffLine {
  kind: "added" | "removed";
  file: string;
  oldLine: number;
  newLine: number;
  text: string;
}

function finding(
  title: string,
  location: DiffLine | undefined,
  snippet: string,
  ruleId: string,
  severity = "high",
  fallbackFile = "",
): DeterministicFinding {
  const line = location?.kind === "removed" ? location.oldLine : location?.newLine ?? 0;
  return {
    title,
    severity,
    category: "test-quality",
    file: location?.file || fallbackFile,
    line,
    snippet: snippet.trim(),
    source: "test_weakening",
    ruleId,
  };
}

function parseDiffLines(diff: string): DiffLine[] {
  const changedLines: DiffLine[] = [];
  let file = "";
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (header) {
      file = header[2] ?? "";
      continue;
    }

    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      if (path !== "/dev/null") {
        file = path.startsWith("b/") ? path.slice(2) : path;
      }
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1]!, 10);
      newLine = Number.parseInt(hunk[3]!, 10);
      continue;
    }

    if (!file || oldLine < 0 || newLine < 0 || line.startsWith("\\")) {
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      changedLines.push({ kind: "removed", file, oldLine, newLine, text: line.slice(1) });
      oldLine++;
    } else if (line.startsWith("+")) {
      changedLines.push({ kind: "added", file, oldLine, newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith(" ")) {
      oldLine++;
      newLine++;
    }
  }

  // Keep the detector useful for callers that provide only a small change
  // snippet rather than a complete git patch. Complete patches still get
  // precise file/line locations from their hunk metadata.
  if (changedLines.length === 0) {
    return diff.split(/\r?\n/).flatMap((line): DiffLine[] => {
      if (line.startsWith("-") && !line.startsWith("---")) {
        return [{ kind: "removed", file: "", oldLine: 0, newLine: 0, text: line.slice(1) }];
      }
      if (line.startsWith("+")) {
        return [{ kind: "added", file: "", oldLine: 0, newLine: 0, text: line.slice(1) }];
      }
      return [];
    });
  }

  return changedLines;
}

/** Detect common test-weakening edits introduced by the current diff. */
export function detectTestWeakening(diff: string, deletedFiles: string[] = []): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  const changedLines = parseDiffLines(diff);
  const removed = changedLines.filter((line) => line.kind === "removed");
  const added = changedLines.filter((line) => line.kind === "added");

  const removedAssertions = removed.filter((line) => ASSERTION.test(line.text));
  if (removedAssertions.length > 0 && removedAssertions.length > added.filter((line) => ASSERTION.test(line.text)).length) {
    findings.push(finding("Test assertions were removed", removedAssertions[0], removedAssertions[0]!.text, "deleted-assertion"));
  }

  for (const line of added) {
    if (SKIP_MARKER.test(line.text)) {
      findings.push(finding("A test skip marker was added", line, line.text, "added-skip-marker", "medium"));
    }
  }

  const matcherPairs: Array<[RegExp, RegExp, string]> = [
    [/\.toBe\(/, /\.toBeTruthy\(/, "exact-to-truthy"],
    [/\.toEqual\(/, /\.toMatchObject\(/, "exact-to-partial"],
    [/\.toBeCloseTo\(/, /\.toBeGreaterThan\(/, "close-to-range"],
  ];

  // Correlation rules (loosened matcher, commented-out test body) must fire
  // WITHIN A SINGLE FILE. Grouping changed lines by file prevents the
  // cross-file false positive where a removed `it()` in one file and an
  // added `//` comment in another file trip a HIGH "test body replaced with
  // comments" finding pointing at the unrelated comment.
  const byFile = new Map<string, { removed: DiffLine[]; added: DiffLine[] }>();
  for (const line of changedLines) {
    let bucket = byFile.get(line.file);
    if (!bucket) {
      bucket = { removed: [], added: [] };
      byFile.set(line.file, bucket);
    }
    (line.kind === "removed" ? bucket.removed : bucket.added).push(line);
  }

  for (const { removed: rem, added: add } of byFile.values()) {
    for (const [strict, loose, ruleId] of matcherPairs) {
      if (rem.some((line) => strict.test(line.text)) && add.some((line) => loose.test(line.text))) {
        const looseLine = add.find((line) => loose.test(line.text));
        findings.push(finding("A test matcher was loosened", looseLine, looseLine?.text ?? "", ruleId));
      }
    }

    const removedTest = rem.find((line) => /\b(?:it|test)\s*\(/.test(line.text));
    const addedComment = add.find((line) => /^\s*\/\//.test(line.text));
    if (removedTest && addedComment) {
      findings.push(finding("A test body was replaced with comments", addedComment, addedComment.text, "commented-test-body"));
    }
  }

  for (const file of deletedFiles) {
    if (/(?:\.test\.|\.spec\.|(?:^|\/)test_[^/]+\.)/.test(file)) {
      const location = removed.find((line) => line.file === file);
      findings.push(finding("A test file was removed", location, file, "deleted-test-file", "high", file));
    }
  }

  return findings;
}
