/**
 * Markdown report renderer — produces a PR comment with sections collapsed by severity.
 *
 * Design principles:
 * - Severity-ordered: critical findings are at the top, info at the bottom
 * - Each severity section can be collapsed in GitHub (<details>)
 * - The caveat is always present at the top
 * - Dismissed findings are shown struck-through with dismissal reason
 */

import type { FindingsArtifact, Finding, Severity } from "../schemas/findings.js";
import { CAVEAT } from "../schemas/findings.js";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
  info: "⚪",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  info: "INFO",
};

export function renderMarkdownReport(artifact: FindingsArtifact): string {
  const sections: string[] = [];

  // Header
  sections.push(renderHeader(artifact));

  // Caveat
  sections.push(renderCaveat());

  // Summary
  sections.push(renderSummary(artifact));

  // Tool execution warnings (a tool that didn't run is not the same as a
  // tool that ran clean — both report 0 findings for that tool otherwise)
  const toolsWarning = renderToolsWarning(artifact);
  if (toolsWarning) sections.push(toolsWarning);

  // Findings by severity
  for (const severity of SEVERITY_ORDER) {
    const findings = artifact.findings.filter((f) => f.severity === severity);
    if (findings.length === 0) continue;

    const budget = artifact.noise_budget[severity];
    const collapsed = severity === "info" || severity === "low";

    sections.push(renderSeveritySection(severity, findings, budget.used, budget.limit, collapsed));
  }

  // No findings
  if (artifact.findings.length === 0) {
    sections.push("\n✅ **No findings.** The adversarial review found no issues worth flagging at the configured noise budget.");
  }

  // Footer
  sections.push(renderFooter(artifact));

  return sections.join("\n\n");
}

function renderHeader(_artifact: FindingsArtifact): string {
  return `## 🔍 Flaught — Adversarial Code Review`;
}

function renderCaveat(): string {
  return `> ⚠️ ${CAVEAT}`;
}

/**
 * A tool that failed to run at all (not found, crashed, etc.) reports 0
 * findings the same as a tool that ran and genuinely found nothing --
 * `command: "(failed)"` is the only signal distinguishing the two, and
 * nothing surfaced it in the human-facing report before this. Silent 0
 * findings reads as "clean scan"; this makes "didn't actually scan" visible
 * instead, in the same place a reader already checks for the review's
 * findings.
 */
function renderToolsWarning(artifact: FindingsArtifact): string | null {
  // renderMarkdownReport is re-exported as public API (src/index.ts) -- an
  // external caller can hand it a hand-built or pre-this-feature JSON
  // artifact where tools_executed is missing or malformed, not just the
  // always-populated artifact review.ts constructs internally.
  if (!Array.isArray(artifact.tools_executed)) return null;

  const failed = artifact.tools_executed.filter((t) => t.command === "(failed)");
  if (failed.length === 0) return null;

  const lines = [
    `> ⚠️ **${failed.length} deterministic tool(s) did not run** — their findings below are 0 because the tool itself failed to execute (not found, crashed, or timed out), not because the scan came back clean:`,
    ...failed.map((t) => `> - \`${t.tool}\` — not run (is it installed and on \`PATH\`?)`),
  ];
  return lines.join("\n");
}

