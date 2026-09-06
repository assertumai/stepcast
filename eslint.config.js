import tseslint from 'typescript-eslint';

// Опции одноимённого правила блоки плоского конфига не сливают: последний
// совпавший блок заменяет их целиком. Поэтому запреты не раскладываются по
// блокам «по одному на тему», а собираются здесь и перечисляются вместе всюду,
// где на файл действует больше одного.

/** Ядро не знает про поверхности: движок общается наружу событиями и файлами, а CLI и будущий UI — его потребители. */
const coreBoundaryPatterns = [
  {
    group: ['**/cli/**', '../cli/*', '../../cli/*'],
    message: 'src/core не должен зависеть от src/cli — граница ядра и поверхности.',
  },
];

/**
 * Плагины пакета (`src/backends/**`) — не половина ядра: близость ограничена
 * механически, тем же приёмом, что и граница ядра/поверхности выше
 * (design.md первого настоящего плагина, решение 2). Импорт из ядра —
 * относительной формой любой глубины, `**` ловит и её.
 */
const backendsBoundaryPatterns = [
  {
    group: ['**/core/**'],
    message:
      'src/backends не должен импортировать src/core — плагин обязан идти через ../../plugin.js (design.md, решение 2).',
  },
];

/** Прямое создание временного каталога заводит утечку у пользователя, а не только под тестом. */
const enginePaths = [
  {
    name: 'node:fs',
    importNames: ['mkdtempSync'],
    message: 'Временный каталог заводится через withTempDir() из src/core/fs/tempDir.ts, а не напрямую.',
  },
  {
    name: 'node:os',
    importNames: ['tmpdir'],
    message: 'Системный временный каталог — дело src/core/fs/tempDir.ts; вызывающему он не нужен напрямую.',
  },
];

/** Прямой временный каталог мимо песочницы не убирается никем: устройство описано в test/tmp.ts. */
const testPaths = [
  {
    name: 'node:fs',
    importNames: ['mkdtempSync'],
    message: 'Временный каталог заводится через tempDir() из test/tmp.ts, а не напрямую.',
  },
  {
    name: 'node:os',
    importNames: ['tmpdir'],
    message: 'Системный временный каталог — дело test/tmp.ts; тесту он не нужен напрямую.',
  },
];

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
    // Поверхности движка: временный каталог заводится общим помощником.
    files: ['src/**/*.ts'],
    ignores: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: enginePaths }],
    },
  },
  {
    // Ядро: та же граница временного каталога плюс граница ядра и поверхности.
    // Оба запрета перечислены одной записью правила — раздельными блоками
    // второй молча заменил бы первый.
    files: ['src/core/**/*.ts'],
    ignores: ['src/core/fs/tempDir.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: enginePaths, patterns: coreBoundaryPatterns }],
    },
  },
  {
    // Сам помощник заводит каталог напрямую — это его работа; граница ядра
    // на него распространяется наравне с остальным ядром.
    files: ['src/core/fs/tempDir.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: coreBoundaryPatterns }],
    },
  },
  {
    // Прямой временный каталог мимо песочницы не убирается никем: устройство
    // описано в test/tmp.ts, обход запрещён здесь, а не соглашением.
    files: ['test/**/*.ts'],
    ignores: ['test/tmp.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: testPaths }],
    },
  },
  {
    // Плагины в том же пакете: граница ядра плюс запрет временного каталога
    // напрямую. Оба перечислены одной записью правила по той же причине, что
    // и у блока ядра выше — раздельные блоки на одном наборе файлов не
    // сливаются, второй молча заменил бы первый.
    files: ['src/backends/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: enginePaths, patterns: backendsBoundaryPatterns }],
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
