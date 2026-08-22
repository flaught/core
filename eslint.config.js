// @ts-check
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  {
    // Scoped to src/**/*.ts to match `npm run lint` (eslint src/) and to
    // avoid linting root-level CommonJS config files (this file included)
    // as TypeScript — Flaught's own deterministic eslint tool runs
    // `eslint .` against the whole repo, not just src/, once this config
    // exists at all.
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommended],
    rules: {
      // tsc (strict + noUnusedLocals/noUnusedParameters) already enforces
      // this at compile time — avoid duplicate/looser reporting from eslint.
      "@typescript-eslint/no-unused-vars": "off",
      // The provider abstraction and JSON parsing paths lean on `any` at
      // integration boundaries (LLM responses, dynamic config) by design.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
