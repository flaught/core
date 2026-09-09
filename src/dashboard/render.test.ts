import { describe, it, expect } from "vitest";
import { renderDashboardHtml } from "./render.js";
import type { TrendPoint } from "./trends.js";

function makePoint(overrides: Partial<TrendPoint> = {}): TrendPoint {
  return {
    generated_at: "2026-01-01T00:00:00Z",
    run_id: "run-1",
    pr_number: 42,
    pr_title: "Add auth",
    repository: "flaught/core",
    total_findings: 3,
    by_severity: { critical: 1, high: 1, medium: 1, low: 0, info: 0 },
    by_source_type: { llm: 2, deterministic: 1 },
    refute: { confirmed: 1, refuted: 1, uncertain: 0 },
    dismissed_count: 0,
    llm_error: false,
    usage: null,
    ...overrides,
  };
}

describe("renderDashboardHtml", () => {
  it("renders a self-contained HTML document with no external references", () => {
    const html = renderDashboardHtml([makePoint()]);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Flaught");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://cdn");
    expect(html).not.toMatch(/<script\s+src=/);
    expect(html).not.toMatch(/<link\s+rel="stylesheet"/);
  });

  it("shows an empty state instead of an empty chart when there are no points", () => {
    const html = renderDashboardHtml([]);
    expect(html).toContain("No findings artifacts were found");
    expect(html).not.toContain("<svg");
  });

  it("includes the PR number and repo in the table", () => {
    const html = renderDashboardHtml([makePoint({ pr_number: 99, repository: "acme/widgets" })]);
    expect(html).toContain("#99");
    expect(html).toContain("acme/widgets");
  });

  it("escapes untrusted-looking PR titles instead of injecting raw HTML", () => {
    const html = renderDashboardHtml([makePoint({ pr_title: "<img src=x onerror=alert(1)>" })]);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img");
  });

  it("flags LLM failures in the table", () => {
    const html = renderDashboardHtml([makePoint({ llm_error: true })]);
    expect(html).toContain("⚠️");
  });

  it("draws a line chart when there are points", () => {
    const html = renderDashboardHtml([makePoint(), makePoint({ run_id: "run-2", total_findings: 5 })]);
    expect(html).toContain("<svg");
    expect(html).toContain("<path");
  });

  it("renders a Tokens column header in the table", () => {
    const html = renderDashboardHtml([makePoint()]);
    expect(html).toContain("<th>Tokens</th>");
  });

  it("shows an em dash for token usage when usage is null", () => {
    const html = renderDashboardHtml([makePoint({ usage: null })]);
    expect(html).toContain("<td>—</td>");
  });

  it("renders total token count and a Total tokens stat for points with usage", () => {
    const html = renderDashboardHtml([
      makePoint({
        usage: {
          review: { prompt_tokens: 4200, completion_tokens: 850, total_tokens: 5050 },
          refute: { prompt_tokens: 3100, completion_tokens: 400, total_tokens: 3500 },
        },
      }),
    ]);
    // 5050 + 3500 = 8550 total
    expect(html).toContain("8,550");
    expect(html).toContain("Total tokens");
  });

  it("renders just the review total when refute usage is omitted", () => {
    // A run where the refute pass was skipped/disabled/failed: usage.review
    // present, no usage.refute. The cell must show the review total alone
    // (not NaN, not blank), and the Total tokens stat must reflect only review.
    const html = renderDashboardHtml([
      makePoint({
        usage: {
          review: { prompt_tokens: 4200, completion_tokens: 850, total_tokens: 5050 },
        },
      }),
    ]);
    expect(html).toContain("5,050");
    expect(html).toContain("Total tokens");
    // Must not render the "(review ... + refute ...)" breakdown form.
    expect(html).not.toContain("refute");
  });
});
