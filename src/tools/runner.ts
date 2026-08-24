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

  // ── Vulnerability-specific fields (populated by npm_audit, pip-audit, etc.) ──

  /** Human-readable vulnerability description (advisory title) */
  vuln_description?: string;
  /** Affected version range (e.g. "<=6.4.2") */
  vuln_range?: string;
  /** Installed version of the vulnerable package */
  vuln_installed_version?: string;
  /** Whether this is a direct dependency */
  vuln_is_direct?: boolean;
  /** Packages affected by this vulnerability (transitive dependency chain) */
  vuln_effects?: string[];
  /** Available fix: package name and version */
  vuln_fix?: string;
  /** Whether the fix is a SemVer major bump */
  vuln_fix_is_breaking?: boolean;
  /** CWE identifiers */
  vuln_cwe?: string[];
  /** CVSS score */
  vuln_cvss_score?: number;
  /** Advisory URLs */
  vuln_urls?: string[];
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
      command: result.success ? getSemgrepArgs(config).join(" ") : "(failed)",
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

function getSemgrepArgs(config: FlaughtConfig): string[] {
  // SECURITY: Uses argument array (not shell interpolation) to prevent
  // command injection through config.tools.semgrep.config.
  if (config.tools.semgrep.config) {
    return ["semgrep", "--config", config.tools.semgrep.config, "--json", "."];
  }
  return ["semgrep", "--config", "auto", "--json", "."];
}

async function runSemgrep(config: FlaughtConfig, repoPath: string): Promise<ToolResult> {
  const args = getSemgrepArgs(config);
  const startTime = Date.now();

  try {
    const result = await execCommandSafe(args, repoPath);
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
  const userCommand = config.tools.linter.command;
  const autoCommand = !userCommand ? await detectLinterCommand(repoPath) : null;
  const command = userCommand ?? autoCommand;
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
    // SECURITY: User-configured commands run through a shell (the user explicitly
    // controls the entire command string). Auto-detected commands use safe argument
    // arrays to prevent injection.
    const isUserCommand = Boolean(userCommand);
    const result = isUserCommand
      ? await execCommandShell(command, repoPath)
      : await execCommandSafe(shellToArgs(command), repoPath);
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
      await execCommandSafe(["ruff", "check", "--version"], repoPath);
      return "ruff check --output-format json .";
    } catch {
      // ruff not available
    }
    // Try flake8
    try {
      await execCommandSafe(["flake8", "--version"], repoPath);
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
  const userCommand = config.tools.vuln_scanner.command;
  const autoCommand = !userCommand ? await detectVulnCommand(repoPath) : null;
  const command = userCommand ?? autoCommand;
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
    // SECURITY: User-configured commands run through a shell (the user explicitly
    // controls the entire command string). Auto-detected commands use safe argument
    // arrays to prevent injection.
    const isUserCommand = Boolean(userCommand);
    const result = isUserCommand
      ? await execCommandShell(command, repoPath)
      : await execCommandSafe(shellToArgs(command), repoPath);
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
      await execCommandSafe(["pip-audit", "--version"], repoPath);
      return "pip-audit --format json";
    } catch {
      // pip-audit not available
    }
  }

  // Go: go vuln
  if (fs.existsSync(path.join(repoPath, "go.mod"))) {
    try {
      await execCommandSafe(["govulncheck", "-version"], repoPath);
      return "govulncheck ./...";
    } catch {
      // govulncheck not available
    }
  }

  return null;
}

// ── Parse vulnerability scanner JSON output ───────────────────────────────────

