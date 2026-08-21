import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several integration tests create real git worktrees and run `npm install`/
    // test commands inside them (review.test.ts, test-inversion/runner.test.ts).
    // Those routinely take 4-10s depending on system load, well past vitest's
    // 5000ms default — which was intermittently failing `npm test` (and thus
    // `prepublishOnly`) under load with no actual regression.
    testTimeout: 20_000,
  },
});
