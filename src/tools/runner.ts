/**
 * Deterministic tool runner — executes semgrep, linters, and vulnerability
 * scanners before the LLM pass, providing grounding context.
 *
 * Design principles from the brief:
 * - Tools run FIRST, before the LLM, so their findings ground the LLM's review
 * - Each tool is swappable via config (command override) or toggleable (enabled: false)
 * - Auto-detection: if no command is specified, Flaught tries to detect the right
 *   tool based on the repo's stack (package.json, requirements.txt, etc.)
 * - Tools that aren't installed degrade gracefully (skip, not fail)
 * - Findings are tagged source_type: "deterministic" so consumers can tell
 *   tool-asserted evidence from LLM-asserted evidence at a glance
 */

import { type FlaughtConfig } from "../schemas/config.js";
import { type ToolExecuted } from "../schemas/findings.js";

// ─── Tool result ────────────────────────────────────────────────────────────

export interface ToolResult {
  /** Which tool was run */
  tool: string;
  /** Whether it ran successfully */
  success: boolean;
  /** Raw stdout from the tool */
  stdout: string;
  /** Raw stderr from the tool */
  stderr: string;
  /** Exit code (0 = success, non-zero = may have findings) */
  exitCode: number;
  /** Parsed findings (if the tool produces JSON) */
  findings: DeterministicFinding[];
  /** How long the tool took in ms */
  durationMs: number;
}

export interface DeterministicFinding {
  /** Human-readable title */
  title: string;
  /** Severity: critical, high, medium, low, info */
  severity: string;
  /** Category */
  category: string;
  /** File path */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The offending code snippet */
  snippet: string;
  /** Source tool that found this */
  source: string;
  /** Rule ID or check name */
  ruleId: string;
  /** Link to documentation for this rule */
  reference?: string;
}

// ─── Run all enabled deterministic tools ───────────────────────────────────────

export async function runDeterministicTools(
  config: FlaughtConfig,
  repoPath: string,
  onProgress?: (message: string) => void,
): Promise<{ results: ToolResult[]; executions: ToolExecuted[]; findings: DeterministicFinding[] }> {
  const progress = onProgress ?? (() => {});
  const results: ToolResult[] = [];
  const executions: ToolExecuted[] = [];
  const allFindings: DeterministicFinding[] = [];

  // ── Semgrep ──
  if (config.tools.semgrep.enabled) {
    progress("  Running semgrep...");
    const result = await runSemgrep(config, repoPath);
    results.push(result);
    executions.push({
      tool: "semgrep",
      version: result.success ? await getToolVersion("semgrep") : "unknown",
      exit_code: result.exitCode,
      raw_findings_count: result.findings.length,
      command: result.success ? getSemgrepCommand(config) : "(failed)",
    });
    allFindings.push(...result.findings);
    progress(`    semgrep: ${result.findings.length} findings (${result.durationMs}ms)`);
  }

  // ── Linter ──
  if (config.tools.linter.enabled) {
    progress("  Running linter...");
    const result = await runLinter(config, repoPath);
    results.push(result);
    executions.push({
      tool: "linter",
      version: result.success ? await getToolVersion(result.success ? (config.tools.linter.command ?? "auto") : "unknown") : "unknown",
      exit_code: result.exitCode,
      raw_findings_count: result.findings.length,
      command: result.success ? (config.tools.linter.command ?? "auto-detected") : "(failed)",
    });
    allFindings.push(...result.findings);
    progress(`    linter: ${result.findings.length} findings (${result.durationMs}ms)`);
  }

  // ── Vulnerability scanner ──
  if (config.tools.vuln_scanner.enabled) {
    progress("  Running vulnerability scanner...");
    const result = await runVulnScanner(config, repoPath);
    results.push(result);
    executions.push({
      tool: "vuln_scanner",
      version: result.success ? await getToolVersion(config.tools.vuln_scanner.command ?? "auto") : "unknown",
      exit_code: result.exitCode,
      raw_findings_count: result.findings.length,
      command: result.success ? (config.tools.vuln_scanner.command ?? "auto-detected") : "(failed)",
    });
    allFindings.push(...result.findings);
    progress(`    vuln_scanner: ${result.findings.length} findings (${result.durationMs}ms)`);
  }

  return { results, executions, findings: allFindings };
}

// ── Semgrep ──────────────────────────────────────────────────────────────────

function getSemgrepCommand(config: FlaughtConfig): string {
  if (config.tools.semgrep.config) {
    return `semgrep --config ${config.tools.semgrep.config} --json .`;
  }
  return "semgrep --config auto --json .";
}

