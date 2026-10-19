// SPDX-License-Identifier: Apache-2.0

// TypeScript/TSX is checked by `pnpm typecheck`; ESLint covers JS tooling.
// Keep generated output and preserved upstream materials out of lint traversal.
export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "third_party/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        Buffer: "readonly",
        URL: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      "constructor-super": "error",
      "for-direction": "error",
      "getter-return": "error",
      "no-async-promise-executor": "error",
      "no-const-assign": "error",
      "no-dupe-args": "error",
      "no-dupe-class-members": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-ex-assign": "error",
      "no-func-assign": "error",
      "no-import-assign": "error",
      "no-self-assign": "error",
      "no-setter-return": "error",
      "no-this-before-super": "error",
      "no-undef": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      "no-unsafe-negation": "error",
      "no-unused-vars": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
  },
];
