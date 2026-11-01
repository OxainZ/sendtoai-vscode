import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  { ignores: ['out/**', 'node_modules/**', 'research_notes/**', 'reports/**', '*.vsix'] },

  // Extension host (TypeScript)
  ...tseslint.configs.recommended.map(c => ({ ...c, files: ['src/**/*.ts'] })),
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',           // lsPost returns untyped JSON on purpose
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': 'error',                                  // nothing may log license keys
      'eqeqeq': ['error', 'smart'],
    },
  },

  // Webview script (browser, no modules)
  {
    files: ['media/panel.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, acquireVsCodeApi: 'readonly' },
    },
    rules: { ...js.configs.recommended.rules, 'no-console': 'error', 'eqeqeq': ['error', 'smart'] },
  },

  // Cloudflare Worker (ES module, Workers runtime)
  {
    files: ['worker/src/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.serviceworker, ...globals.browser } },
    rules: { ...js.configs.recommended.rules, 'eqeqeq': ['error', 'smart'] },
  },

  // Tests (Node)
  {
    files: ['test/**/*.cjs', 'worker/test/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { ...js.configs.recommended.rules },
  },
  {
    files: ['worker/test/**/*.js'],
    languageOptions: { sourceType: 'module' },
  },
];
