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
import { contextToJSON } from "./context/assembler.js";
import { runReview } from "./review.js";
import { initConfig } from "./config.js";

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
  .option("--json", "Output full context as JSON (for debugging/integration)")
  .option("--output <path>", "Write JSON artifact to file")
  .option("--no-llm", "Skip LLM review (context assembly only)")
  .option("--pr-description <text>", "PR description for scope-creep detection")
  .action(async (opts) => {
    try {
      await runCliReview(opts);
    } catch (err) {
      console.error("Flaught review failed:");
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

async function runCliReview(opts: {
  repo?: string;
  base?: string;
  head?: string;
  config?: string;
  json?: boolean;
  output?: string;
  noLlm?: boolean;
  prDescription?: string;
}): Promise<void> {
  // --json without --no-llm: output stage 1 context only (backward compat)
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
    skipLlm: opts.noLlm,
  });

  // Output markdown report to stdout
  console.log(result.markdown);

  // Write JSON artifact to file if requested
  if (opts.output) {
    const outputPath = path.resolve(opts.output);
    fs.writeFileSync(outputPath, result.json, "utf-8");
    console.error(`\n📄 JSON artifact written to ${outputPath}`);
  }

  // Exit code based on severity gate
  if (result.exitCode !== 0) {
    console.error(
      `\n⛔ Exiting with code ${result.exitCode}: undismissed findings at or above severity gate threshold`,
    );
  }
  process.exit(result.exitCode);
}

program.parse();