# Flaught — Session Start Prompt

Read the attached brief (`adversarial-review-getting-started-prompt.md`) in full before doing anything else. It covers positioning, core requirements, what's out of scope for v1, the build sequence, and the technical decisions already locked (TypeScript/Node, `@flaught/core`, repo `flaught/core`).

Three decisions are still open. For each, give me: **your recommendation, the alternatives you considered and rejected, and the key tradeoffs** — then stop. Don't start building until I confirm.

1. **Distribution mechanism.** CLI/library installable via npm vs. Docker-based GitHub Action vs. composite Action. The brief has my lean (`@flaught/core` as a standalone package, with a thin `flaught/action` wrapper later) but it's not locked. Convince me or push back.

2. **`.advreview.yml` config schema.** Per-repo stack declaration, severity thresholds, module toggles (which LLM provider, Lighthouse on/off), file/path exclusions. Propose the full schema with field names, types, and defaults.

3. **Findings JSON schema.** This is the most important of the three — it's the backbone of the governance/audit positioning. The brief requires:
   - Versioned (`schema_version` from day one)
   - Self-describing outside any dashboard (repo, PR, commit, timestamps)
   - Every finding carries a field distinguishing **LLM-asserted** from **deterministic-tool-asserted** so evidence quality is legible in the data itself
   - Structured **dismissal fields** (dismissed: bool, dismissed_by, dismissed_at, dismissal_reason) — not free-text afterthoughts
   - Noise budget: cap findings per severity tier, require the LLM to rank/prioritize rather than dump
   - The honest caveat baked in: this artifact is *evidence that scrutiny occurred*, not evidence findings are correct

   Propose the full schema. I'll confirm or push back before we start stage 1 (context assembly).