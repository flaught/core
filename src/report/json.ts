/**
 * JSON artifact renderer — produces the versioned, self-describing findings artifact.
 *
 * This is the backbone of the governance positioning. The artifact is:
 * - Versioned from day one
 * - Self-describing (repo, PR, commit, timestamps)
 * - Honest about evidence quality (LLM vs deterministic)
 * - Structured in its dismissal fields
 */

import type { FindingsArtifact } from "../schemas/findings.js";

export function renderJsonArtifact(artifact: FindingsArtifact): string {
  return JSON.stringify(artifact, null, 2);
}