async function runSemgrep(config: FlaughtConfig, repoPath: string): Promise<ToolResult> {
  const command = getSemgrepCommand(config);
  const startTime = Date.now();

  try {
    const result = await execCommand(command, repoPath);
    const durationMs = Date.now() - startTime;

    // Semgrep exits 0 even with findings; non-zero means error
    if (!result.success && result.exitCode !== 0) {
      return {
        tool: "semgrep",
        success: false,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        findings: [],
        durationMs,
      };
    }

    // Parse JSON output
    const findings = parseSemgrepOutput(result.stdout);
    return {
      tool: "semgrep",
      success: true,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      findings,
      durationMs,
    };
  } catch (err) {
    return {
      tool: "semgrep",
      success: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
      findings: [],
      durationMs: Date.now() - startTime,
    };
  }
}

function parseSemgrepOutput(stdout: string): DeterministicFinding[] {
  try {
    const data = JSON.parse(stdout);
    const results: DeterministicFinding[] = [];

    for (const result of data.results ?? []) {
      results.push({
        title: result.check_id ?? result.rule_id ?? "semgrep-finding",
        severity: mapSemgrepSeverity(result.extra?.severity),
        category: mapSemgrepCategory(result.check_id ?? result.rule_id ?? ""),
        file: result.path ?? "",
        line: result.start?.line ?? 0,
        snippet: result.extra?.lines ?? (result.extra?.message ?? ""),
        source: "semgrep",
        ruleId: result.check_id ?? result.rule_id ?? "unknown",
        reference: result.extra?.metadata?.references?.[0] ?? undefined,
      });
    }

    return results;
  } catch {
    // Not JSON or malformed — no findings
    return [];
  }
}

function mapSemgrepSeverity(severity: string): string {
  const map: Record<string, string> = {
    ERROR: "critical",
    WARNING: "high",
    INFO: "info",
  };
  return map[severity] ?? "medium";
}

function mapSemgrepCategory(ruleId: string): string {
  if (ruleId.includes("security") || ruleId.includes("inject") || ruleId.includes("xss") || ruleId.includes("sql")) return "security";
  if (ruleId.includes("perf")) return "performance";
  return "maintainability";
}

// ── Linter ───────────────────────────────────────────────────────────────────

async function runLinter(config: FlaughtConfig, repoPath: string): Promise<ToolResult> {
  const command = config.tools.linter.command ?? await detectLinterCommand(repoPath);
  if (!command) {
    return {
      tool: "linter",
      success: false,
      stdout: "",
      stderr: "No linter detected and no command configured",
      exitCode: -1,
      findings: [],
      durationMs: 0,
    };
  }

  const startTime = Date.now();
  try {
    // Linters typically exit non-zero when they find issues
    const result = await execCommand(command, repoPath);
    const durationMs = Date.now() - startTime;

    // Try JSON parsing first (eslint, ruff, etc. can output JSON)
    const findings = parseLinterJsonOutput(result.stdout) ||
      parseLinterTextOutput(result.stdout);

    return {
      tool: "linter",
      success: true,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      findings,
      durationMs,
    };
  } catch (err) {
    return {
      tool: "linter",
      success: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
      findings: [],
      durationMs: Date.now() - startTime,
    };
  }
}

async function detectLinterCommand(repoPath: string): Promise<string | null> {
  // Check for known linters based on project files
  const fs = await import("node:fs");
  const path = await import("node:path");

  // JavaScript/TypeScript: eslint
  if (fs.existsSync(path.join(repoPath, "package.json"))) {
    if (fs.existsSync(path.join(repoPath, ".eslintrc.js")) ||
        fs.existsSync(path.join(repoPath, ".eslintrc.json")) ||
        fs.existsSync(path.join(repoPath, ".eslintrc.yml")) ||
        fs.existsSync(path.join(repoPath, "eslint.config.js")) ||
        fs.existsSync(path.join(repoPath, "eslint.config.mjs"))) {
      return "npx eslint --format json .";
    }
  }

  // Python: ruff or flake8
  if (fs.existsSync(path.join(repoPath, "pyproject.toml")) ||
      fs.existsSync(path.join(repoPath, "requirements.txt")) ||
      fs.existsSync(path.join(repoPath, "setup.py"))) {
    // Try ruff first (faster)
    try {
      await execCommand("ruff check --version", repoPath);
      return "ruff check --output-format json .";
    } catch {
      // ruff not available
    }
    // Try flake8
    try {
      await execCommand("flake8 --version", repoPath);
      return "flake8 --format=json .";
    } catch {
      // flake8 not available
    }
  }

  // Go: go vet
  if (fs.existsSync(path.join(repoPath, "go.mod"))) {
    return "go vet ./...";
  }

  return null;
}

