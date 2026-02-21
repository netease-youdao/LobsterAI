module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs', 'SKILLs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh', '@typescript-eslint'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    // Allow control characters in regex for Unicode processing (e.g., \u0000-\u001f for matching control chars)
    'no-control-regex': 'off',
    // Allow constant conditions for feature flags and debug code
    'no-constant-condition': ['error', { checkLoops: false }],
    // Allow unnecessary escapes in some cases (backward compatibility)
    'no-useless-escape': 'warn',
    // Allow require for dynamic imports in main process
    '@typescript-eslint/no-var-requires': 'warn',
    // Allow ts-ignore in some cases (migration from older TypeScript)
    '@typescript-eslint/ban-ts-comment': 'warn',
  },
  overrides: [
    {
      // Type definitions can use any for compatibility
      files: ['**/*.d.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
    {
      // IM gateway files deal with external API responses
      files: ['src/main/im/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
    {
      // Logger utilities need flexible typing
      files: ['src/main/logger.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
    {
      // react-markdown components receive node/className from the library
      files: ['src/renderer/components/MarkdownContent.tsx'],
      rules: {
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
}
