# Findings schema

Every finding carries a `source_type` field that distinguishes **deterministic** (tool-asserted) from **LLM-asserted** evidence. This is the governance-critical field — it tells you whether a finding came from a tool that always produces the same output, or from an LLM that may hallucinate.

The schema is versioned from day one — currently `schema_version: 2` — and self-describing (`$schema` URL). Every artifact includes the `_caveat` field — an honest disclaimer about what the data represents.

## Finding structure

```json
{
  "id": "D-0001",
  "severity": "high",
  "category": "security",
  "title": "SQL injection vulnerability",
  "description": "semgrep found: SQL injection vulnerability (sql-injection)",
  "evidence": {
    "file": "src/db/queries.ts",
    "line_start": 42,
    "line_end": 42,
    "snippet": "const result = db.query(`SELECT * FROM users WHERE id = ${userId}`)",
    "blast_radius": ["src/api/users.ts:15", "src/middleware/auth.ts:8"],
    "rule_id": "sql-injection"
  },
  "source": "semgrep",
  "source_type": "deterministic",
  "confidence": 1.0,
  "references": ["https://semgrep.dev/r/sql-injection"],
  "fingerprint": "sha256:3f9c1a2b4d5e6f70",
  "dismissed": false,
  "dismissed_by": null,
  "dismissed_at": null,
  "dismissal_reason": null
}
```

## ID prefixes

| Prefix | Source | Confidence |
|---|---|---|
| `D-` | Deterministic tool finding (semgrep, linter, vuln scanner) | Always 1.0 |
| `F-` | LLM-asserted finding, or a flagged test-inversion result | LLM findings: self-reported, typically 0.5–0.9. Test-inversion findings: always 1.0 |

**Note:** `id` prefix tracks *when in the pipeline* a finding was assigned an id, not `source_type`. Test-inversion findings get an `F-` id even though their `source_type` is `"deterministic"` (confidence 1.0, no hallucination risk) — don't use the id prefix as a proxy for `source_type` when filtering; check `source_type` directly instead.

`id` is **run-local** — it's just array position and is not stable across runs. Use `fingerprint` for anything that needs to identify "the same finding" across separate runs (most notably, [dismissals](dismissals.md)). `evidence.rule_id` is the source tool's own stable check/rule identifier (e.g. a semgrep `check_id`); it's `null` for LLM findings and test-inversion findings, which have no such concept.

## Severity levels

| Level | Meaning | Noise budget default |
|---|---|---|
| `critical` | Must fix before merge (security vulnerabilities, data loss) | 5 |
| `high` | Should fix before merge (logic errors, missing auth) | 10 |
| `medium` | Worth discussing (test quality, minor scope creep) | 15 |
| `low` | Cosmetic or style issue | 20 |
| `info` | Informational note, no action required | 25 |

## Categories

| Category | What it catches |
|---|---|
| `security` | Vulnerabilities, auth issues, injection |
| `architecture` | Design problems, coupling, abstraction issues |
| `scope-creep` | Changes unrelated to the stated PR intent |
| `test-quality` | Tests that don't verify the change |
| `performance` | N+1 queries, unnecessary allocations |
| `maintainability` | Readability, naming, dead code |

## Source types

| `source_type` | Meaning | How it got here |
|---|---|---|
| `deterministic` | Tool-asserted, reproducible | Semgrep, linter, vuln scanner, test inversion |
| `llm` | Model-asserted, may hallucinate | LLM adversarial review |

## Dismissal fields

Findings are never deleted — they're dismissed with structured disposition data. This is for audit trails, not for erasing findings:

```json
{
  "dismissed": true,
  "dismissed_by": "jane@example.com",
  "dismissed_at": "2025-01-15T10:30:00Z",
  "dismissal_reason": "False positive — the input is sanitized upstream"
}
```

All four fields (`dismissed`, `dismissed_by`, `dismissed_at`, `dismissal_reason`) are present on every finding, defaulting to `false`/`null`/`null`/`null`. These are set automatically on every run by matching `fingerprint` against the persisted dismissal store — see [dismissals](dismissals.md) for the full workflow.

## Full artifact structure

The JSON artifact (`--output findings.json`) is a complete, self-contained record:

