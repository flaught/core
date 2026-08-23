#!/usr/bin/env node
/**
 * Flaught CLI — adversarial PR/code review for CI.
 *
 * Usage:
 *   flaught review                          # full adversarial review
 *   flaught review --json                   # output context as JSON (stage 1 only)
 *   flaught review --base main --head feat  # specify refs
 *   flaught review --no-llm                 # skip LLM, context assembly only
 *   flaught init                            # scaffold .advreview.yml
 */

import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { simpleGit } from "simple-git";

// Read version from package.json — the compiled output is CJS, so require() works directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkgVersion: string = require("../package.json").version;

import { contextToJSON } from "./context/assembler.js";
import { runReview, type ProgressCallback } from "./review.js";
import { initConfig, loadConfig } from "./config.js";
import { LLMError, MissingAPIKeyError } from "./llm/provider.js";
import { ModelNotFoundError } from "./llm/liveness.js";
import { postInlineReview, buildInlineSummaryHeader, detectGitHubConfig, type GitHubConfig } from "./github/inline-comments.js";
import type { FindingsArtifact } from "./schemas/findings.js";
import type { DismissalEntry } from "./schemas/dismissals.js";
import {
  loadDismissalStore,
  saveDismissalStore,
  addDismissal,
  removeDismissal,
  resolveDismissalsPath,
  isExpired,
} from "./dismissals/store.js";
import { initPromptTemplates } from "./prompt/templates.js";
import { runDashboard } from "./dashboard/command.js";

const program = new Command();

program
  .name("flaught")
  .description("Adversarial PR/code review tool — structured, skeptical scrutiny for CI")
  .version(pkgVersion);

program
  .command("init")
  .description("Scaffold .advreview.yml with commented defaults")
  .option("-d, --dir <path>", "Target directory", process.cwd())
  .action((opts) => {
    const filePath = initConfig(opts.dir);
    console.log(`Created ${filePath}`);

    // Also scaffold .flaught-prompt/ with example template files
    const promptDir = initPromptTemplates(opts.dir);
    console.log(`Created ${promptDir}/ with example template files`);
    console.log(`\nEdit the .example files to customize prompts. Remove .example to activate a template.`);
  });

