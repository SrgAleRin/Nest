import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Directories with a `.git` *file* are linked worktrees: the untracked
 * `flatworm/` checkout and every Orca child workspace. They hold another
 * checkout of this repo, so linting them reports foreign code as ours.
 */
function nestedWorktreeIgnores(root = process.cwd()) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .filter((entry) => {
      try {
        return statSync(path.join(root, entry.name, '.git')).isFile();
      } catch {
        return false;
      }
    })
    .map((entry) => `${entry.name}/**`);
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      ...nestedWorktreeIgnores(),
      '**/out/**',
      '**/dist/**',
      '**/release/**',
      // electron-builder output written to a suffixed directory (`--config.directories.output`).
      '**/release-*/**',
      '**/coverage/**',
      // Scratch repositories the e2e suite leaves next to the app in a dev checkout.
      '**/.e2e-tmp/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/*.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
