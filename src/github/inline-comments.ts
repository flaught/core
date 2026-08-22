/**
 * GitHub PR integration — post findings as inline review comments.
 *
 * Uses the GitHub REST API to create a pull request review with inline
 * comments on specific diff lines. This makes findings visible directly
 * in the PR diff, rather than buried in a summary comment.
 *
 * Environment variables (set by GitHub Actions):
 * - GITHUB_TOKEN: GitHub API token (permissions: pull-requests: write)
 * - GITHUB_REPOSITORY: owner/repo (e.g. "flaught/core")
 * - GITHUB_EVENT_PATH: path to the event JSON (for PR number)
 *
 * Can also be used outside CI with explicit configuration.
 */

import type { Finding, FindingsArtifact } from "../schemas/findings.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GitHubConfig {
  /** GitHub API token */
  token: string;
  /** Repository in owner/repo format (e.g. "flaught/core") */
  repository: string;
  /** Pull request number */
  pullNumber: number;
  /** Base commit SHA for the PR */
  baseSha: string;
  /** Head commit SHA for the PR */
  headSha: string;
  /** GitHub API base URL (default: https://api.github.com) */
  apiBaseUrl?: string;
}

export interface InlineComment {
  /** Path to the file in the repo */
  path: string;
  /** Line number in the diff (position-based, 1-indexed) */
  position: number;
  /** Comment body (Markdown) */
  body: string;
}

export interface ReviewResult {
  /** Whether the review was successfully posted */
  posted: boolean;
  /** Number of inline comments posted */
  inlineCommentsCount: number;
  /** URL of the review, if posted */
  reviewUrl?: string;
  /** Error message if posting failed */
  error?: string;
}

// ─── Severity emoji mapping ────────────────────────────────────────────────

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
  info: "⚪",
};

// ─── Build inline comment from finding ──────────────────────────────────────

/**
 * Build an inline comment body for a finding.
 *
 * Designed to be concise but informative: severity badge, source badge,
 * title, and a brief description. No snippet (it's already visible in the
 * diff) and no references (those go in the summary comment).
 */
function buildInlineCommentBody(finding: Finding): string {
  const emoji = SEVERITY_EMOJI[finding.severity] ?? "⚪";
  const sourceBadge = finding.source_type === "llm" ? "🤖" : "🔧";
  const lines: string[] = [];

  lines.push(`**${emoji} ${finding.severity.toUpperCase()}** ${sourceBadge} ${finding.title}`);
  lines.push("");
  lines.push(finding.description);

  if (finding.refute_result) {
    const verdictEmoji = finding.refute_result.verdict === "confirmed"
      ? "✅"
      : finding.refute_result.verdict === "refuted"
        ? "❌"
        : "❓";
    lines.push("");
    lines.push(`${verdictEmoji} Skeptic: ${finding.refute_result.verdict}${finding.refute_result.reasoning ? ` — ${finding.refute_result.reasoning}` : ""}`);
  }

  if (finding.dismissed) {
    lines.push("");
    lines.push(`~~*Dismissed*${finding.dismissal_reason ? `: ${finding.dismissal_reason}` : ""}~~`);
  }

  lines.push("");
  lines.push(`— *Flaught* · \`${finding.id}\``);

  return lines.join("\n");
}

// ─── Build inline comments from findings ────────────────────────────────────

/**
 * Convert findings with file/line information into inline review comments.
 *
 * Only findings with a non-empty `evidence.file` and `evidence.line_start > 0`
 * are eligible for inline comments. Findings without location info (e.g.,
 * vulnerability findings with just a package name) fall back to the summary
 * comment only.
 *
 * The GitHub API requires `position` (line offset within the diff), not the
 * absolute file line number. We approximate using `line_start` since the
 * exact diff position would require fetching the diff first. If the position
 * doesn't map to a valid diff line, GitHub returns a 422 and we fall back
 * to posting the comment on the file without a specific line.
 */
export function buildInlineComments(findings: Finding[]): InlineComment[] {
  const comments: InlineComment[] = [];

  for (const finding of findings) {
    // Skip findings without file location
    if (!finding.evidence.file || finding.evidence.line_start <= 0) {
      continue;
    }

    // Skip dismissed findings — they're informational, not actionable
    if (finding.dismissed) {
      continue;
    }

    comments.push({
      path: finding.evidence.file,
      position: finding.evidence.line_start,
      body: buildInlineCommentBody(finding),
    });
  }

  return comments;
}

// ─── Post review with inline comments ────────────────────────────────────────

/**
 * Post a pull request review with inline comments on specific diff lines.
 *
 * If there are inline-eligible findings, creates a review with comments.
 * If inline comments fail (e.g., position doesn't map to a valid diff line),
 * falls back to posting a single summary comment.
 *
 * Returns a ReviewResult indicating success/failure and counts.
 */
