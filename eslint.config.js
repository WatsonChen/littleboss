import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Boundary rule: apps never import each other; shared stays a leaf.
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/api/**', '**/api/src/**', '@littleboss/api', '@littleboss/api/*'],
              message:
                'apps/web must not import apps/api. Put shared contracts in packages/shared.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/web/**', '**/web/src/**', '@littleboss/web', '@littleboss/web/*'],
              message:
                'apps/api must not import apps/web. Put shared contracts in packages/shared.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@littleboss/web',
                '@littleboss/api',
                '**/apps/**',
                '**/api/src/**',
                '**/web/src/**',
              ],
              message: 'packages/shared must not depend on apps.',
            },
          ],
        },
      ],
    },
  },
);
