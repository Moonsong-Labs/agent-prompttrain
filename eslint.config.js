// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Ignore patterns
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'scripts/**', 'docker/**'],
  },

  // Base ESLint recommended rules
  eslint.configs.recommended,

  // TypeScript-ESLint recommended rules
  ...tseslint.configs.recommended,

  // Custom configuration
  {
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        global: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },

    rules: {
      // TypeScript specific rules
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // General rules
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
    },
  },

  // Override for main.ts files - allow console.log for startup messages
  {
    files: ['**/main.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // Override for logger implementations - they need console
  {
    files: ['**/logger.ts', '**/logger/*.ts'],
    rules: {
      'no-console': 'off',
    },
  }
)
