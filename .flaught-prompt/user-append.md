## Project context: @flaught/core

You are reviewing Flaught's own codebase — the adversarial PR review tool. This is a TypeScript/Node.js library published as `@flaught/core` on npm.

Key architectural decisions:
- Five-stage pipeline: Config → Context assembly → Deterministic tools → LLM adversarial pass → Test inversion + Scope-creep
- Every finding is tagged `source_type: "deterministic"` or `"source_type": "llm"` so consumers can tell tool-asserted evidence from model-asserted
- The `_caveat` field on every artifact is mandatory and never stripped
- Dismissals are fingerprint-matched across runs (not just ID-matched) so renames don't create zombie findings

Review focus areas:
- Schema changes: the findings JSON schema (`src/schemas/findings.ts`) is versioned and governance-critical — any change to field names, types, or structure needs a schema_version bump
- The LLM provider adapter (`src/llm/provider.ts`) handles multiple providers (OpenAI, Groq, Gemini, Anthropic, Ollama). Watch for provider-specific assumptions leaking into shared code.
- The deterministic tool runner (`src/tools/runner.ts`) must degrade gracefully — tools that aren't installed skip, not fail
- Test coverage: new features should have tests in the corresponding `*.test.ts` file
- Security: this tool runs in CI and handles API keys — never log secrets, never embed keys in artifacts