#!/usr/bin/env node
/**
 * Flaught CLI — adversarial PR/code review for CI.
 *
 * Usage:
 *   flaught review            # full adversarial review
 *   flaught review --json     # dump context as JSON
 *   flaught review --base main --head feature-branch
 *   flaught init              # scaffold .advreview.yml
 */

import { Command } from "commander";
import { assembleContext, contextToJSON, type ContextOptions } from "./context/assembler.js";
import { initConfig } from "./config.js";
import * as path from "node:path";

const program = new Command();

program
  .name("flaught")
  .description("Adversarial PR/code review tool — structured, skeptical scrutiny for CI")
  .version("0.1.0");

program
  .command("init")
  .description("Scaffold .advreview.yml with commented defaults")
  .option("-d, --dir <path>", "Target directory", process.cwd())
  .action((opts) => {
    const filePath = initConfig(opts.dir);
    console.log(`Created ${filePath}`);
  });

program
  .command("review")
  .description("Run adversarial review on a diff")
  .option("-r, --repo <path>", "Path to git repo", process.cwd())
  .option("-b, --base <ref>", "Base ref (branch, tag, or SHA)")
  .option("-h, --head <ref>", "Head ref (default: HEAD)")
  .option("-c, --config <path>", "Path to .advreview.yml")
  .option("--diff <path>", "Path to a diff file (instead of git diff)")
  .option("--json", "Output full context as JSON (for debugging/integration)")
  .action(async (opts) => {
    try {
      await runReview(opts);
    } catch (err) {
      console.error("Flaught review failed:");
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

async function runReview(opts: {
  repo?: string;
  base?: string;
  head?: string;
  config?: string;
  diff?: string;
  json?: boolean;
}): Promise<void> {
  const contextOptions: ContextOptions = {
    repoPath: opts.repo ? path.resolve(opts.repo) : undefined,
    baseRef: opts.base,
    headRef: opts.head,
    configPath: opts.config,
  };

  const context = await assembleContext(contextOptions);

  // JSON mode: dump full context and exit
  if (opts.json) {
    const json = contextToJSON(context);
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  // Human-readable output
  console.log("Flaught — adversarial code review");
  console.log("─".repeat(40));

  // Stage 1: Context assembly
  console.log("\n📋 Stage 1: Assembling context...");
  console.log(`  Base: ${context.baseSha.slice(0, 8)} → Head: ${context.headSha.slice(0, 8)}`);
  console.log(`  Changed files: ${context.changedFiles.length}`);
  console.log(`  Neighborhood files: ${context.neighborhoodFiles.length}`);
  console.log(`  Dependency graph nodes: ${context.dependencyGraph.getAllFiles().length}`);

  if (context.changedFiles.length === 0) {
    console.log("\n✓ No changes detected. Nothing to review.");
    return;
  }

  // Print changed files summary
  console.log("\n  Changed:");
  for (const f of context.changedFiles) {
    const indicator =
      f.status === "added" ? "+" :
      f.status === "deleted" ? "-" :
      f.status === "renamed" ? "→" : "~";
    console.log(`    ${indicator} ${f.path} (+${f.additions}/-${f.deletions})`);
  }

  if (context.neighborhoodFiles.length > 0) {
    console.log("\n  Neighborhood (one-hop dependents):");
    for (const f of context.neighborhoodFiles) {
      console.log(`    ○ ${f}`);
    }
  }

  // Stages 2-6 are not yet implemented
  console.log("\n⚠ Stages 2-6 (LLM review, tools, test inversion, scope creep, report) not yet implemented.");
  console.log("Stage 1 (context assembly) complete. Exiting.");
}

program.parse();