function renderSummary(artifact: FindingsArtifact): string {
  const s = artifact.summary;
  const lines = [
    `| Severity | Count | Budget |`,
    `| --- | --- | --- |`,
  ];

  for (const sev of SEVERITY_ORDER) {
    const budget = artifact.noise_budget[sev];
    const emoji = SEVERITY_EMOJI[sev];
    lines.push(
      `| ${emoji} ${SEVERITY_LABEL[sev]} | ${s.by_severity[sev]} | ${budget.used}/${budget.limit} |`,
    );
  }

  lines.push(`| **Total** | **${s.total_findings}** | |`);

  // Source breakdown
  const sourceLines: string[] = [];
  if (s.by_source_type.llm > 0) {
    sourceLines.push(`🤖 LLM-asserted: ${s.by_source_type.llm}`);
  }
  if (s.by_source_type.deterministic > 0) {
    sourceLines.push(`🔧 Deterministic: ${s.by_source_type.deterministic}`);
  }

  // Refute pass breakdown
  const refuteLines: string[] = [];
  const confirmed = artifact.findings.filter((f) => f.refute_result?.verdict === "confirmed").length;
  const refuted = artifact.findings.filter((f) => f.refute_result?.verdict === "refuted").length;
  const uncertain = artifact.findings.filter((f) => f.refute_result?.verdict === "uncertain").length;
  if (confirmed + refuted + uncertain > 0) {
    refuteLines.push(`🔍 Skeptic: ${confirmed} confirmed, ${refuted} refuted, ${uncertain} uncertain`);
  }

  return `### Summary\n\n${lines.join("\n")}\n\n${sourceLines.join(" · ")}${refuteLines.length > 0 ? "\n" + refuteLines.join(" · ") : ""}`;
}

function renderSeveritySection(
  severity: Severity,
  findings: Finding[],
  used: number,
  limit: number,
  collapsed: boolean,
): string {
  const emoji = SEVERITY_EMOJI[severity];
  const label = SEVERITY_LABEL[severity];
  const title = `### ${emoji} ${label} (${used}/${limit})`;

  const findingLines = findings.map((f) => renderFinding(f)).join("\n\n");

  if (collapsed) {
    return `${title}\n\n<details>\n<summary>Click to expand</summary>\n\n${findingLines}\n\n</details>`;
  }

  return `${title}\n\n${findingLines}`;
}

function renderFinding(f: Finding): string {
  const lines: string[] = [];

  // Title and source type badge
  const sourceBadge = f.source_type === "llm" ? "🤖" : "🔧";
  const dismissedTag = f.dismissed ? ` ~~*DISMISSED*~~` : "";
  lines.push(`**${f.id}**: ${f.title} ${sourceBadge}${dismissedTag}`);

  // Description
  lines.push(f.description);

  // Evidence
  if (f.evidence.file) {
    // For vuln findings (line 0, no meaningful line number), show just the package/path
    if (f.evidence.line_start === 0 && f.evidence.line_end === 0) {
      lines.push(`📍 \`${f.evidence.file}\``);
    } else if (f.evidence.line_start === f.evidence.line_end) {
      lines.push(`📍 \`${f.evidence.file}:${f.evidence.line_start}\``);
    } else {
      lines.push(`📍 \`${f.evidence.file}:${f.evidence.line_start}-${f.evidence.line_end}\``);
    }
  }

  if (f.evidence.snippet) {
    lines.push(`\`\`\`\n${f.evidence.snippet}\n\`\`\``);
  }

  // Blast radius
  if (f.evidence.blast_radius.length > 0) {
    lines.push(`💥 Blast radius: ${f.evidence.blast_radius.map((r) => `\`${r}\``).join(", ")}`);
  }

  // Confidence
  lines.push(`Confidence: ${Math.round(f.confidence * 100)}%`);

  // Refute result
  if (f.refute_result) {
    const verdictEmoji: Record<string, string> = {
      confirmed: "✅",
      refuted: "❌",
      uncertain: "❓",
    };
    const emoji = verdictEmoji[f.refute_result.verdict] ?? "";
    const verdictLabel = f.refute_result.verdict.charAt(0).toUpperCase() + f.refute_result.verdict.slice(1);
    lines.push(`${emoji} Skeptic: ${verdictLabel}${f.refute_result.reasoning ? ` — ${f.refute_result.reasoning}` : ""}`);
  }

  // Dismissal
  if (f.dismissed) {
    lines.push(`Dismissed by ${f.dismissed_by} at ${f.dismissed_at}: ${f.dismissal_reason}`);
  }

  // References
  if (f.references.length > 0) {
    lines.push(`Refs: ${f.references.join(", ")}`);
  }

  return lines.join("\n");
}

function renderFooter(artifact: FindingsArtifact): string {
  return [
    "---",
    `*Flaught v${artifact.flaught_version} · Schema v${artifact.schema_version} · ${artifact.generated_at}*`,
  ].join("\n");
}