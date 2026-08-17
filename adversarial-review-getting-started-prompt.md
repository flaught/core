# Project Brief: Adversarial PR Review Tool ("Flaught")

## Naming and repo structure

This project is named **Flaught**, after Monsignor Flaught, the *advocatus diaboli* (devil's advocate) in *A Canticle for Leibowitz* — the Church's designated skeptic, whose job is to build the strongest possible case against something everyone else wants to approve. That's the posture this tool should take toward every PR.

Repo: `flaught/core` (GitHub org `flaught`, MIT licensed, public from the start). The org structure leaves room for companion repos later — e.g. `flaught/action` for a thin GitHub Action wrapper, or `flaught/cli` — without renaming anything. npm package name: `@flaught/core`, scoped to match.

## Positioning

Flaught is **adversarial governance tooling for AI-assisted development**, not another AI code review assistant. The category is crowded (PR-Agent, CodeRabbit, Qodo Merge, Copilot code review, Sourcery, Greptile) and mostly optimizes for "helpful suggestions on a PR." Flaught's pitch is different: it produces a structured, timestamped record that independent adversarial scrutiny occurred on every PR — what was checked, what was flagged, what was dismissed and by whom. That's a governance/audit artifact, not a productivity nudge, and it's aimed at teams (public sector, regulated industries) that need to show scrutiny happened, not just get better code suggestions.

**Important honest caveat, stated for pi.dev and any future contributor/user:** the JSON output is evidence that *scrutiny occurred*, not evidence that findings are *correct*. If the LLM hallucinates a finding, the artifact faithfully preserves a hallucination — that's a real risk that governance framing makes higher-stakes, not lower. No existing compliance framework (SOC2, FedRAMP, NIST) has a named control this satisfies; "audit-ready" language should never be used in marketing copy without that caveat attached. This is a bet on where practice is heading, not a claim of certified compliance today.

**Scope discipline:** the positioning is broad; the v1 build is not. Do not build a dashboard, multi-model consensus scoring, or any hosted/aggregated data service for v1 — see Explicitly Out of Scope below. The governance story should be true by construction of a well-designed, versioned findings schema (see requirement 8 and the JSON schema decision below), not by building analytics on top of it. Let the README narrate the roadmap; let the MVP stay narrow.

## What we're building

A standalone, pluggable adversarial code review tool that runs in CI against any PR/branch. It uses a **swappable LLM provider** to perform a skeptical architecture and security review, combined with deterministic static analysis, and produces a structured findings report. It should be repo-agnostic — configured per-project via a single YAML file — so it can be dropped into multiple unrelated repos (a Python/FastAPI + React PWA, a Python MCP server, etc.) without rewrites.

This is explicitly an *adversarial* reviewer: its job is to find reasons not to merge, not to rubber-stamp. Think "second opinion from a skeptical senior engineer who didn't write the code and doesn't trust the PR description."

## Core requirements

1. **Diff + context understanding** — not just the raw diff. Assemble the changed files plus a one-hop dependency neighborhood (what calls/imports the changed symbols) so the tool can reason about blast radius, not just guess from filenames.
2. **Deterministic tooling first** — run semgrep, a linter appropriate to the target repo's stack, and a dependency vulnerability scanner appropriate to that stack (e.g. `npm audit`, `pip-audit`, `cargo audit` — whichever fits the repo being reviewed) *before* the LLM runs. Pass these results into the LLM prompt as grounding context so the model triages and connects findings instead of hallucinating new ones.
3. **LLM adversarial pass** — the review model is swappable behind a single provider interface: drop in an API key for Groq, OpenAI, Gemini, etc., or point at a local Ollama endpoint, and switch providers via config with no code changes. Whatever model is selected reviews the diff + context + tool findings and returns **structured JSON**: each finding has severity, category (security / architecture / scope-creep / test-quality), file:line, evidence, and a confidence score. Guidance to end users (documented, not hardcoded): use a different model family than whatever LLM you used to write the code being reviewed — the value of this tool comes from a genuinely independent second opinion, and a model reviewing its own likely output tends to miss its own blind spots.
4. **Unnecessary-change / scope-creep detection** — given the PR description (or linked issue), flag diff hunks that don't serve the stated intent: drive-by refactors, formatting churn, dead code, unrelated file touches.
5. **Test usefulness — measured, not vibe-checked.** Do NOT let the LLM subjectively rate test quality as the primary signal. Instead: run the bundled/changed tests against the pre-change code (git stash the diff, or checkout base branch, run tests). If tests pass on both pre- and post-change code, they don't actually test the change — flag them. This is cheap poor-man's mutation testing and should be the backbone of the test-quality section. LLM commentary on missing edge cases is a secondary, qualitative layer on top of this.
6. **Optional Lighthouse module** — only runs if a `preview_url` is configured or the tool can build/run a container from a Dockerfile in the target repo. Must degrade cleanly (skip, not fail) when unavailable, since some target repos (e.g. an MCP server) have no frontend at all.
7. **Report output** — Markdown for a PR comment (sections collapsed by severity) AND a JSON artifact (for trend tracking across PRs over time). Exit code should be configurable to gate merges based on severity thresholds.
8. **Noise budget** — cap findings per severity tier, require the LLM to rank/prioritize rather than dump everything, and support a dismissal/false-positive log in the JSON schema so findings can be marked "reviewed, not actionable" without disappearing from history.

## Explicitly out of scope for v1

- Auto-fixing anything — this tool reports, it doesn't patch.
- Being tied to any single repo's stack. Config-driven stack detection (or explicit config) over hardcoded assumptions.
- A hosted dashboard/UI. JSON + Markdown artifacts are enough for now.
- **Multi-model consensus/disagreement scoring.** Genuinely valuable (running two providers and flagging where they disagree is a real differentiator), but it doubles LLM cost per PR and the "how do we score disagreement" question isn't trivially resolved — a v2 feature, not MVP.
- **Any dashboard or longitudinal trend analysis across PRs.** The JSON schema should be *designed* to support this later (stable, versioned, includes repo/PR identifiers and timestamps) but no analytics, aggregation, or visualization ships in v1.
- **Any centralized/hosted data collection across users or repos.** This stays a local, self-hosted CLI/library. Aggregating dismissal logs or findings across users would be a different (and much bigger, monetization-shaped) project.

## Relationship to existing tools

PR-Agent (Qodo/CodiumAI, MIT, Python) is the closest existing open source tool — self-hosted, GitHub Action native, already provider-agnostic via LiteLLM. Flaught is not attempting to match its breadth (`/describe`, `/improve`, `/ask`, changelog generation). The two genuine differentiators worth building are: (1) test-inversion as a deterministic ground-truth check rather than LLM opinion on test quality, and (2) adversarial-by-default as a structural scoring/workflow constraint (arguing the strongest case *against* merging) rather than a system-prompt tone adjustment on top of a fundamentally helpful-assistant design. Everything else (Lighthouse, blast-radius via dependency graph, cross-model guidance) is valuable but is the kind of thing PR-Agent or similar could plausibly add — don't over-index the pitch on those alone.

## Suggested build sequence (MVP first)

1. Context assembly (diff + one-hop dependency neighborhood) — this is the highest-leverage, most-often-underbuilt piece; get it right first.
2. LLM adversarial pass with structured JSON output + the report renderer (Markdown + JSON).
3. Deterministic tool integration (semgrep/lint/vuln scan) as grounding context for the LLM.
4. Test-inversion check (run tests pre/post diff).
5. Scope-creep detection using PR description as intent anchor.
6. Optional Lighthouse module last — it's stack-specific and shouldn't block the general architecture.

Validate stages 1–2 end to end against a real PR from an existing project before building further stages.

## Technical decisions to make up front (pi.dev should ask or propose, don't assume)

- **Implementation language/runtime: TypeScript on Node.js.** This is decided, not open — native fit for GitHub Actions (the `actions/toolkit` libraries assume Node), and it keeps the tool itself lightweight rather than pulling in a JVM or Python runtime for what is fundamentally an orchestration layer around CLI tools and API calls. Semgrep, pip-audit, and other scanners are invoked as external processes regardless of the tool's own language, so there's no Python-ecosystem tax to pay for using them. Use `@octokit` for GitHub API/PR interactions and `simple-git` or shell-out to `git` for diff mechanics. Tree-sitter has solid native Node bindings for the dependency-neighborhood analysis in stage 1.
- **Distribution mechanism** — Docker-based GitHub Action vs. composite action vs. installable CLI invoked from any CI. Should support "drop into any repo" as the design goal. Given the `flaught/core` + future-companion-repo structure, lean toward `flaught/core` being a standalone installable package (CLI + library) that a thin `flaught/action` repo wraps later, rather than baking Action-specific concerns into core itself — but confirm this tradeoff explicitly rather than assuming it.
- **Config schema** for `.advreview.yml` — per-repo stack declaration, severity thresholds, which modules are enabled (Lighthouse on/off, which LLM provider/model), file/path exclusions.
- **LLM provider abstraction** — a single interface (e.g. an adapter per provider implementing one `review()` method) supporting at minimum: any OpenAI-compatible API endpoint (covers Groq, OpenAI, and most hosted providers with one adapter), and local Ollama. Provider + model + API key are set via config/env vars, swappable without touching code. This is core to the tool's value: a genuine cross-model second opinion, not a review from the same model family that wrote the code.
- **Findings JSON schema** — this is the backbone of the governance positioning, so treat it as a first-class design artifact, not an afterthought. Needs to be stable/versioned (include a schema version field from day one), include repo/PR/commit identifiers and timestamps so records are self-describing outside of any dashboard, and clearly distinguish finding fields (what was flagged) from disposition fields (dismissed/accepted, by whom, when, why) so the dismissal log in requirement 8 is structured data rather than a free-text afterthought. Every finding should also carry a field distinguishing "LLM-asserted" from "deterministic-tool-asserted" so consumers of the artifact can tell evidence quality apart at a glance — this is what keeps the "evidence scrutiny occurred, not evidence of correctness" caveat honest in the data itself, not just in prose.

## Context that may be useful

This tool draws on prior adversarial evaluation work I did against a public-sector chatbot (NYC's MyCity), so the "skeptical reviewer trying to break things" framing is a deliberate, tested approach, not a novelty. The first real-world test repo will likely be MysteryMixClub (FastAPI backend, React/TypeScript frontend, deployed on DigitalOcean) — good coverage of both a Python backend and a JS/TS frontend with Lighthouse being relevant there specifically.

---

**First task for pi.dev:** using TypeScript/Node as the fixed implementation language and `@flaught/core` as the package name, propose the distribution mechanism (with tradeoffs), propose the `.advreview.yml` schema, and propose the findings JSON schema — before writing implementation code. Confirm all three with me before proceeding to stage 1 of the build sequence above.
