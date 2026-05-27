// ESLint 9 flat config — migrated from .eslintrc.json (eslint 8.57 + ts-eslint 7)
// per FU-ESLINT-9-MIGRATION (nexus handoff 2026-05-27 §2 H3).
//
// Equivalent rules to the prior .eslintrc.json — no behavioural intent change,
// only the config format and package versions changed:
//   - `eslint:recommended`              → `js.configs.recommended`
//   - `plugin:@typescript-eslint/recommended` → `tseslint.configs.recommended`
//   - `parserOptions.ecmaVersion: 2022` + `sourceType: module` preserved
//   - `env.node + env.es2022`           → `globals.node` (es2022 globals are
//     implicit from ecmaVersion in flat config)
//   - 2 custom rules carry through verbatim
//   - `ignorePatterns` → top-level `{ ignores }` block (flat-config syntax)

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
