/**
 * Renders a self-contained static HTML dashboard from a trend series.
 * No external requests, no build step — open the file in a browser.
 */

import type { TrendPoint } from "./trends.js";
import { SEVERITIES } from "./trends.js";
import type { Severity } from "../schemas/findings.js";

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#dc2626",
  high: "#ea580c",
  medium: "#ca8a04",
  low: "#2563eb",
  info: "#6b7280",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

/**
 * A minimal multi-series line chart, hand-rolled in SVG. Each series is
 * plotted against point index (not wall-clock time) so runs are evenly
 * spaced regardless of gaps between them — trend shape matters more here
 * than precise time-axis spacing for a "simple" dashboard.
 */
function renderLineChart(points: TrendPoint[]): string {
  const width = 760;
  const height = 260;
  const padding = { top: 16, right: 16, bottom: 28, left: 36 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const maxY = Math.max(1, ...points.map((p) => p.total_findings));
  const xStep = points.length > 1 ? plotW / (points.length - 1) : 0;

  const x = (i: number) => padding.left + i * xStep;
  const y = (v: number) => padding.top + plotH - (v / maxY) * plotH;

  function seriesPath(values: number[]): string {
    return values
      .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join(" ");
  }

  const totalPath = seriesPath(points.map((p) => p.total_findings));
  const severityPaths = SEVERITIES.map((sev) => ({
    sev,
    path: seriesPath(points.map((p) => p.by_severity[sev])),
  }));

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
    const yy = padding.top + plotH - frac * plotH;
    return `<line x1="${padding.left}" y1="${yy.toFixed(1)}" x2="${width - padding.right}" y2="${yy.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>`;
  }).join("\n    ");

  const xLabels = points
    .map((p, i) => {
      // Thin labels out so they don't overlap on longer series.
      const showEvery = Math.max(1, Math.ceil(points.length / 8));
      if (i % showEvery !== 0 && i !== points.length - 1) return "";
      return `<text x="${x(i).toFixed(1)}" y="${height - 6}" font-size="10" fill="#6b7280" text-anchor="middle">${escapeHtml(formatDate(p.generated_at))}</text>`;
    })
    .join("\n    ");

  const dots = points
    .map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.total_findings).toFixed(1)}" r="3" fill="#111827"/>`)
    .join("\n    ");

  return `
  <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Findings over time">
    ${gridLines}
    ${severityPaths.map(({ sev, path }) => `<path d="${path}" fill="none" stroke="${SEVERITY_COLOR[sev]}" stroke-width="1.5" opacity="0.6"/>`).join("\n    ")}
    <path d="${totalPath}" fill="none" stroke="#111827" stroke-width="2"/>
    ${dots}
    ${xLabels}
  </svg>`;
}

function renderLegend(): string {
  const items = [
    { label: "Total", color: "#111827" },
    ...SEVERITIES.map((sev) => ({ label: sev, color: SEVERITY_COLOR[sev] })),
  ];
  return `<div class="legend">${items
    .map((i) => `<span class="legend-item"><span class="swatch" style="background:${i.color}"></span>${escapeHtml(i.label)}</span>`)
    .join("")}</div>`;
}

function renderStats(points: TrendPoint[]): string {
  const latest = points[points.length - 1];
  const avg = points.length > 0
    ? (points.reduce((sum, p) => sum + p.total_findings, 0) / points.length).toFixed(1)
    : "0";
  const llmFailures = points.filter((p) => p.llm_error).length;

  const stats = [
    { label: "Runs", value: String(points.length) },
    { label: "Latest run findings", value: latest ? String(latest.total_findings) : "—" },
    { label: "Avg findings / run", value: avg },
    { label: "Runs with LLM failure", value: String(llmFailures) },
  ];

  return `<div class="stats">${stats
    .map((s) => `<div class="stat"><div class="stat-value">${escapeHtml(s.value)}</div><div class="stat-label">${escapeHtml(s.label)}</div></div>`)
    .join("")}</div>`;
}

function renderTable(points: TrendPoint[]): string {
  const rows = [...points]
    .reverse()
    .map((p) => {
      const prLabel = p.pr_number ? `#${p.pr_number}${p.pr_title ? ` — ${escapeHtml(p.pr_title)}` : ""}` : "—";
      const sevCells = SEVERITIES.map((sev) => `<td style="color:${SEVERITY_COLOR[sev]}">${p.by_severity[sev]}</td>`).join("");
      return `<tr>
        <td>${escapeHtml(formatDate(p.generated_at))}</td>
        <td>${escapeHtml(p.repository)}</td>
        <td>${prLabel}</td>
        <td>${p.total_findings}</td>
        ${sevCells}
        <td>${p.by_source_type.llm} / ${p.by_source_type.deterministic}</td>
        <td>${p.refute.confirmed} / ${p.refute.refuted} / ${p.refute.uncertain}</td>
        <td>${p.dismissed_count}</td>
        <td>${p.llm_error ? "⚠️" : ""}</td>
      </tr>`;
    })
    .join("\n");

  return `<table>
    <thead>
      <tr>
        <th>Date</th><th>Repo</th><th>PR</th><th>Total</th>
        ${SEVERITIES.map((s) => `<th>${s}</th>`).join("")}
        <th>LLM/Det</th><th>Skeptic C/R/U</th><th>Dismissed</th><th>LLM error</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function renderDashboardHtml(points: TrendPoint[]): string {
  const body = points.length === 0
    ? `<p class="empty">No findings artifacts were found at the given input path.</p>`
    : `${renderStats(points)}
      ${renderLineChart(points)}
      ${renderLegend()}
      ${renderTable(points)}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Flaught — Findings Trends</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; color: #111827; background: #fff; }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  .subtitle { color: #6b7280; margin-bottom: 1.5rem; font-size: 0.875rem; }
  .stats { display: flex; gap: 1.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .stat { border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.75rem 1rem; min-width: 140px; }
  .stat-value { font-size: 1.5rem; font-weight: 600; }
  .stat-label { font-size: 0.75rem; color: #6b7280; }
  .legend { display: flex; gap: 1rem; margin: 0.5rem 0 1.5rem; flex-wrap: wrap; font-size: 0.8rem; }
  .legend-item { display: inline-flex; align-items: center; gap: 0.35rem; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  table { border-collapse: collapse; width: 100%; font-size: 0.8rem; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 0.4rem 0.6rem; text-align: left; }
  th { color: #6b7280; font-weight: 500; }
  .empty { color: #6b7280; }
</style>
</head>
<body>
  <h1>Flaught — Findings Trends</h1>
  <div class="subtitle">Generated ${escapeHtml(new Date().toISOString())} · ${points.length} run${points.length === 1 ? "" : "s"}</div>
  ${body}
</body>
</html>`;
}
