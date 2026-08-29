# Roadmap

This is the curated public roadmap for Flaught — sequenced themes, not a task list. The issue list moves continuously; this page moves when themes change. Each theme links out to the GitHub issue(s) that operationalize it.

**The through-line:** Flaught is the independent skeptic for agent-authored code. Every theme below either makes the skeptic harder to game, moves it closer to the agentic loop where the code is actually written, or proves empirically that its findings are worth acting on.

## Now

### Portability — host-neutral core + pluggable host adapters

Make `flaught/core` forkable onto any git host (GitLab, Gitea/Forgejo, and later Cursor Origin), adaptable there, with valuable adaptations upstreamable back to core on GitHub. The design is a host-neutral review core behind a `HostIntegration` interface, with per-host CI recipes shipped in the repo so forking auto-activates CI. The review logic is never re-implemented per host — only the adapter and the recipe.

- **GitLab first** → [flaught/core#29](https://github.com/flaught/core/issues/29) — GitLab CI workflow + merge-request inline comments. This delivers the P1 *and* establishes the pattern every later host copies, so "forkable + adaptable + upstreamable" becomes a property of the project, not a one-off port.

### Gate integrity — the skeptic the author can't silence

An adversarial reviewer sitting next to a coding agent will be optimized against. Today, `flaught dismiss` is available to whatever runs the CLI — including the agent whose code is under review — and reviewer-directed text in a diff (`// reviewer: pre-approved`) reaches the LLM pass unfiltered. The LLM gate is *already required* on this repo, so its credibility is a present concern, not a future one: before Flaught moves closer to the loop, the gate has to be trustworthy at the gate.

- [flaught/core#58](https://github.com/flaught/core/issues/58) — human-attributed dismissals + `--strict-dismissals` CI mode: unattributed dismissals ignored at gate time and reported as `dismissal_rejected`.
- [flaught/core#59](https://github.com/flaught/core/issues/59) — prompt-injection resistance: quarantine reviewer-directed instructions in diffs/comments; adversarial fixtures in the test suite.
- [flaught/core#60](https://github.com/flaught/core/issues/60) — replace "re-run until clean" agent prompts in README/site with the agent-safe workflow (report findings, never dismiss).

### Artifact honesty — the artifact tells the truth about what was reviewed

A finding artifact that says "completed" must not read as "comprehensively reviewed." `analysis_completeness` (schema v3, shipped) records whether the LLM saw the whole change. Carrying the principle through: deterministic-tool findings aren't categorical ground truth — they have their own false-positive rates and shouldn't be unrefutable — `confidence` is an ordinal opinion score, not a calibrated probability, and sometimes the honest verdict is *no verdict*.

- `analysis_completeness` shipped (schema v3).
- Public issue to be opened — contextualize (don't treat as ground truth) deterministic findings; honest confidence labels; partial-analysis confidence penalty.
- Issue to be opened — `insufficient_evidence` finding status: "cannot determine" as a first-class outcome instead of a guess.
- Issue to be opened — `corroboration` field: join deterministic and LLM findings on location; independent agreement is stronger evidence than either alone, and it costs a join step, not new architecture.

## Next

### Native to the agentic loop — Flaught as the loop's exit condition

An agent's loop currently terminates when the author is satisfied with itself. Flaught's place in agentic development is to redefine termination: the loop ends when the skeptic is satisfied or the human is summoned. That means running at loop exit (not just PR time), reviewing the session (not just the last commit), and routing findings — back to the agent when they're mechanically fixable, to the human when they're not.

- Issue to be opened — agent-harness integration: Claude Code Stop hook + Cursor/Codex recipes; full review runs automatically at loop exit.
- Issue to be opened — `agent_fixable` / `human_required` finding partition + gate routing. This is the honest resolution of the gaming problem — the agent may satisfy the skeptic only where satisfying the check and fixing the problem coincide.
- Issue to be opened — fingerprint-based fix verification: when a finding disappears between runs, classify *resolved* vs *evaded*. An `evaded` classification is itself a high-severity finding.
- Issue to be opened — `flaught review --session`: diff against the branch point + cumulative intent-drift detection. Scope drift compounds across iterations; no single commit looks wrong, the sum does.
- Issue to be opened — latency tiers: a fast deterministic inner-loop mode, full pass at loop exit, everything at CI.

### Agent-failure check library — checks aimed at how agents actually fail

Generic review categories target human failure modes. Agent-authored code fails characteristically: weakened tests to get green, hallucinated or typosquatted dependencies, stated intent only partially implemented. Flaught's check library becomes a curated taxonomy of agent pathologies — mostly deterministic, all cheap, none reproducible in an afternoon of prompting.

- [flaught/core#47](https://github.com/flaught/core/issues/47) — test-weakening detection (deleted assertions, `.skip`, loosened matchers) — deterministic.
- [flaught/core#48](https://github.com/flaught/core/issues/48) — dependency sanity check (registry existence, age, downloads, typosquat edit-distance) — deterministic.
- Issue to be opened — scope shortfall detection: the inverse of scope creep — stated intent not fully implemented.
- Issue to be opened (stretch) — mutation testing, opt-in and budgeted: plausible-wrong mutations of changed code that the suite fails to catch.

### Close the benchmark gap

Competitors (CodeRabbit, Open Code Review, Qodo Merge, Greptile) publish validated review-quality benchmarks; Flaught does not. The defensible claim isn't "better reviewer" but "better filter": of the findings Flaught surfaces, how many did an experienced engineer agree were worth acting on — the funnel from N generated → N plausible (after the skeptic pass) → N actionable — and how many developer-hours did the false positives cost. Flaught's own required gate on this repo is the longitudinal data source, and disposition capture is the pipeline that feeds it.

- [flaught/core#43](https://github.com/flaught/core/issues/43) — benchmark methodology + published results.
- Issue to be opened — `flaught confirm <id> --reason` disposition capture now; `flaught stats` (precision by category) once there's history to compute against. Start capturing before anything reads it — cold-start is the enemy.

### Advisory-by-default findings

Flaught surfaces findings to act on, not noise that blocks you. Scope-creep detection is advisory by default — a PR isn't blocked because Flaught flags an unrelated hunk — and gating is a per-project choice, not a prescription. The same stance shapes how partial-analysis and low-confidence findings are presented: surfaced with their uncertainty, not silently promoted to blockers, and how a human is pulled in only when something needs human eyes.

- Public issue to be opened — scope-creep advisory, not gating.
- [flaught/core#49](https://github.com/flaught/core/issues/49) — `--summary` output mode: "N things need your eyes" with top findings only; the full report lives in the JSON.
- [flaught/core#50](https://github.com/flaught/core/issues/50) — `flaught init --paranoid`: zero-question setup, safest defaults, working in five minutes.

## Later / exploring

Themes under evaluation, not yet committed to a build. No public issue yet.

- **Structured rebuttal (the trial loop)** — the agent submits a rebuttal to a finding; a different model evaluates it against the evidence, concedes or holds; the exchange lands in the artifact so the human reads an argument with a verdict, not a findings list. The most differentiating idea on this page, and the most expensive — waits on gate integrity and calibration data.
- **Whole-repo semantic index / cross-file context** — Flaught reads a one-hop dependency neighborhood (regex-based today); evaluate whether a full semantic graph (tree-sitter) is worth the cost/complexity.
- **Auto-implementing fixes** — *resolved, not exploring*: Flaught will not apply fixes. The `agent_fixable` routing above is the answer — findings are handed back to the authoring loop, and Flaught re-verifies. The skeptic that also writes the code stops being the skeptic.

---

*Maintained by hand. Updated when a theme ships or a new one opens — not per-task.*