```json
{
  "$schema": "https://flaught.dev/schemas/findings/v2.schema.json",
  "schema_version": 2,
  "_caveat": "This artifact is evidence that adversarial scrutiny occurred on this PR. It is NOT evidence that findings are correct. LLM-asserted findings may include hallucinations. Deterministic-tool findings have their own false-positive rates. Treat this as a prompt for human review, not as audit-truth.",
  "generated_at": "2025-01-15T10:25:00Z",
  "flaught_version": "0.2.0",

  "repository": {
    "name": "my-repo",
    "url": "",
    "branch": ""
  },

  "pull_request": {
    "number": null,
    "url": null,
    "title": null,
    "description": null,
    "base_sha": "abc123def456...",
    "head_sha": "def456abc789..."
  },

  "run": {
    "id": "flaught-1705315500-a3b2c1",
    "ci_url": null,
    "duration_seconds": 45
  },

  "tools_executed": [
    {
      "tool": "semgrep",
      "version": "1.60.0",
      "exit_code": 0,
      "raw_findings_count": 2,
      "command": "semgrep --json --config auto ."
    },
    {
      "tool": "eslint",
      "version": "8.56.0",
      "exit_code": 0,
      "raw_findings_count": 0,
      "command": "eslint --format json ."
    },
    {
      "tool": "npm_audit",
      "version": "10.2.3",
      "exit_code": 1,
      "raw_findings_count": 5,
      "command": "npm audit --json"
    }
  ],

  "findings": [
    {
      "id": "D-0001",
      "severity": "high",
      "category": "security",
      "title": "SQL injection vulnerability",
      "description": "semgrep found: SQL injection vulnerability (sql-injection)",
      "evidence": {
        "file": "src/db/queries.ts",
        "line_start": 42,
        "line_end": 42,
        "snippet": "const result = db.query(`SELECT * FROM users WHERE id = ${userId}`)",
        "blast_radius": ["src/api/users.ts:15", "src/middleware/auth.ts:8"],
        "rule_id": "sql-injection"
      },
      "source": "semgrep",
      "source_type": "deterministic",
      "confidence": 1.0,
      "references": ["https://semgrep.dev/r/sql-injection"],
      "fingerprint": "sha256:3f9c1a2b4d5e6f70",
      "dismissed": false,
      "dismissed_by": null,
      "dismissed_at": null,
      "dismissal_reason": null
    }
  ],

  "test_inversion": {
    "command": "npm test",
    "base_passed": ["test A", "test B"],
    "head_passed": ["test A", "test B"],
    "flagged": [
      {
        "test": "test A",
        "reason": "Passes on both base and head — doesn't test the change"
      }
    ]
  },

  "scope_creep": {
    "pr_intent": "Fix login redirect bug",
    "flagged_hunks": [
      {
        "file": ".eslintrc.json",
        "lines": "1-5",
        "reason": "Linter configuration change unrelated to stated PR intent"
      }
    ]
  },

  "noise_budget": {
    "critical": { "limit": 5, "used": 0 },
    "high": { "limit": 10, "used": 1 },
    "medium": { "limit": 15, "used": 3 },
    "low": { "limit": 20, "used": 0 },
    "info": { "limit": 25, "used": 0 }
  },

  "summary": {
    "total_findings": 4,
    "by_severity": {
      "critical": 0,
      "high": 1,
      "medium": 3,
      "low": 0,
      "info": 0
    },
    "by_source_type": {
      "deterministic": 2,
      "llm": 2
    },
    "by_category": {
      "security": 1,
      "test-quality": 1,
      "maintainability": 2
    },
    "dismissed_count": 0
  }
}
```

## Blast radius

The `evidence.blast_radius` field on each finding lists files in the one-hop dependency neighborhood that are affected by the changed file. This is computed by Flaught's import parser, which supports:

- JavaScript/TypeScript (ESM and CJS imports, `.js` → `.ts` resolution)
- Python (`import` and `from ... import`)
- Go (`import`)

## Schema versioning

The schema uses integer versioning. The current version is `2` (bumped from `1` when `fingerprint` and `evidence.rule_id` were added — see [dismissals](dismissals.md)). Breaking changes will increment the version. The `$schema` URL points to a JSON Schema document for validation.

The `_caveat` field is always present and never stripped — it's an honest disclaimer about what the artifact represents and what it doesn't.