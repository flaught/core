# Roadmap

This is the curated public roadmap for Flaught — sequenced themes, not a task list. The issue list moves continuously; this page moves when themes change. Each theme links out to the GitHub issue(s) that operationalize it.

## Now

### Portability — host-neutral core + pluggable host adapters

Make `flaught/core` forkable onto any git host (GitLab, Gitea/Forgejo, and later Cursor Origin), adaptable there, with valuable adaptations upstreamable back to core on GitHub. The design is a host-neutral review core behind a `HostIntegration` interface, with per-host CI recipes shipped in the repo so forking auto-activates CI.

- **GitLab first** → [flaught/core#29](https://github.com/flaught/core/issues/29) — GitLab CI workflow + merge-request inline comments.

## Next

### Close the benchmark gap

Competitors (CodeRabbit, Open Code Review, Qodo Merge, Greptile) publish validated review-quality benchmarks; Flaught does not. Ship a benchmark methodology (e.g. seeded-bug corpus, precision/recall against known-flawed PRs) and a published results page.

- Public issue to be opened.

## Later / exploring

Themes under evaluation, not yet committed to a build. No public issue yet.

- **Whole-repo semantic index / cross-file context** — Flaught reads a one-hop dependency neighborhood; evaluate whether a full semantic graph is worth the cost/complexity.
- **Auto-implementing fixes** — today Flaught produces findings only; evaluate whether it should also apply fixes.

---

_Maintained by hand. Updated when a theme ships or a new one opens — not per-task._