// ── Vulnerability scanner ────────────────────────────────────────────────────

async function runVulnScanner(config: FlaughtConfig, repoPath: string): Promise<ToolResult> {
  const command = config.tools.vuln_scanner.command ?? await detectVulnCommand(repoPath);
  if (!command) {
    return {
      tool: "vuln_scanner",
      success: false,
      stdout: "",
      stderr: "No vulnerability scanner detected and no command configured",
      exitCode: -1,
      findings: [],
      durationMs: 0,
    };
  }

  const startTime = Date.now();
  try {
    const result = await execCommand(command, repoPath);
    const durationMs = Date.now() - startTime;

    // Try JSON parsing (npm audit, pip-audit, etc.)
    const findings = parseVulnJsonOutput(result.stdout, command);

    return {
      tool: "vuln_scanner",
      success: true,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      findings,
      durationMs,
    };
  } catch (err) {
    return {
      tool: "vuln_scanner",
      success: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
      findings: [],
      durationMs: Date.now() - startTime,
    };
  }
}

async function detectVulnCommand(repoPath: string): Promise<string | null> {
  const fs = await import("node:fs");
  const path = await import("node:path");

  // JavaScript/TypeScript: npm audit
  if (fs.existsSync(path.join(repoPath, "package.json"))) {
    if (fs.existsSync(path.join(repoPath, "package-lock.json"))) {
      return "npm audit --json";
    }
  }

  // Python: pip-audit
  if (fs.existsSync(path.join(repoPath, "requirements.txt")) ||
      fs.existsSync(path.join(repoPath, "pyproject.toml"))) {
    try {
      await execCommand("pip-audit --version", repoPath);
      return "pip-audit --format json";
    } catch {
      // pip-audit not available
    }
  }

  // Go: go vuln
  if (fs.existsSync(path.join(repoPath, "go.mod"))) {
    try {
      await execCommand("govulncheck -version", repoPath);
      return "govulncheck ./...";
    } catch {
      // govulncheck not available
    }
  }

  return null;
}

// ── Parse vulnerability scanner JSON output ───────────────────────────────────

function parseVulnJsonOutput(stdout: string, command: string): DeterministicFinding[] {
  try {
    const data = JSON.parse(stdout);
    const findings: DeterministicFinding[] = [];

    // npm audit format
    if (data.vulnerabilities) {
      for (const [, vuln] of Object.entries(data.vulnerabilities as Record<string, any>)) {
        findings.push({
          title: vuln.title ?? vuln.name ?? "Vulnerability",
          severity: mapNpmAuditSeverity(vuln.severity),
          category: "security",
          file: vuln.findings?.[0]?.paths?.[0] ?? vuln.name ?? "",
          line: 0,
          snippet: vuln.url ?? "",
          source: command.includes("npm") ? "npm_audit" : "vuln_scanner",
          ruleId: vuln.cves?.[0] ?? vuln.cwe?.[0] ?? vuln.name ?? "unknown",
          reference: vuln.url ?? undefined,
        });
      }
    }

    // pip-audit format
    if (Array.isArray(data.dependencies)) {
      for (const dep of data.dependencies) {
        for (const vuln of dep.vulns ?? []) {
          findings.push({
            title: vuln.description ?? vuln.advisory ?? "Vulnerability",
            severity: mapPipAuditSeverity(vuln.severity),
            category: "security",
            file: dep.name ?? "",
            line: 0,
            snippet: `${dep.name} ${dep.version}: ${vuln.description ?? "see advisory"}`,
            source: "pip_audit",
            ruleId: vuln.id ?? vuln.cve ?? "unknown",
            reference: vuln.fix_versions?.[0] ? `https://pypi.org/project/${dep.name}/${vuln.fix_versions[0]}/` : undefined,
          });
        }
      }
    }

    return findings;
  } catch {
    return [];
  }
}

function mapNpmAuditSeverity(severity: string): string {
  const map: Record<string, string> = {
    critical: "critical",
    high: "high",
    moderate: "medium",
    low: "low",
    info: "info",
  };
  return map[severity] ?? "medium";
}

function mapPipAuditSeverity(severity: string | null): string {
  if (!severity) return "medium";
  const map: Record<string, string> = {
    CRITICAL: "critical",
    HIGH: "high",
    MEDIUM: "medium",
    LOW: "low",
  };
  return map[severity.toUpperCase()] ?? "medium";
}

// ── Parse linter output ──────────────────────────────────────────────────────

