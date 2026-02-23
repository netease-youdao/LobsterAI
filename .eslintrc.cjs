module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  plugins: [
    '@typescript-eslint',
    'react-refresh',
  ],
  ignorePatterns: [
    'dist/',
    'dist-electron/',
    'node_modules/',
    'release/',
    'build/',
    'SKILLs/**',
    'sandbox/**',
  ],
  rules: {
    'react-refresh/only-export-components': 'off',
    'react-hooks/exhaustive-deps': 'off',
    'no-control-regex': 'off',
    'no-useless-escape': 'off',
    'no-constant-condition': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-require-imports': 'off',
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/no-unused-vars': 'off',
  },
};
