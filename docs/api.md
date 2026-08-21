# Programmatic API

Flaught can be used as a Node.js library for custom integrations, dashboards, or CI systems that aren't GitHub Actions.

## Install

```bash
npm install @flaught/core
```

## Full review

```typescript
import { runReview } from "@flaught/core";

const result = await runReview({
  repoPath: "/path/to/repo",
  baseRef: "main",
  headRef: "feature-branch",
  prDescription: "Fix login redirect bug",
  skipLlm: false,
  onProgress: (msg) => console.error(msg),
});

console.log(result.markdown);   // Markdown report (for PR comments)
console.log(result.json);       // JSON artifact string
console.log(result.exitCode);   // 0 (clean) or 1 (severity gate exceeded) — see note below
console.log(result.artifact);   // Full FindingsArtifact object

// Access structured results
result.artifact.findings.forEach((f) => {
  console.log(`${f.id} [${f.severity}] ${f.title} (${f.source_type})`);
});

// Test inversion results
if (result.artifact.test_inversion) {
  result.artifact.test_inversion.flagged.forEach((t) => {
    console.log(`⚠ Test doesn't verify the change: ${t.test}`);
  });
}

// Scope-creep results
if (result.artifact.scope_creep) {
  result.artifact.scope_creep.flagged_hunks.forEach((h) => {
    console.log(`⚠ Scope creep: ${h.file} (${h.lines}): ${h.reason}`);
  });
}
```

### ReviewResult interface

```typescript
interface ReviewResult {
  context: ReviewContext;        // Assembled diff context
  llmResult: LLMReviewResult | null;  // LLM response (null if --no-llm)
  toolResults: ToolExecuted[];   // Deterministic tool execution records
  artifact: FindingsArtifact;    // Full structured artifact
  markdown: string;              // Markdown PR comment
  json: string;                  // JSON artifact string
  exitCode: number;              // 0=clean, 1=gated (never 2 — see note below)
  durationSeconds: number;       // Total run duration
}
```

**Note:** `exitCode` on a resolved `ReviewResult` is always `0` or `1`. The CLI's exit code `2` (config/API error) isn't a value `runReview()` returns — it happens when `runReview()` *throws* (`MissingAPIKeyError`, `LLMError`, or another error), which the CLI's `handleError()` catches and converts to `process.exit(2)`. A library consumer calling `runReview()` directly should `try`/`catch` for that case instead of checking `exitCode` — see [Error handling](#error-handling) below.

### ReviewOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `repoPath` | `string` | `process.cwd()` | Path to git repository |
| `baseRef` | `string` | merge-base of `main`/`master` and `headRef`; falls back to `HEAD~1` if neither branch exists | Base ref (branch, tag, or SHA) |
| `headRef` | `string` | `HEAD` | Head ref |
| `configPath` | `string` | auto-discovered | Path to `.advreview.yml` |
| `prDescription` | `string` | `undefined` | PR description for scope-creep detection |
| `skipLlm` | `boolean` | `false` | Skip LLM review (deterministic only) |
| `onProgress` | `(msg: string) => void` | no-op | Progress callback |

## Context assembly only

If you only need the diff context (stage 1) without running the full pipeline:

```typescript
import { assembleContext, contextToJSON } from "@flaught/core";

const context = await assembleContext({
  repoPath: "/path/to/repo",
  baseRef: "main",
  headRef: "feature-branch",
});

console.log(contextToJSON(context));
```

### ReviewContext

```typescript
interface ReviewContext {
  repoRoot: string;              // Absolute path to repo
  baseSha: string;               // Resolved base SHA
  headSha: string;               // Resolved head SHA
  diff: string;                   // Raw unified diff
  changedFiles: ChangedFile[];   // Files changed between base and head
  neighborhoodFiles: string[];    // One-hop dependency neighborhood
  dependencyGraph: DependencyGraph; // Full import graph
}
```

## Scope-creep detection only

```typescript
import { detectScopeCreepHeuristic, extractScopeCreepFromFindings } from "@flaught/core";

// Heuristic detection (no LLM needed)
const flagged = detectScopeCreepHeuristic(context, "Fix login redirect bug", config);