function parseLinterJsonOutput(stdout: string): DeterministicFinding[] | null {
  try {
    const data = JSON.parse(stdout);
    const findings: DeterministicFinding[] = [];

    // ESLint format
    if (Array.isArray(data)) {
      for (const fileResult of data) {
        for (const msg of fileResult.messages ?? []) {
          findings.push({
            title: msg.message ?? "Lint issue",
            severity: mapEslintSeverity(msg.severity),
            category: "maintainability",
            file: fileResult.filePath ?? "",
            line: msg.line ?? 0,
            snippet: msg.source ?? msg.message ?? "",
            source: "eslint",
            ruleId: msg.ruleId ?? "unknown",
            reference: undefined,
          });
        }
      }
      return findings.length > 0 ? findings : null;
    }

    // Ruff format
    if (Array.isArray(data)) {
      // Ruff outputs a flat array of violations
      for (const result of data) {
        findings.push({
          title: result.message ?? "Lint issue",
          severity: mapRuffSeverity(result.severity ?? ""),
          category: "maintainability",
          file: result.filename ?? result.path ?? "",
          line: result.location?.row ?? result.line ?? 0,
          snippet: result.message ?? "",
          source: "ruff",
          ruleId: result.code?.value ?? result.code ?? "unknown",
          reference: result.url ?? undefined,
        });
      }
      return findings.length > 0 ? findings : null;
    }

    return null;
  } catch {
    return null;
  }
}

function parseLinterTextOutput(stdout: string): DeterministicFinding[] {
  // Parse common linter text formats: file:line:col: message
  const findings: DeterministicFinding[] = [];
  const lines = stdout.split("\n");

  for (const line of lines) {
    // Match: file:line:col: severity: message
    const match = line.match(/^(.+?):(\d+):(\d+)?:\s*(error|warning|info):\s*(.+)$/i);
    if (match) {
      findings.push({
        title: match[5] ?? "Lint issue",
        severity: match[4]?.toLowerCase() === "error" ? "high" : match[4]?.toLowerCase() === "warning" ? "medium" : "info",
        category: "maintainability",
        file: match[1] ?? "",
        line: parseInt(match[2] ?? "0", 10),
        snippet: match[5] ?? "",
        source: "linter",
        ruleId: "unknown",
      });
    }
  }

  return findings;
}

function mapEslintSeverity(severity: number): string {
  if (severity === 2) return "high"; // error
  if (severity === 1) return "low";  // warning
  return "info";
}

function mapRuffSeverity(severity: string): string {
  const map: Record<string, string> = {
    FIX: "low",
    WARNING: "medium",
    ERROR: "high",
    FATAL: "critical",
  };
  return map[severity.toUpperCase()] ?? "medium";
}

// ── Command execution ────────────────────────────────────────────────────────

interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function execCommand(command: string, cwd: string): Promise<ExecResult> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
      timeout: 120_000, // 2 minute timeout
    });

    return {
      success: true,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: 0,
    };
  } catch (err: any) {
    // Many linters/vuln scanners exit non-zero when they find issues
    // This is not necessarily an error — the output may still be valid
    return {
      success: true,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.code ?? 1,
    };
  }
}

async function getToolVersion(tool: string): Promise<string> {
  try {
    const result = await execCommand(`${tool} --version`, process.cwd());
    // Extract version number from output like "semgrep 1.50.0"
    const match = (result.stdout + result.stderr).match(/(\d+\.\d+\.\d+)/);
    return match?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ── Format tool findings for the LLM prompt ────────────────────────────────────

export function formatToolFindingsForPrompt(findings: DeterministicFinding[]): string {
  if (findings.length === 0) {
    return "";
  }

  const lines = [
    "## Deterministic Tool Findings (grounding context for your review)",
    "",
    "The following issues were found by deterministic tools BEFORE your review. Use these as verified evidence — you should triage, connect, and amplify these findings in your review. Do not duplicate them verbatim, but reference and build on them.",
    "",
  ];

  // Group by source tool
  const bySource = new Map<string, DeterministicFinding[]>();
  for (const f of findings) {
    const existing = bySource.get(f.source) ?? [];
    existing.push(f);
    bySource.set(f.source, existing);
  }

  for (const [source, sourceFindings] of bySource) {
    lines.push(`### ${source} (${sourceFindings.length} findings)`);
    lines.push("");
    for (const f of sourceFindings) {
      lines.push(`- [${f.severity.toUpperCase()}] ${f.title}`);
      lines.push(`  File: ${f.file}${f.line > 0 ? `:${f.line}` : ""}`);
      if (f.snippet) lines.push(`  ${f.snippet}`);
      if (f.reference) lines.push(`  Ref: ${f.reference}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}