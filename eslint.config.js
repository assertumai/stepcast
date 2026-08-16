import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
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
);
