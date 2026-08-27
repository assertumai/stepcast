import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // Отбрасывание ключей через деструктуризацию с остатком — законный
          // приём: так из документа убирается обвязка перед подстановкой.
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Ядро не знает про поверхности: движок общается наружу событиями и файлами,
    // а CLI и будущий UI — его потребители. Правило удерживает эту границу.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/cli/**', '../cli/*', '../../cli/*'],
              message: 'src/core не должен зависеть от src/cli — граница ядра и поверхности.',
            },
          ],
        },
      ],
    },
  },
  {
    // Витрина исполняется в браузере, не в Node: своё окружение и JSX. Правило
    // границы ядра выше на `ui` не распространяется — оно ограничено файлами
    // `src/core/**/*.ts` и витрины не касается.
    files: ['ui/**/*.ts', 'ui/**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        EventSource: 'readonly',
        MessageEvent: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        localStorage: 'readonly',
        HTMLElement: 'readonly',
      },
    },
  },
);
