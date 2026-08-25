# Roadmap

This is the curated public roadmap for Flaught — sequenced themes, not a task list. The issue list moves continuously; this page moves when themes change. Each theme links out to the GitHub issue(s) that operationalize it.

## Now

### Portability — host-neutral core + pluggable host adapters

Make `flaught/core` forkable onto any git host (GitLab, Gitea/Forgejo, and later Cursor Origin), adaptable there, with valuable adaptations upstreamable back to core on GitHub. The design is a host-neutral review core behind a `HostIntegration` interface, with per-host CI recipes shipped in the repo so forking auto-activates CI.

- **GitLab first** → [flaught/core#29](https://github.com/flaught/core/issues/29) — GitLab CI workflow + merge-request inline comments.

### Artifact honesty — the artifact tells the truth about what was reviewed

A finding artifact that says "completed" must not read as "comprehensively reviewed." On a large PR the LLM prompt is truncated to fit a size cap; the artifact now carries an `analysis_completeness` field (schema v3, shipped) so a consumer or merge gate can see whether the LLM saw the whole change or only part of it. Carrying the principle through: deterministic-tool findings aren't categorical ground truth — they have their own false-positive rates and shouldn't be unrefutable — and `confidence` is an ordinal opinion score, not a calibrated probability.

- `analysis_completeness` shipped (schema v3).
- Public issue to be opened — contextualize (don't treat as ground truth) deterministic findings; honest confidence labels; partial-analysis confidence penalty.

## Next

### Close the benchmark gap

Competitors (CodeRabbit, Open Code Review, Qodo Merge, Greptile) publish validated review-quality benchmarks; Flaught does not. The defensible claim isn't "better reviewer" but "better filter": of the findings Flaught surfaces, how many did an experienced engineer agree were worth acting on — the funnel from N generated → N plausible (after the skeptic pass) → N actionable — and how many developer-hours did the false positives cost. Flaught's own required gate on this repo is the longitudinal data source.

- [flaught/core#43](https://github.com/flaught/core/issues/43) — benchmark methodology + published results.

### Advisory-by-default findings

Flaught surfaces findings to act on, not noise that blocks you. Scope-creep detection is advisory by default — a PR isn't blocked because Flaught flags an unrelated hunk — and gating is a per-project choice, not a prescription. The same stance shapes how partial-analysis and low-confidence findings are presented: surfaced with their uncertainty, not silently promoted to blockers.

- Public issue to be opened — scope-creep advisory, not gating.

## Later / exploring

Themes under evaluation, not yet committed to a build. No public issue yet.

- **Whole-repo semantic index / cross-file context** — Flaught reads a one-hop dependency neighborhood (regex-based today); evaluate whether a full semantic graph (tree-sitter) is worth the cost/complexity.
- **Auto-implementing fixes** — today Flaught produces findings only; evaluate whether it should also apply fixes.

---

_Maintained by hand. Updated when a theme ships or a new one opens — not per-task._