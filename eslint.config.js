// @ts-check
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
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