export function parseVulnJsonOutput(stdout: string, command: string): DeterministicFinding[] {
  try {
    const data = JSON.parse(stdout);
    const findings: DeterministicFinding[] = [];

    // npm audit format
    if (data.vulnerabilities) {
      for (const [, vuln] of Object.entries(data.vulnerabilities as Record<string, NpmAuditVulnerability>)) {
        // npm audit `via` can be a string array (package names) or an array of
        // advisory objects with title, url, severity, cwe, cvss, etc.
        // We want the richest data available.
        const viaAdvisories: NpmAuditAdvisory[] = Array.isArray(vuln.via)
          ? vuln.via.filter((v): v is NpmAuditAdvisory => typeof v === "object" && v !== null)
          : [];

        // Use the highest-severity advisory for the canonical title/description
        const primaryAdvisory = viaAdvisories.length > 0
          ? viaAdvisories.sort((a, b) => {
              const order: Record<string, number> = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
              return (order[a.severity ?? ""] ?? 2) - (order[b.severity ?? ""] ?? 2);
            })[0]
          : null;

        // Build a descriptive title: "<package>: <advisory title>" or "<package>: <vulnerability>"
        const pkgName = vuln.name ?? "unknown";
        const advisoryTitle = primaryAdvisory?.title ?? null;
        const title = advisoryTitle
          ? `${pkgName}: ${advisoryTitle}`
          : `${pkgName}: Vulnerability in ${pkgName}${vuln.range ? ` (${vuln.range})` : ""}`;

        // Build a human-readable description with fix info
        const descriptionParts: string[] = [];
        if (viaAdvisories.length > 1) {
          descriptionParts.push(`${viaAdvisories.length} advisories affect this package.`);
          for (const adv of viaAdvisories) {
            descriptionParts.push(`- ${adv.title ?? adv.name ?? "Unknown"} (${adv.severity ?? "unknown"} severity)${adv.url ? ` — ${adv.url}` : ""}`);
          }
        } else if (viaAdvisories.length === 1) {
          descriptionParts.push(viaAdvisories[0]?.title ?? "Vulnerability found by npm audit.");
        }

        if (vuln.isDirect) {
          descriptionParts.push("Direct dependency.");
        } else {
          descriptionParts.push("Transitive dependency.");
        }

        if (vuln.effects && vuln.effects.length > 0) {
          descriptionParts.push(`Affected via: ${vuln.effects.join(" → ")}.`);
        }

        if (vuln.fixAvailable) {
          const fix = vuln.fixAvailable;
          const breaking = fix.isSemVerMajor ? " (breaking change)" : "";
          descriptionParts.push(`Fix available: update ${fix.name} to ${fix.version}${breaking}.`);
        } else {
          descriptionParts.push("No fix available.");
        }

        // Collect all advisory URLs for references
        const advisoryUrls = viaAdvisories
          .map((v) => v.url)
          .filter((u): u is string => typeof u === "string" && u.length > 0);

        // Collect all CWEs
        const cwes = viaAdvisories.flatMap((v) =>
          Array.isArray(v.cwe) ? v.cwe : (v.cwe ? [v.cwe] : [])
        );

        // Use the highest CVSS score across advisories
        const cvssScore = viaAdvisories.reduce((max: number, v) => {
          const score = v.cvss?.score;
          return typeof score === "number" && score > max ? score : max;
        }, 0);

        // snippet: concise technical summary for evidence block
        // vuln_description: full human-readable narrative for description field
        const snippetParts: string[] = [];
        if (vuln.range) snippetParts.push(`Affected: ${pkgName} ${vuln.range}`);
        if (vuln.isDirect) {
          snippetParts.push("Direct dependency.");
        } else if (vuln.effects && vuln.effects.length > 0) {
          snippetParts.push(`Via: ${vuln.effects.join(" → ")}`);
        }
        if (vuln.fixAvailable) {
          const fix = vuln.fixAvailable;
          const breaking = fix.isSemVerMajor ? " (breaking)" : "";
          snippetParts.push(`Fix: ${fix.name}@${fix.version}${breaking}`);
        } else {
          snippetParts.push("No fix available.");
        }

        findings.push({
          title,
          severity: mapNpmAuditSeverity(vuln.severity ?? "medium"),
          category: "security",
          file: vuln.findings?.[0]?.paths?.[0] ?? pkgName,
          line: 0,
          snippet: snippetParts.join(" "),
          source: command.includes("npm") ? "npm_audit" : "vuln_scanner",
          ruleId: cwes?.[0] ?? primaryAdvisory?.title?.substring(0, 60) ?? pkgName,
          reference: advisoryUrls[0] ?? undefined,
          vuln_description: descriptionParts.join(" "),
          vuln_range: vuln.range ?? undefined,
          vuln_installed_version: vuln.nodes?.[0]?.replace("node_modules/", "") ?? undefined,
          vuln_is_direct: vuln.isDirect ?? undefined,
          vuln_effects: Array.isArray(vuln.effects) && vuln.effects.length > 0 ? vuln.effects : undefined,
          vuln_fix: vuln.fixAvailable
            ? `${vuln.fixAvailable.name}@${vuln.fixAvailable.version}`
            : undefined,
          vuln_fix_is_breaking: vuln.fixAvailable?.isSemVerMajor ?? undefined,
          vuln_cwe: cwes.length > 0 ? cwes : undefined,
          vuln_cvss_score: cvssScore > 0 ? cvssScore : undefined,
          vuln_urls: advisoryUrls.length > 0 ? advisoryUrls : undefined,
        });
      }
    }

    // pip-audit format
    if (Array.isArray(data.dependencies)) {
      for (const dep of data.dependencies) {
        for (const vuln of dep.vulns ?? []) {
          const fixVersion = vuln.fix_versions?.[0];
          findings.push({
            title: `${dep.name}: ${vuln.description ?? vuln.advisory ?? "Vulnerability"}`,
            severity: mapPipAuditSeverity(vuln.severity),
            category: "security",
            file: dep.name ?? "",
            line: 0,
            snippet: `${dep.name} ${dep.version}: ${vuln.description ?? "see advisory"}${fixVersion ? ` Fix: upgrade to ${fixVersion}.` : ""}`,
            source: "pip_audit",
            ruleId: vuln.id ?? vuln.cve ?? "unknown",
            reference: fixVersion ? `https://pypi.org/project/${dep.name}/${fixVersion}/` : undefined,
            vuln_description: vuln.description ?? vuln.advisory,
            vuln_installed_version: dep.version ?? undefined,
            vuln_fix: fixVersion ? `${dep.name}@${fixVersion}` : undefined,
            vuln_urls: vuln.urls ?? (vuln.url ? [vuln.url] : undefined),
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

/**
 * Shape of the error thrown by Node's child_process exec when the process
 * exits non-zero: it carries the captured stdout/stderr and an exit code.
 * Linters/vuln scanners often exit non-zero on findings while still emitting
 * valid output, so we read those fields rather than treating it as fatal.
 */
interface ExecError {
  stdout?: string;
  stderr?: string;
  code?: number | string;
}

/**
 * Minimal shape of an npm-audit `vulnerabilities[<pkg>].via` advisory entry —
 * only the fields parseVulnJsonOutput reads. The real npm audit schema is
 * richer and varies by version; this is a deliberately narrow view over
 * untrusted JSON (validated by usage, not by a full schema).
 */
interface NpmAuditAdvisory {
  title?: string;
  name?: string;
  url?: string;
  severity?: string;
  cwe?: string | string[];
  cvss?: { score?: number };
}

/**
 * Minimal shape of an npm-audit `vulnerabilities[<pkg>]` entry. `via` is an
 * array of either a package-name string (transitive) or an advisory object;
 * `fixAvailable` is either a boolean or an object describing the fix.
 */
interface NpmAuditVulnerability {
  name?: string;
  via?: Array<string | NpmAuditAdvisory>;
  range?: string;
  isDirect?: boolean;
  severity?: string;
  effects?: string[];
  nodes?: string[];
  findings?: Array<{ paths?: string[] }>;
  // npm audit's fixAvailable is either an object (fix detail) or `true`. The
  // code below assumes the object form; the rare `true` case degrades to
  // undefined fields (matching prior `any` behavior), so we type it as the
  // object form to match the existing assumption without changing behavior.
  fixAvailable?: { name: string; version: string; isSemVerMajor?: boolean };
}

// ── Safe command execution (argument array, no shell) ──────────────────────────

async function execCommandSafe(args: string[], cwd: string, timeoutMs: number = 120_000): Promise<ExecResult> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout, stderr } = await execFileAsync(args[0]!, args.slice(1), {
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
      timeout: timeoutMs,
      shell: false,
    });

    return {
      success: true,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: 0,
    };
  } catch (err) {
    const e = err as ExecError;
    // Many linters/vuln scanners exit non-zero when they find issues
    // This is not necessarily an error — the output may still be valid
    return {
      success: true,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

// ── Shell-based command execution (for user-configured commands) ──────────────
//
// SECURITY: This function runs a command string through a shell. It is ONLY
// used for user-configured command strings (linter.command, vuln_scanner.command)
// where the user explicitly controls the entire command. Auto-detected commands
// and semgrep use execCommandSafe (argument array, no shell) instead.

async function execCommandShell(command: string, cwd: string, timeoutMs: number = 120_000): Promise<ExecResult> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
      timeout: timeoutMs,
    });

    return {
      success: true,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: 0,
    };
  } catch (err) {
    const e = err as ExecError;
    // Many linters/vuln scanners exit non-zero when they find issues
    // This is not necessarily an error — the output may still be valid
    return {
      success: true,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

async function getToolVersion(tool: string): Promise<string> {
  try {
    const result = await execCommandSafe([tool, "--version"], process.cwd());
    // Extract version number from output like "semgrep 1.50.0"
    const match = (result.stdout + result.stderr).match(/(\d+\.\d+\.\d+)/);
    return match?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ── Shell command to argument array ─────────────────────────────────────────
//
// Split a simple shell command string into an argument array for safe execution.
// This is a minimal parser that handles the auto-detected command strings —
// which are all well-known, simple commands. It is NOT a general-purpose shell
// parser. User-configured commands go through execCommandShell (the user
// explicitly controls the entire command string).

function shellToArgs(command: string): string[] {
  // Split on whitespace, respecting basic double-quoted strings.
  // This handles the known auto-detected commands correctly but is NOT
  // suitable for arbitrary user input — that path uses execCommandShell.
  const args: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const char of command) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ' ' && !inQuotes) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    args.push(current);
  }

  return args;
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
      if (f.line > 0) {
        lines.push(`  File: ${f.file}:${f.line}`);
      } else if (f.file) {
        lines.push(`  Package/Path: ${f.file}`);
      }
      if (f.vuln_description) {
        lines.push(`  ${f.vuln_description}`);
      } else if (f.snippet) {
        lines.push(`  ${f.snippet}`);
      }
      if (f.vuln_range) lines.push(`  Affected versions: ${f.vuln_range}`);
      if (f.vuln_is_direct === true) {
        lines.push("  Direct dependency.");
      } else if (f.vuln_is_direct === false) {
        if (f.vuln_effects && f.vuln_effects.length > 0) {
          lines.push(`  Transitive dependency (via ${f.vuln_effects.join(" → ")}).`);
        } else {
          lines.push("  Transitive dependency.");
        }
      }
      if (f.vuln_fix) {
        const breaking = f.vuln_fix_is_breaking ? " (breaking change)" : "";
        lines.push(`  Fix: update to ${f.vuln_fix}${breaking}.`);
      }
      if (f.vuln_cvss_score && f.vuln_cvss_score > 0) {
        lines.push(`  CVSS score: ${f.vuln_cvss_score}`);
      }
      if (f.vuln_cwe && f.vuln_cwe.length > 0) {
        lines.push(`  CWE: ${f.vuln_cwe.join(", ")}`);
      }
      const refs: string[] = [];
      const seenRefs = new Set<string>();
      if (f.reference && !seenRefs.has(f.reference)) {
        refs.push(f.reference);
        seenRefs.add(f.reference);
      }
      if (f.vuln_urls) {
        for (const url of f.vuln_urls) {
          if (!seenRefs.has(url)) {
            refs.push(url);
            seenRefs.add(url);
          }
        }
      }
      if (refs.length > 0) lines.push(`  Refs: ${refs.join(", ")}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}