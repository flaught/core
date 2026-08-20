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

  return `### Summary\n\n${lines.join("\n")}\n\n${sourceLines.join(" · ")}`;
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