import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'examples/**/node_modules/**',
      '.sluice/**',
      'docs/site/.vitepress/cache/**',
      'docs/site/.vitepress/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // ARCHITECTURE RULE (ADR-0001): core never imports plugins or surfaces.
    files: ['core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@sluice-dev/plugin-*', '!@sluice-dev/plugin-api'],
              message: 'core must not import plugins (ADR-0001).',
            },
            {
              group: ['@sluice-dev/cli', '@sluice-dev/mcp', '@sluice-dev/github', '@sluice-dev/web'],
              message: 'core must not import surfaces (ADR-0001).',
            },
            {
              group: ['**/plugins/**', '**/surfaces/**'],
              message: 'core must not import plugins/surfaces (ADR-0001).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