export async function postInlineReview(
  config: GitHubConfig,
  artifact: FindingsArtifact,
  summaryBody: string,
): Promise<ReviewResult> {
  const apiBaseUrl = config.apiBaseUrl ?? "https://api.github.com";
  const url = `${apiBaseUrl}/repos/${config.repository}/pulls/${config.pullNumber}/reviews`;

  const inlineComments = buildInlineComments(artifact.findings);

  // GitHub limits reviews to 50 inline comments per request
  const maxComments = 50;
  const commentsToPost = inlineComments.slice(0, maxComments);

  if (commentsToPost.length === 0) {
    // No inline-eligible findings — just the summary comment
    // (posted separately by the caller, not via the review API)
    return {
      posted: true,
      inlineCommentsCount: 0,
    };
  }

  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${config.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const body = {
    commit_id: config.headSha,
    body: summaryBody,
    event: "COMMENT" as const,
    comments: commentsToPost.map((c) => ({
      path: c.path,
      position: c.position,
      body: c.body,
    })),
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      posted: false,
      inlineCommentsCount: 0,
      error: `Network error posting review: ${errorMsg}`,
    };
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");

    // If inline comments fail (e.g., 422 for invalid positions), try
    // posting just the summary comment without inline comments
    if (response.status === 422) {
      // Fall back to posting just the summary as a PR comment
      return await postFallbackComment(config, summaryBody);
    }

    return {
      posted: false,
      inlineCommentsCount: 0,
      error: `GitHub API error (${response.status}): ${errorBody}`,
    };
  }

  const responseData = await response.json() as { html_url?: string };
  return {
    posted: true,
    inlineCommentsCount: commentsToPost.length,
    reviewUrl: responseData.html_url,
  };
}

/**
 * Post a single PR comment as a fallback when inline review comments fail.
 */
async function postFallbackComment(
  config: GitHubConfig,
  body: string,
): Promise<ReviewResult> {
  const apiBaseUrl = config.apiBaseUrl ?? "https://api.github.com";
  const url = `${apiBaseUrl}/repos/${config.repository}/issues/${config.pullNumber}/comments`;

  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${config.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ body }),
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      posted: false,
      inlineCommentsCount: 0,
      error: `Network error posting comment: ${errorMsg}`,
    };
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    return {
      posted: false,
      inlineCommentsCount: 0,
      error: `GitHub API error (${response.status}): ${errorBody}`,
    };
  }

  const responseData = await response.json() as { html_url?: string };
  return {
    posted: true,
    inlineCommentsCount: 0,
    reviewUrl: responseData.html_url,
  };
}

// ─── Detect GitHub Actions environment ───────────────────────────────────────

/**
 * Detect GitHub Actions environment and return a GitHubConfig if available.
 *
 * Reads GITHUB_TOKEN, GITHUB_REPOSITORY, and the PR number from the
 * GITHUB_EVENT_PATH JSON. Returns null if not in a GitHub Actions
 * environment or if not running for a pull request event.
 */
export async function detectGitHubConfig(): Promise<GitHubConfig | null> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!token || !repository || !eventPath) {
    return null;
  }

  // Read the event JSON to get the PR number
  let eventData: Record<string, unknown>;
  try {
    const fs = await import("node:fs");
    const eventJson = fs.readFileSync(eventPath, "utf-8");
    eventData = JSON.parse(eventJson) as Record<string, unknown>;
  } catch {
    return null;
  }

  const pullRequest = eventData.pull_request as Record<string, unknown> | undefined;
  if (!pullRequest) {
    return null;
  }

  const pullNumber = typeof pullRequest.number === "number"
    ? pullRequest.number
    : null;

  if (!pullNumber) {
    return null;
  }

  const baseSha = typeof (pullRequest.base as Record<string, unknown>)?.sha === "string"
    ? ((pullRequest.base as Record<string, unknown>).sha as string)
    : "";
  const headSha = typeof (pullRequest.head as Record<string, unknown>)?.sha === "string"
    ? ((pullRequest.head as Record<string, unknown>).sha as string)
    : "";

  return {
    token,
    repository,
    pullNumber,
    baseSha,
    headSha,
  };
}

// ─── Format inline comment summary header ───────────────────────────────────

/**
 * Build a short summary header for the inline review comment body.
 *
 * This goes above the inline comments and summarizes the overall review.
 * The full findings details are in the inline comments themselves.
 */
export function buildInlineSummaryHeader(artifact: FindingsArtifact): string {
  const s = artifact.summary;
  const lines: string[] = [];

  lines.push(`## 🔍 Flaught — Adversarial Code Review`);
  lines.push("");
  lines.push(`> ⚠️ ${artifact._caveat}`);
  lines.push("");

  // Summary table
  lines.push(`| Severity | Count |`);
  lines.push(`| --- | --- |`);

  const severityOrder = ["critical", "high", "medium", "low", "info"] as const;
  for (const sev of severityOrder) {
    if (s.by_severity[sev] > 0) {
      const emoji = SEVERITY_EMOJI[sev] ?? "⚪";
      lines.push(`| ${emoji} ${sev.toUpperCase()} | ${s.by_severity[sev]} |`);
    }
  }

  if (s.total_findings === 0) {
    lines.push("");
    lines.push("✅ **No findings.** The adversarial review found no issues worth flagging.");
  }

  // Refute summary
  const confirmed = artifact.findings.filter((f) => f.refute_result?.verdict === "confirmed").length;
  const refuted = artifact.findings.filter((f) => f.refute_result?.verdict === "refuted").length;
  const uncertain = artifact.findings.filter((f) => f.refute_result?.verdict === "uncertain").length;
  if (confirmed + refuted + uncertain > 0) {
    lines.push("");
    lines.push(`🔍 Skeptic: ${confirmed} confirmed, ${refuted} refuted, ${uncertain} uncertain`);
  }

  lines.push("");
  lines.push(`Findings with file/line info are posted as inline comments below. Full details in the JSON artifact.`);
  lines.push("");
  lines.push(`---`);
  lines.push(`*Flaught v${artifact.flaught_version} · Schema v${artifact.schema_version} · ${artifact.generated_at}*`);

  return lines.join("\n");
}