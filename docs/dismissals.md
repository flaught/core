# Dismissals

Flaught's finding `id` (e.g. `D-0001`) is just array position within a single run — it tells you nothing across runs. Without a stable identifier, a false positive you triage today comes back and re-triggers the severity gate on every future PR, forever.

Dismissals solve that: a git-tracked `.flaught-dismissals.json` file records findings a human has reviewed and suppressed, matched by a stable **fingerprint** instead of the run-local id. Once dismissed, a finding still shows up in every report (struck-through, for audit history) but is excluded from the severity gate.

## How matching works

Every finding carries a `fingerprint` field, derived differently depending on its source:

| Source | Fingerprint basis |
|---|---|
| Deterministic (semgrep, linter, vuln scanner) | `source` + the tool's own rule ID (`evidence.rule_id`) + `file` |
| Test inversion | `"test-inversion"` + the flagged test's name |
| LLM | `category` + `file` + a normalized (trimmed, lowercased, whitespace-collapsed) `title` |

Line numbers are deliberately excluded — code shifting up or down shouldn't invalidate a dismissal.

**Known limitation:** LLM findings have no rule ID, so they fingerprint on title text. If the LLM phrases the same underlying issue differently between runs, the fingerprint changes and the old dismissal won't match. This is the conservative failure mode for a governance-critical suppression list — a stale exact-match miss just means the finding reappears for re-triage, not that a real issue silently stays suppressed under the wrong identity.

## Workflow

1. A review runs and produces a finding, e.g. `D-0002`, in `findings.json` (`flaught review --output findings.json`).
2. You determine it's a false positive.
3. Dismiss it:
   ```bash
   flaught dismiss D-0002 \
     --artifact findings.json \
     --reason "False positive — input is sanitized upstream" \
     --by jane@example.com \
     --expires 90d
   ```
   `--by` defaults to `git config user.email` if omitted. `--expires` is optional (`90d`, `4w`, etc.) — omit it for a dismissal that never expires.
4. Commit the resulting `.flaught-dismissals.json` change through a normal PR.
5. On every subsequent run, any finding whose fingerprint matches an active (non-expired) entry is automatically marked `dismissed: true` and excluded from the severity gate — no manual step required.

## CLI reference

```bash
flaught dismiss <finding-id> --artifact <path> --reason <text> [--by <email>] [--expires <duration>]
flaught dismissals list                          # show all entries and their expiry status
flaught dismissals audit [--warn-days 14]         # flag expired/soon-expiring entries; exits 1 if any are expired
flaught dismissals remove <fingerprint>
```

Run `flaught dismissals audit` on a schedule (e.g. weekly, in CI) to force suppressions to be periodically re-confirmed instead of rotting forever — it exits non-zero when any dismissal has actually expired, so it can gate its own job the same way `flaught review` gates a PR.

## Config

```yaml
# .advreview.yml
dismissals:
  enabled: true                        # default
  path: .flaught-dismissals.json       # default, relative to repo root
```

Set `dismissals.enabled: false` to disable dismissal matching entirely (every finding is treated as new on every run).

## Dismissal store format

```json
{
  "version": 1,
  "dismissals": [
    {
      "fingerprint": "sha256:3f9c1a2b4d5e6f70",
      "dismissed_by": "jane@example.com",
      "dismissed_at": "2025-01-15T10:30:00Z",
      "reason": "False positive — input is sanitized upstream",
      "context": {
        "title": "SQL injection vulnerability",
        "file": "src/db/queries.ts"
      },
      "expires_at": "2025-04-15T10:30:00Z"
    }
  ]
}
```

`context` is display-only (shown by `flaught dismissals list`) — it is never used for matching. `expires_at` is `null` for a dismissal that never expires.

## Programmatic API

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
```

`runReview()` already applies the dismissal store automatically when `config.dismissals.enabled` is true (the default) — most integrations won't need these directly. They're exposed for building custom tooling (e.g. a dismissal-review dashboard, or a bot that dismisses on a PR comment command).
