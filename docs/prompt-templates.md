# Prompt Templates

The LLM prompt is the highest-leverage surface in Flaught — it defines the reviewer's posture, categories, severity definitions, and output format. The `.flaught-prompt/` directory lets you **override or extend** any part of it without forking the code.

## Quick start

```bash
flaught init    # creates .advreview.yml AND .flaught-prompt/ with example files
```

This scaffolds a `.flaught-prompt/` directory alongside your config:

```
.flaught-prompt/
├── system.md.example          # Full system prompt override
├── posture.md.example         # Posture/persona override
├── categories.md.example      # Category definitions override
├── severity.md.example        # Severity definitions override
├── output-format.md.example   # JSON output format override
├── constraints.md.example    # Constraints override
├── system-append.md.example   # Append to system prompt (most common!)
└── user-append.md             # Append to user prompt (already active — no .example)
```

All `.example` files are **inert** — they document what each slot does and show the defaults. To activate one, remove the `.example` suffix:

```bash
cp .flaught-prompt/system-append.md.example .flaught-prompt/system-append.md
# Edit it, then run flaught review
```

## Override vs. append

There are two kinds of template files:

### Override files (full replacement)

These replace an entire section of the prompt. If a section override is present, the built-in default for that section is **not used**.

| File | What it replaces |
|---|---|
| `system.md` | The **entire** system prompt. When present, all other system-*.md overrides are **ignored** (you're providing the full prompt). |
| `posture.md` | Just the posture/persona section ("You are Monsignor Flaught…") |
| `categories.md` | Just the category definitions |
| `severity.md` | Just the severity definitions |
| `output-format.md` | Just the JSON output format specification |
| `constraints.md` | Just the IMPORTANT constraints section |

### Append files (additive)

These are **appended** after the built-in or overridden content. They never replace anything — they only add.

| File | What it does |
|---|---|
| `system-append.md` | Appended to the **end** of the system prompt. Works with both built-in and custom system prompts. |
| `user-append.md` | Appended to the **end** of the user prompt (after the diff and review instructions). |

**`system-append.md` is the most common customization point.** It's the simplest way to add team-specific rules without rewriting the entire prompt.

## Template variables

All template files support `{{variable}}` interpolation. These are resolved when the template is loaded (not at LLM call time).

| Variable | What it produces |
|---|---|
| `{{noise_budget}}` | Formatted noise budget lines from your config (e.g. `"  - critical: max 5 findings\n  - high: max 10 findings"`) |
| `{{categories}}` | The default category definitions text (for reference when overriding categories) |
| `{{severities}}` | The default severity definitions text (for reference when overriding severities) |

Example — a `system-append.md` that references the noise budget:

```markdown
## Additional Rules

Flag any use of `eval()` or `Function()` — these are never allowed in our codebase.

This review must respect the following noise budget:
{{noise_budget}}

All API endpoints must validate input with a schema library (zod, joi, etc.).
```

## Common customizations

### Add team-specific rules (simplest)

```bash
# .flaught-prompt/system-append.md
```

```markdown
## Acme Corp Rules

- All API endpoints must validate input with a schema library (zod, joi, etc.)
- Database queries must use parameterized statements — never string interpolation
- Changes to authentication code must include integration tests
- Flag any use of eval() or Function() — these are never allowed
- We use event-sourcing — flag any direct database writes in the orders domain
```

### Add domain-specific categories

```bash
# .flaught-prompt/categories.md
```

```markdown
CATEGORIES (use exactly these):
- security: Vulnerabilities, injection, auth issues, data exposure
- architecture: Coupling, abstraction problems, separation of concerns violations
- scope-creep: Changes that don't serve the stated PR intent
- test-quality: Missing tests, tests that don't verify the change, insufficient coverage
- performance: Algorithmic concerns, N+1 queries, memory leaks
- maintainability: Naming, documentation debt, confusing logic, dead code
- compliance: HIPAA, PCI-DSS, SOC2, or regulatory violations
- accessibility: A11y violations, missing ARIA labels, keyboard navigation issues
```

### Shift to a security-focused posture

```bash
# .flaught-prompt/posture.md
```

```markdown
You are a security-focused code reviewer. Your job is to find security vulnerabilities, injection risks, and data exposure in this PR. Focus exclusively on security-relevant findings — architecture and maintainability concerns are secondary unless they create a security risk.

POSTURE:
- Argue against merging if you find any security risk, no matter how small.
- Flag every potential vulnerability — injection, auth bypass, data leak, misconfiguration.
- Distinguish between confirmed vulnerabilities and suspected risks.
- If the change has no security implications, say so briefly and move on.
```

### Add project context to the user prompt

```bash
# .flaught-prompt/user-append.md
```

```markdown
## Project Context

This is a payments processing service (Ruby on Rails, PostgreSQL). Key architectural constraints:

- The `Payments::Processor` module is the only code that should directly interact with payment providers
- All monetary values use `Money` objects — never raw floats or integers
- The `AuditLog` model must be written to before any financial state change
- PCI-DSS scope: any change to `app/models/payment_method.rb` or `app/services/payments/` is in-scope

Known tech debt:
- The `app/services/legacy/` directory is being rewritten — flag any scope creep that adds to it
- `config/initializers/00_monkey_patches.rb` should shrink, never grow
```

### Full system prompt override (advanced)

When you need complete control, `system.md` replaces **everything** — the posture, categories, severity, noise budget, output format, and constraints. Individual section overrides (`posture.md`, `categories.md`, etc.) are **ignored** when `system.md` is present.

```bash
# .flaught-prompt/system.md
```

```markdown
You are a compliance reviewer for a healthcare application. Review this PR for HIPAA violations, PHI exposure, and data-handling mistakes.

{{categories}}

SEVERITY (use exactly these):
- critical: PHI breach or HIPAA violation — must fix before merge
- high: Security vulnerability that could lead to data exposure
- medium: Potential compliance issue worth discussing
- low: Minor concern
- info: Observation

NOISE BUDGET — prioritize findings:
{{noise_budget}}

OUTPUT FORMAT — respond with valid JSON only. No markdown, no explanation outside the JSON:
{
  "findings": [
    {
      "severity": "high",
      "category": "compliance",
      "title": "Short imperative title",
      "description": "2-4 sentences explaining the finding and the compliance risk.",
      "file": "path/to/file.ts",
      "line_start": 42,
      "line_end": 45,
      "snippet": "the problematic code line(s)",
      "confidence": 0.85,
      "references": ["https://www.hhs.gov/hipaa/..."]
    }
  ]
}

IMPORTANT:
- Every finding MUST have file, line_start, line_end, and snippet — no exceptions.
- confidence is 0.0-1.0 — be honest about uncertainty.
- Never fabricate code, line numbers, or file paths that don't exist in the provided context.
- When in doubt about PHI, flag it — false positives are acceptable, false negatives are not.
```

**Note:** The noise budget is config-driven, not template-driven. If your `system.md` doesn't include a noise budget section (or the `{{noise_budget}}` variable), Flaught auto-injects one at the end to ensure budget enforcement still works.

## How it works

```
.flaught-prompt/               Config
       │                         │
       ▼                         ▼
  loadTemplates()          loadConfig()
       │                         │
       ▼                         │
  interpolate {{vars}}           │
       │                         │
       ▼                         ▼
  assembleSystemPrompt() ◄── noise_budget from config
       │
       ▼
  buildUserPrompt() ◄── user-append.md
       │
       ▼
  LLM provider.review()
```

1. **Config loads** first — `.advreview.yml` provides `noise_budget`, `prompt.path`, and `prompt.enabled`
2. **Templates load** from `.flaught-prompt/` (or `prompt.path`) — files are read, `{{variables}}` are interpolated
3. **System prompt assembles** — either from a full `system.md` override, or section-by-section from individual overrides + built-in defaults
4. **Noise budget is ensured** — if a full `system.md` override doesn't include it, it's auto-injected
5. **User prompt appends** — `user-append.md` is added after the diff and review instructions
6. **`system-append.md` always appends** — regardless of whether you're using the built-in prompt or a custom one

## Disabling templates

```yaml
# .advreview.yml
prompt:
  enabled: false
```

When disabled, Flaught ignores the `.flaught-prompt/` directory entirely and uses built-in defaults.

## Custom template path

```yaml
# .advreview.yml
prompt:
  path: prompts/flaught   # relative to repo root
  # path: /etc/flaught/templates  # or absolute
```

Default: `.flaught-prompt` (relative to repo root).

## Reference: built-in defaults

These are the built-in prompt sections that get used when no override files are present. They're shown here for reference — you don't need to copy them into your override files unless you're modifying them.

<details>
<summary><strong>DEFAULT_POSTURE</strong></summary>

```
You are Monsignor Flaught — the devil's advocate for code review. Your job is to build the strongest possible case against merging this PR. You are a skeptical senior engineer who didn't write the code and doesn't trust the PR description.

POSTURE:
- Argue against merging. Find reasons this change is dangerous, over-scoped, poorly tested, or architecturally wrong.
- Flag every real risk. Do not hedge or soften findings to be "helpful."
- Distinguish clearly between findings you are certain about and findings you suspect but cannot confirm.
- If the change is genuinely clean, say so briefly — but never rubber-stamp.
```

</details>

<details>
<summary><strong>DEFAULT_CATEGORIES</strong></summary>

```
CATEGORIES (use exactly these):
- security: Vulnerabilities, injection, auth issues, data exposure
- architecture: Coupling, abstraction problems, separation of concerns violations
- scope-creep: Changes that don't serve the stated PR intent
- test-quality: Missing tests, tests that don't verify the change, insufficient coverage
- performance: Algorithmic concerns, N+1 queries, memory leaks
- maintainability: Naming, documentation debt, confusing logic, dead code
```

</details>

<details>
<summary><strong>DEFAULT_SEVERITY</strong></summary>

```
SEVERITY (use exactly these):
- critical: Must fix before merge — data loss, security vulnerability, broken production path
- high: Should fix before merge — significant risk or bug
- medium: Worth discussing — potential issue or improvement
- low: Nitpick or minor style concern
- info: Observation worth noting but not actionable
```

</details>

<details>
<summary><strong>DEFAULT_OUTPUT_FORMAT</strong></summary>

```json
OUTPUT FORMAT — respond with valid JSON only. No markdown, no explanation outside the JSON:
{
  "findings": [
    {
      "severity": "high",
      "category": "security",
      "title": "Short imperative title",
      "description": "2-4 sentences explaining the finding, the risk, and why it matters for this specific change. Be specific about the code — reference file names, function names, and line numbers.",
      "file": "path/to/file.ts",
      "line_start": 42,
      "line_end": 45,
      "snippet": "the problematic code line(s)",
      "confidence": 0.85,
      "references": []
    }
  ]
}
```

</details>

<details>
<summary><strong>DEFAULT_CONSTRAINTS</strong></summary>

```
IMPORTANT:
- Rank findings within each severity tier. If you have 8 medium findings and the budget is 5, include only the 5 most important.
- Every finding MUST have file, line_start, line_end, and snippet — no exceptions.
- confidence is 0.0-1.0 — be honest. If you're guessing, say 0.4-0.5. If you're certain, say 0.9+.
- Never fabricate code, line numbers, or file paths that don't exist in the provided context.
```

</details>

## Programmatic API

The template system is fully accessible from the Node.js API:

```typescript
import {
  loadTemplates,
  assembleSystemPrompt,
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
} from "@flaught/core";

// Load templates from .flaught-prompt/
const templates = loadTemplates(repoRoot, config);

// Build prompts with template overrides
const systemPrompt = buildSystemPrompt(config, templates);
const userPrompt = buildUserPrompt(context, config, prDescription, templates);

// Scaffold the template directory
const dir = initPromptTemplates("/path/to/repo");

// Access built-in defaults for reference
console.log(DEFAULT_POSTURE);
console.log(DEFAULT_CATEGORIES);
```

## Interaction with other features

### Noise budget

The noise budget is always enforced, regardless of prompt overrides. If you provide a `system.md` that doesn't include a noise budget section, Flaught auto-injects one using the values from `.advreview.yml`.

### Dismissals

Prompt template overrides don't affect dismissal fingerprints — those are based on finding content (source, category, title, file), not the prompt that generated them.

### Severity gate

The severity gate (`severity_gate.fail_on` in config) checks finding severities after the LLM response is parsed. If you override `severity.md` to add custom severities, note that the gate only recognizes the five built-in levels (`critical`, `high`, `medium`, `low`, `info`).

### Findings parser

If you override `output-format.md` to change the JSON schema, be aware that `parseFindingsFromLLM()` in the provider expects the default format (`{ findings: [...] }` with `severity`, `category`, `title`, `description`, `file`, `line_start`, `line_end`, `snippet`, `confidence`). Custom schemas may not parse correctly. Override `output-format.md` with caution.