// Extract from LLM findings
const scopeCreep = extractScopeCreepFromFindings(findings, "Fix login redirect bug");
```

## Test inversion only

```typescript
import { runTestInversion } from "@flaught/core";

const result = await runTestInversion(
  config,
  "/path/to/repo",
  baseSha,
  headSha,
  (msg) => console.error(msg),
);

if (result) {
  console.log(`Command: ${result.command}`);
  console.log(`Passed on base: ${result.base_passed.length}`);
  console.log(`Passed on head: ${result.head_passed.length}`);
  console.log(`Flagged: ${result.flagged.length}`);
}
```

## Dismissals

`runReview()` applies the persisted dismissal store automatically. The building blocks are also exported for custom tooling (e.g. a review dashboard, or a bot that dismisses on a PR comment command) — see [`docs/dismissals.md`](dismissals.md) for the full workflow.

```typescript
import {
  computeFingerprint,
  loadDismissalStore,
  saveDismissalStore,
  addDismissal,
  removeDismissal,
  findActiveDismissal,
  resolveDismissalsPath,
  applyDismissals,
} from "@flaught/core";

const dismissalsPath = resolveDismissalsPath(repoRoot); // .flaught-dismissals.json by default
const store = loadDismissalStore(dismissalsPath);

const updated = addDismissal(store, {
  fingerprint: someFinding.fingerprint,
  dismissed_by: "jane@example.com",
  dismissed_at: new Date().toISOString(),
  reason: "False positive — sanitized upstream",
  context: { title: someFinding.title, file: someFinding.evidence.file },
  expires_at: null, // or an ISO timestamp for a TTL
});

saveDismissalStore(dismissalsPath, updated);
```

## Prompt templates

The prompt template system is fully accessible from the API. See [`docs/prompt-templates.md`](prompt-templates.md) for the full guide.

```typescript
import {
  loadTemplates,
  assembleSystemPrompt,
  assembleUserAppend,
  buildSystemPrompt,
  buildUserPrompt,
  initPromptTemplates,
  buildTemplateVariables,
  NO_TEMPLATES,
  DEFAULT_POSTURE,
  DEFAULT_CATEGORIES,
  DEFAULT_SEVERITY,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_CONSTRAINTS,
  type PromptTemplates,
  type TemplateVariables,
} from "@flaught/core";

// Load templates from .flaught-prompt/
const templates = loadTemplates(repoRoot, config);

// Build prompts with template overrides
const systemPrompt = buildSystemPrompt(config, templates);
const userPrompt = buildUserPrompt(context, config, prDescription, templates);

// Use NO_TEMPLATES for built-in defaults
const defaultPrompt = buildSystemPrompt(config, NO_TEMPLATES);

// Scaffold the template directory
const dir = initPromptTemplates("/path/to/repo");

// Access built-in defaults for reference
console.log(DEFAULT_POSTURE);
console.log(DEFAULT_CATEGORIES);

// Build template variables for interpolation
const vars = buildTemplateVariables(config);
console.log(vars.noise_budget);
// "  - critical: max 5 findings\n  - high: max 10 findings\n  ..."
```

## Error handling

Flaught throws custom error classes with actionable messages:

```typescript
import { runReview, MissingAPIKeyError, LLMError } from "@flaught/core";

try {
  const result = await runReview({ skipLlm: false });
} catch (err) {
  if (err instanceof MissingAPIKeyError) {
    console.error(`Missing key: ${err.envVarName}`);
    // Suggest: set the env var, switch provider, or use --no-llm
  } else if (err instanceof LLMError) {
    console.error(`LLM error: ${err.message}`);
    console.error(`Provider: ${err.provider}, Model: ${err.model}`);
    console.error(`HTTP status: ${err.statusCode}`);
  } else {
    throw err;
  }
}
```

| Error | When | Key properties |
|---|---|---|
| `MissingAPIKeyError` | API key env var not set or empty | `envVarName` |
| `LLMError` | LLM request fails (auth, timeout, model not found, server down) | `provider`, `model`, `statusCode`, `raw` |