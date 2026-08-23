# Security Policy

Flaught runs deterministic tools (Semgrep, a linter, a vuln scanner) and an LLM adversarial pass over diffs. It is a prompt for human review, not audit-truth — see the honest caveat in the [README](README.md#honest-caveat). This policy covers the project itself, not the code it reviews.

## Reporting a vulnerability

If you believe you have found a security issue in Flaught — for example, command injection through config, unsafe handling of untrusted LLM output, or a path-traversal or YAML-deserialization problem — **do not open a public issue.**

Report it privately to **SECURITY_CONTACT_EMAIL** with:

- a description of the issue and its impact,
- the minimal config or input that reproduces it,
- the version you tested (`flaught --version` or the git SHA).

We will acknowledge within a few days and coordinate a fix and disclosure timeline with you. Please do not publish details before a fix is available.

## Scope

In scope: the Flaught CLI, its config parsing, its tool invocations, its LLM/refute handling, and the GitHub Actions workflow. Out of scope: findings Flaught produces *about* some other project's code, and security issues in dependencies (report those upstream; consider a `flaught dismiss` if a vuln scanner flags a dependency you've assessed).

## Supported versions

Only the latest tagged release and `main` receive security fixes.