program
  .command("review")
  .description("Run adversarial review on a diff")
  .option("-r, --repo <path>", "Path to git repo", process.cwd())
  .option("-b, --base <ref>", "Base ref (branch, tag, or SHA)")
  .option("-h, --head <ref>", "Head ref (default: HEAD)")
  .option("-c, --config <path>", "Path to .advreview.yml")
  .option("--json", "Output full context as JSON (for debugging/integration)")
  .option("--output <path>", "Write JSON artifact to file")
  .option("--no-llm", "Skip LLM review (context assembly only)")
  .option("--emit-context <path>", "Write the serialized review context to a file (for `flaught review --only-llm`)")
  .option("--no-refute", "Skip the skeptic/refute pass even if LLM review is enabled")
  .option("--pr-description <text>", "PR description for scope-creep detection")
  .option("--quiet", "Only output the final report, no progress messages")
  .option("--github-inline", "Post findings as inline PR comments on diff lines (requires GITHUB_TOKEN)")
  .action(async (opts) => {
    try {
      await runCliReview(opts);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command("dismiss")
  .description("Dismiss a finding from a previous review, persisting it to the dismissal store so it stops re-triggering the gate")
  .argument("<findingId>", "The finding's run-local id (e.g. D-0001), from a findings JSON artifact")
  .requiredOption("--artifact <path>", "Path to a findings JSON artifact (from `flaught review --output`)")
  .requiredOption("--reason <text>", "Why this finding is being dismissed")
  .option("--by <email>", "Who is dismissing this finding (defaults to `git config user.email`)")
  .option("--expires <duration>", "TTL for the dismissal, e.g. 90d or 4w (default: never expires)")
  .option("-r, --repo <path>", "Path to git repo", process.cwd())
  .option("-c, --config <path>", "Path to .advreview.yml")
  .action(async (findingId, opts) => {
    try {
      await runDismiss(findingId, opts);
    } catch (err) {
      handleError(err);
    }
  });

const dismissals = program
  .command("dismissals")
  .description("Manage the persisted dismissal store (.flaught-dismissals.json)");

dismissals
  .command("list")
  .description("List all entries in the dismissal store")
  .option("-r, --repo <path>", "Path to git repo", process.cwd())
  .option("-c, --config <path>", "Path to .advreview.yml")
  .action(async (opts) => {
    try {
      await runDismissalsList(opts);
    } catch (err) {
      handleError(err);
    }
  });

dismissals
  .command("audit")
  .description("Flag expired or soon-to-expire dismissals — exits 1 if any are expired")
  .option("--warn-days <n>", "Warn when a dismissal expires within N days", "14")
  .option("-r, --repo <path>", "Path to git repo", process.cwd())
  .option("-c, --config <path>", "Path to .advreview.yml")
  .action(async (opts) => {
    try {
      await runDismissalsAudit(opts);
    } catch (err) {
      handleError(err);
    }
  });

dismissals
  .command("remove")
  .description("Remove an entry from the dismissal store")
  .argument("<fingerprint>", "The dismissal's fingerprint (see `flaught dismissals list`)")
  .option("-r, --repo <path>", "Path to git repo", process.cwd())
  .option("-c, --config <path>", "Path to .advreview.yml")
  .action(async (fingerprint, opts) => {
    try {
      await runDismissalsRemove(fingerprint, opts);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command("dashboard")
  .description("Render a static HTML dashboard of findings trends across historical findings.json artifacts")
  .requiredOption("--input <dir>", "Directory to search (recursively) for findings.json artifacts")
  .option("--output <path>", "Output HTML file path", "flaught-dashboard.html")
  .action((opts) => {
    try {
      runDashboard(opts);
    } catch (err) {
      handleError(err);
    }
  });

async function runCliReview(opts: {
  repo?: string;
  base?: string;
  head?: string;
  config?: string;
  json?: boolean;
  output?: string;
  llm?: boolean;
  prDescription?: string;
  quiet?: boolean;
  githubInline?: boolean;
  emitContext?: string;
}): Promise<void> {
  const progress: ProgressCallback = opts.quiet
    ? () => {}
    : (msg) => console.error(msg);

  // --json: output stage 1 context only
  if (opts.json) {
    const { assembleContext } = await import("./context/assembler.js");
    const context = await assembleContext({
      repoPath: opts.repo ? path.resolve(opts.repo) : undefined,
      baseRef: opts.base,
      headRef: opts.head,
      configPath: opts.config,
    });
    console.log(JSON.stringify(contextToJSON(context), null, 2));
    return;
  }

  // Full review pipeline
  const result = await runReview({
    repoPath: opts.repo ? path.resolve(opts.repo) : undefined,
    baseRef: opts.base,
    headRef: opts.head,
    configPath: opts.config,
    prDescription: opts.prDescription,
    skipLlm: !opts.llm,
    skipRefute: (opts as Record<string, unknown>).refute === false, // --no-refute sets refute to false
    onProgress: progress,
  });

  // Output markdown report to stdout
  console.log(result.markdown);

  // Warn if LLM review failed but deterministic findings are still available
  if (result.llmError) {
    console.error(`\n⚠️ LLM review failed: ${result.llmError}`);
    console.error(`  Review completed with deterministic findings only. LLM findings are not included.`);
  }

  // Write JSON artifact to file if requested
  if (opts.output) {
    const outputPath = path.resolve(opts.output);
    fs.writeFileSync(outputPath, result.json, "utf-8");
    console.error(`\n📄 JSON artifact written to ${outputPath}`);
  }

  // Write the serialized review context to a file if requested. This is the
  // artifact the privileged half of the fork-PR review split consumes via
  // `flaught review --only-llm --context <path>` — it carries the diff and file
  // contents as data, so the LLM pass can run later without a git checkout.
  if (opts.emitContext) {
    const contextPath = path.resolve(opts.emitContext);
    fs.writeFileSync(contextPath, JSON.stringify(contextToJSON(result.context), null, 2), "utf-8");
    console.error(`\n📦 Review context written to ${contextPath}`);
  }

  // Post inline comments on PR diff lines if --github-inline
  if (opts.githubInline) {
    try {
      let githubConfig: GitHubConfig | null = null;

      // Try to auto-detect from GitHub Actions environment
      githubConfig = await detectGitHubConfig();

      // Fall back to explicit env vars
      if (!githubConfig) {
        const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
        const repo = process.env.GITHUB_REPOSITORY;
        const prNum = process.env.PR_NUMBER
          ? parseInt(process.env.PR_NUMBER, 10)
          : undefined;

        if (token && repo && prNum && !isNaN(prNum)) {
          githubConfig = {
            token,
            repository: repo,
            pullNumber: prNum,
            baseSha: result.context.baseSha,
            headSha: result.context.headSha,
          };
        }
      }

      if (githubConfig) {
        progress("Posting inline comments on PR...");
        const summaryHeader = buildInlineSummaryHeader(result.artifact);
        const reviewResult = await postInlineReview(githubConfig, result.artifact, summaryHeader);

        if (reviewResult.posted) {
          if (reviewResult.inlineCommentsCount > 0) {
            progress(`  ✅ Posted ${reviewResult.inlineCommentsCount} inline comment(s) on PR #${githubConfig.pullNumber}`);
          } else {
            progress("  No inline-eligible findings (all findings lack file/line info)");
          }
          if (reviewResult.reviewUrl) {
            progress(`  Review: ${reviewResult.reviewUrl}`);
          }
        } else {
          progress(`  ⚠ Failed to post inline comments: ${reviewResult.error}`);
          progress("  Falling back to summary comment only.");
        }
      } else {
        progress("⚠ --github-inline specified but no GitHub environment detected.");
        progress("  Set GITHUB_TOKEN and GITHUB_REPOSITORY (or run in GitHub Actions).");
      }
    } catch (err) {
      progress(`⚠ Error posting inline comments: ${err instanceof Error ? err.message : String(err)}`);
      // Don't fail the review — inline comments are a best-effort enhancement
    }
  }

  // Exit code based on severity gate
  if (result.exitCode !== 0) {
    console.error(
      `\n⛔ Exiting with code ${result.exitCode}: undismissed findings at or above severity gate threshold`,
    );
  }
  process.exit(result.exitCode);
}

// ─── Dismissal commands ──────────────────────────────────────────────────────

async function resolveDismisserIdentity(repoPath: string): Promise<string | null> {
  try {
    const email = (await simpleGit(repoPath).raw(["config", "user.email"])).trim();
    return email || null;
  } catch {
    return null;
  }
}

function parseExpiry(spec: string | undefined, from: Date): string | null {
  if (!spec) return null;

  const match = /^(\d+)([dw])$/.exec(spec.trim());
  if (!match) {
    throw new Error(
      `Invalid --expires value "${spec}". Use a number followed by d (days) or w (weeks), e.g. 90d or 4w.`,
    );
  }

  const amount = parseInt(match[1]!, 10);
  const msPerDay = 24 * 60 * 60 * 1000;
  const ms = match[2] === "w" ? amount * 7 * msPerDay : amount * msPerDay;
  return new Date(from.getTime() + ms).toISOString();
}

async function runDismiss(
  findingId: string,
  opts: {
    artifact: string;
    reason: string;
    by?: string;
    expires?: string;
    repo?: string;
    config?: string;
  },
): Promise<void> {
  const repoPath = opts.repo ? path.resolve(opts.repo) : process.cwd();
  const config = await loadConfig(opts.config);

  if (!config.dismissals.enabled) {
    console.error("\n❌ Dismissals are disabled (dismissals.enabled: false in .advreview.yml).");
    process.exit(2);
  }

  const artifactPath = path.resolve(opts.artifact);
  if (!fs.existsSync(artifactPath)) {
    console.error(`\n❌ Artifact not found: ${artifactPath}\n\nRun \`flaught review --output <path>\` first to generate one.`);
    process.exit(2);
  }

  const artifact = parseArtifactFile(artifactPath);
  const finding = artifact.findings.find((f) => f.id === findingId);
  if (!finding) {
    const available = artifact.findings.map((f) => f.id).join(", ") || "(none)";
    console.error(`\n❌ No finding with id "${findingId}" in ${artifactPath}.\n\nAvailable ids: ${available}`);
    process.exit(2);
  }

  const dismissedBy = opts.by ?? (await resolveDismisserIdentity(repoPath));
  if (!dismissedBy) {
    console.error(
      "\n❌ Could not determine who is dismissing this finding.\n\n" +
      "Options:\n" +
      "  • Pass --by <email>\n" +
      "  • Set git config: git config user.email you@example.com",
    );
    process.exit(2);
  }

  const expiresAt = parseExpiry(opts.expires, new Date());

  const dismissalsPath = resolveDismissalsPath(repoPath, config.dismissals.path);
  const store = loadDismissalStore(dismissalsPath);
  const entry: DismissalEntry = {
    fingerprint: finding.fingerprint,
    dismissed_by: dismissedBy,
    dismissed_at: new Date().toISOString(),
    reason: opts.reason,
    context: { title: finding.title, file: finding.evidence.file },
    expires_at: expiresAt,
  };
  saveDismissalStore(dismissalsPath, addDismissal(store, entry));

  console.log(`✅ Dismissed ${findingId}: ${finding.title}`);
  console.log(`   Fingerprint: ${finding.fingerprint}`);
  console.log(`   Written to: ${dismissalsPath}`);
  console.log(`\nCommit ${path.relative(repoPath, dismissalsPath)} so CI picks up this dismissal.`);
}

async function runDismissalsList(opts: { repo?: string; config?: string }): Promise<void> {
  const repoPath = opts.repo ? path.resolve(opts.repo) : process.cwd();
  const config = await loadConfig(opts.config);
  const dismissalsPath = resolveDismissalsPath(repoPath, config.dismissals.path);
  const store = loadDismissalStore(dismissalsPath);

  if (store.dismissals.length === 0) {
    console.log(`No dismissals in ${dismissalsPath}.`);
    return;
  }

  const now = new Date();
  for (const entry of store.dismissals) {
    const status = isExpired(entry, now)
      ? "EXPIRED"
      : entry.expires_at
        ? `expires ${entry.expires_at}`
        : "no expiry";

    console.log(entry.fingerprint);
    console.log(`  title:   ${entry.context?.title ?? "(unknown)"}`);
    console.log(`  file:    ${entry.context?.file ?? "(unknown)"}`);
    console.log(`  by:      ${entry.dismissed_by} at ${entry.dismissed_at}`);
    console.log(`  reason:  ${entry.reason}`);
    console.log(`  status:  ${status}`);
    console.log("");
  }
}

async function runDismissalsAudit(opts: { warnDays?: string; repo?: string; config?: string }): Promise<void> {
  const repoPath = opts.repo ? path.resolve(opts.repo) : process.cwd();
  const config = await loadConfig(opts.config);
  const dismissalsPath = resolveDismissalsPath(repoPath, config.dismissals.path);
  const store = loadDismissalStore(dismissalsPath);
  const warnDays = parseInt(opts.warnDays ?? "14", 10);
  const now = new Date();

  let expiredCount = 0;
  let expiringSoonCount = 0;

  for (const entry of store.dismissals) {
    if (!entry.expires_at) continue;
    const daysUntil = (new Date(entry.expires_at).getTime() - now.getTime()) / (24 * 60 * 60 * 1000);

    if (daysUntil < 0) {
      expiredCount++;
      console.log(`⛔ EXPIRED   ${entry.fingerprint}  ${entry.context?.title ?? ""} (expired ${entry.expires_at})`);
    } else if (daysUntil <= warnDays) {
      expiringSoonCount++;
      console.log(`⚠️  EXPIRING  ${entry.fingerprint}  ${entry.context?.title ?? ""} (in ${Math.floor(daysUntil)}d)`);
    }
  }

  if (expiredCount === 0 && expiringSoonCount === 0) {
    console.log(`✅ No expired or expiring dismissals (checked ${store.dismissals.length}).`);
    return;
  }

  console.log(`\n${expiredCount} expired, ${expiringSoonCount} expiring within ${warnDays}d.`);
  if (expiredCount > 0) {
    process.exit(1);
  }
}

async function runDismissalsRemove(fingerprint: string, opts: { repo?: string; config?: string }): Promise<void> {
  const repoPath = opts.repo ? path.resolve(opts.repo) : process.cwd();
  const config = await loadConfig(opts.config);
  const dismissalsPath = resolveDismissalsPath(repoPath, config.dismissals.path);
  const store = loadDismissalStore(dismissalsPath);

  if (!store.dismissals.some((d) => d.fingerprint === fingerprint)) {
    console.error(`\n❌ No dismissal with fingerprint ${fingerprint} in ${dismissalsPath}.`);
    process.exit(2);
  }

  saveDismissalStore(dismissalsPath, removeDismissal(store, fingerprint));
  console.log(`✅ Removed ${fingerprint} from ${dismissalsPath}`);
}

// ─── Artifact file parsing with schema validation ───────────────────────────

/**
 * Parse a findings JSON artifact file with schema validation.
 *
 * SECURITY: Validates the parsed JSON against the FindingsArtifactSchema
 * to prevent type-confusion attacks or unexpected behavior from malformed
 * artifact files. Returns a typed FindingsArtifact or exits with an error.
 */
function parseArtifactFile(artifactPath: string): FindingsArtifact {
  const raw = fs.readFileSync(artifactPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`\n❌ Artifact file is not valid JSON: ${artifactPath}`);
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  // SECURITY: null passes typeof === "object" — explicitly reject it
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`\n❌ Artifact file does not contain a JSON object: ${artifactPath}`);
    process.exit(2);
  }

  // Validate required fields exist before accessing them.
  // Full Zod validation would catch everything, but FindingsArtifactSchema
  // uses .passthrough() internally. We validate the critical structural
  // fields that the dismiss command accesses.
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) {
    console.error(`\n❌ Artifact file has no \"findings\" array: ${artifactPath}`);
    process.exit(2);
  }

  return parsed as FindingsArtifact;
}

function handleError(err: unknown): never {
  if (err instanceof MissingAPIKeyError) {
    console.error(`\n❌ ${err.message}`);
    process.exit(2);
  }

  if (err instanceof ModelNotFoundError) {
    console.error(`\n❌ ${err.message}`);
    process.exit(2);
  }

  if (err instanceof LLMError) {
    console.error(`\n❌ ${err.message}`);
    process.exit(2);
  }

  if (err instanceof Error) {
    console.error(`\n❌ ${err.message}`);
  } else {
    console.error(`\n❌ ${String(err)}`);
  }

  // Exit 1 is reserved for "the review completed and found real findings at
  // or above the severity gate" (see computeExitCode in review.ts). Any error
  // reaching here means the review did NOT complete normally — that's a tool
  // fault (git failure, config error, unclassified LLM/network error), not
  // evidence of a real code problem. Conflating the two is exactly what let
  // LLM/infra outages block merges the same way a genuine finding does.
  process.exit(2);
}

program.parse();
