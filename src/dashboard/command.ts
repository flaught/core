/**
 * CLI handler for rendering a findings-trends dashboard.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { findJsonFiles, loadJsonFiles } from "./loader.js";
import { renderDashboardHtml } from "./render.js";
import { computeTrends } from "./trends.js";

export interface DashboardOptions {
  input: string;
  output: string;
}

export function runDashboard(opts: DashboardOptions): void {
  const inputPath = path.resolve(opts.input);
  const files = findJsonFiles(inputPath);
  const parsed = loadJsonFiles(files);
  const points = computeTrends(parsed);

  if (points.length === 0) {
    throw new Error(
      `No findings artifacts found under ${inputPath}. ` +
        `Populate it with \`gh run download -n flaught-findings -D "${inputPath}"\` first; ` +
        "`flaught dashboard` reads them recursively.",
    );
  }

  const outputPath = path.resolve(opts.output);
  fs.writeFileSync(outputPath, renderDashboardHtml(points));

  console.log(`Scanned ${files.length} JSON file(s) under ${opts.input}, found ${points.length} findings artifact(s).`);
  console.log(`Wrote ${outputPath}`);
}
