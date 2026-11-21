import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'web/dist/**',
      'server/dist/**',
      'data/**',
      'server/data/**',
      'deploy/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // TS 自带未定义/未使用检查；ESLint 的 base 规则会把类型引用误报。
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      // React Hooks 的两条核心规则：规则违反是错误，依赖提示暂记 warning，避免历史代码一次锁死 CI。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // 历史代码有少量空 catch / 常量条件，先保留 warning。
      'no-empty': 'warn',
      'no-constant-condition': 'warn',
    },
  },
);
