// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for the monorepo.
 *
 * Package-boundary direction (plan §75) is enforced by dependency-cruiser
 * (`pnpm boundaries`), not here — dependency-cruiser understands workspace
 * package graphs, ESLint does not.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.open-next/**',
      '**/.wrangler/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/worker-configuration.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',

      // Plan §7.2 / §85 Rule 4: credentials must never reach logs.
      'no-restricted-properties': [
        'error',
        {
          object: 'console',
          property: 'log',
          message:
            'Use the structured logger from @gs/observability so redaction and trace context are applied.',
        },
      ],
    },
  },
  {
    // Test files and local scripts may log freely.
    files: ['**/*.test.ts', '**/*.spec.ts', '**/scripts/**/*.ts', '**/test/**/*.ts'],
    rules: {
      'no-restricted-properties': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
