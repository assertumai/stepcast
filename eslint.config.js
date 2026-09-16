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
 * Плагины пакета (`src/backends/**`, `src/parts/steps/decision/**`) — не
 * половина ядра: близость ограничена механически, тем же приёмом, что и
 * граница ядра/поверхности выше (design.md первого настоящего плагина,
 * решение 2; design.md `user-decision-steps`, решение 12). Импорт из ядра —
 * относительной формой любой глубины, `**` ловит и её.
 */
const backendsBoundaryPatterns = [
  {
    group: ['**/core/**'],
    message:
      'src/backends и src/parts/steps/decision не должны импортировать src/core — вклад обязан идти через ../../plugin.js (design.md, решение 2).',
  },
];

/**
 * Ядро плагинов не знает домена (`kernel-domain-free-imports`, design.md,
 * Решение 4): разбор пайплайна, бэкенды, исполнение прогона, плагины пакета,
 * встроенный слой поставки и витрина — не его дело. `parts/**` добавлено,
 * чтобы Решение 3 того же изменения нельзя было откатить обратным импортом
 * таблицы встроенных строк; `backends/**` и `ui/**` — по тому же основанию,
 * что и `steps/**`.
 */
// Модули ядра плагинов лежат прямо в `src/core/plugins/`, без вложенных
// каталогов: относительный импорт соседа по `core/` (`pipeline`, `backend`,
// `run`) поднимается на один уровень и в тексте специфика не несёт сегмента
// `core` вовсе (`../pipeline/expand.js`, а не `.../core/pipeline/...`).
// Поэтому группа называет сегменты дерева без префикса `core/` — этот блок
// конфига всё равно ограничен файлами `src/core/plugins/**`, и раньше
// никакого стороннего `pipeline`/`backend`/`run` в их относительных путях не
// возникает.
const KERNEL_DOMAIN_MESSAGE =
  'Ядро плагинов не зависит от домена: перечень и вклад приходят параметром сборки или регистрацией, а не импортом (docs/microkernel-target.md, шаг 2).';

/**
 * Доменные деревья, которые ядру плагинов закрыты целиком. Перечислены
 * отдельными группами, а не одной, затем же, зачем у `backend/**` ниже:
 * отрицающий шаблон действует на всю группу, в которую внесён, и одна общая
 * группа превратила бы любое исключение в дыру для всех прочих деревьев.
 *
 * `expect/**` и `journal/**` добавлены вместе со снятием исключения с
 * `contract.ts` (`plugin-surface-split`, шаг 8): без них запрет на
 * `backend/types.js` держал бы одну дверь из четырёх — доменные типы вклада
 * (`EvaluationInput`, `PredicateResult`, `Usage`) вернулись бы в ядерный
 * контракт соседним импортом, и заметить это было бы негде.
 */
const kernelBoundaryPatterns = [
  {
    group: ['**/pipeline/**', '**/run/**', '**/steps/**', '**/backends/**', '**/parts/**', '**/ui/**'],
    message: KERNEL_DOMAIN_MESSAGE,
  },
  {
    group: ['**/backend/**'],
    message: KERNEL_DOMAIN_MESSAGE,
  },
  {
    group: ['**/expect/**'],
    message: KERNEL_DOMAIN_MESSAGE,
  },
  {
    group: ['**/journal/**'],
    message: KERNEL_DOMAIN_MESSAGE,
  },
  {
    // Конфигурация движка доменна по тому же критерию, но два её модуля ядро
    // плагинов читает по своему делу и сегодня: `config/resolve.js` —
    // `ResolvedConfig` в загрузчике (`load.ts`), `config/schema.js` —
    // `PluginPatchRow` в дереве строк (`tree.ts`). Названы поимённо, чтобы
    // остальное дерево конфигурации оставалось закрытым; их собственный
    // переезд — остаток шага 10 плана (docs/microkernel-target.md).
    group: ['**/config/**', '!**/config/resolve.js', '!**/config/schema.js'],
    message: KERNEL_DOMAIN_MESSAGE,
  },
];

/**
 * Те же доменные деревья для `pipeline-contract.ts` ниже, но с поимённым
 * перечнем модулей, которые доменная половина контракта действительно несёт:
 * `backend/types.js` (типы адаптера), `config/resolve.js` и `config/schema.js`
 * (запись бэкенда в конфигурации), `expect/evaluate.js` (вход предиката),
 * `journal/schema.js` (итог предиката и расход). Ровно этот набор — и ничего
 * сверх: соседний `backend/claude.js` или `journal/write.js` отклоняется здесь
 * так же, как в любом другом модуле ядра.
 *
 * Исключения выражены отрицающим шаблоном внутри одной группы, а не отдельным
 * блоком конфига: отрицание установленная версия правила понимает — это и
 * проверяет `test/eslint-config.test.ts` («backend/types.js разрешён,
 * соседний backend/claude.js — нет»), — и по design.md, Решение 4, «если
 * отрицание работает, блоки допустимо слить». Дерево, из которого разрешён
 * хоть один модуль, вынесено в эту группу целиком: отрицание действует на всю
 * группу, куда внесено, и оставлять рядом с ним дерево без исключений значило
 * бы молча открыть и его.
 */
const domainContractPatterns = [
  {
    group: ['**/pipeline/**', '**/run/**', '**/steps/**', '**/backends/**', '**/parts/**', '**/ui/**'],
    message: KERNEL_DOMAIN_MESSAGE,
  },
  {
    group: [
      '**/backend/**',
      '**/config/**',
      '**/expect/**',
      '**/journal/**',
      '!**/backend/types.js',
      '!**/config/resolve.js',
      '!**/config/schema.js',
      '!**/expect/evaluate.js',
      '!**/journal/schema.js',
    ],
    message:
      'Доменному контракту вклада разрешён ровно тот набор доменных модулей, который он несёт: backend/types.js, config/resolve.js, config/schema.js, expect/evaluate.js, journal/schema.js — и только типом (docs/microkernel-target.md, шаг 2; переезд модуля — шаг 10).',
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

/** Глобали браузера — окружение витрины (`ui/**`), но не её тестов: те идут в Node. */
const browserGlobals = {
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
};

/** Те же имена со значением `off`: слияние `globals` гасится только явным отказом, а не умолчанием. */
function disabled(globals) {
  return Object.fromEntries(Object.keys(globals).map((name) => [name, 'off']));
}

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
    // Состав дефолта и строки поставки (`src/parts/**`) — половина движка, а
    // не поверхность: граница ядра и поверхности на них та же, что на
    // `src/core/**`. Блок заведён явно, потому что переезд
    // `builtin.ts`/`resolve.ts` из `src/core/plugins/` в `src/parts/`
    // (`kernel-domain-free-imports`, Решение 2) вывел их из-под блока ядра
    // ниже и оставил бы им только `paths: enginePaths` из блока поверхностей
    // выше — то есть молча вернул бы запрет импорта `src/cli` в разряд
    // соглашений. Оба запрета перечислены одной записью правила по той же
    // причине, что и у блоков ядра: раздельные блоки на одном наборе файлов
    // не сливаются.
    files: ['src/parts/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: enginePaths, patterns: coreBoundaryPatterns }],
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
    // Ядро плагинов — те же запреты, что у ядра выше, плюс граница домена
    // (`kernel-domain-free-imports`): узкий блок на тех же файлах молча снял
    // бы прежние запреты, если не повторить их здесь одной записью правила.
    // `contract.ts` больше не исключён (`plugin-surface-split`, шаг 8):
    // доменная половина контракта выехала в соседний `pipeline-contract.ts`
    // (свой блок ниже), и `contract.ts` — ядерный модуль без единого
    // доменного импорта, как и прочие модули этого каталога.
    files: ['src/core/plugins/**/*.ts'],
    ignores: ['src/core/plugins/pipeline-contract.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: enginePaths, patterns: [...coreBoundaryPatterns, ...kernelBoundaryPatterns] }],
    },
  },
  {
    // Доменная половина контракта (`stepcast/pipeline`) — соседний модуль
    // ядра, временно (`plugin-surface-split`, design.md, Решение 3): вклад
    // бэкенда, предиката, вида шага и их родня знают о пайплайне по
    // определению, а таблица декларативной формы читает `registry.ts`/`load.ts`
    // — ядру импортировать `src/parts/**` запрещено линтом, и соседний модуль
    // того же каталога под этот запрет не подпадает. Разрешён поимённый набор
    // доменных модулей — ровно тот, что этот контракт несёт
    // (`domainContractPatterns` выше); переезд самого модуля в
    // `src/parts/pipeline/` — шаг 10 плана (docs/microkernel-target.md).
    files: ['src/core/plugins/pipeline-contract.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: enginePaths, patterns: [...coreBoundaryPatterns, ...domainContractPatterns] },
      ],
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
    //
    // `src/parts/steps/decision/**` — реализация встроенного плагинного вида
    // `decision`, переехавшая рядом с родственными видами шага
    // (`builtin-step-kinds-as-rows`, design.md, Решение 8); она написана тем
    // же контрактом, что видит сторонний автор плагина, и без этого блока
    // (файлы попали бы под общий `src/parts/**` выше, где запрета на импорт
    // `src/core` нет) граница молча исчезла бы. `row.ts` той же строки —
    // исключение: он не реализация вклада, ему нужен тип `BuiltinRow` из
    // `src/core/plugins/load.js`, а братьям (`run/`, `uses/`, `script/`,
    // `agent/row.ts`) под `src/parts/steps/**` этот запрет не грозит вовсе —
    // они лишь называют внутреннюю форму разбора из `core/pipeline/expand.js`
    // и под этот блок не подпадают.
    //
    // Граница ядра и поверхности (`coreBoundaryPatterns`) перечислена здесь
    // третьей по той же причине: блок на `src/parts/**` выше даёт её всем
    // строкам поставки, а этот блок, совпав на файлах `decision` последним,
    // заменил бы опции целиком и снял бы её с одной только реализации
    // переехавшего вида. `src/backends/**` она тоже касается — плагин пакета
    // тем более не поверхность.
    files: ['src/backends/**/*.ts', 'src/parts/steps/decision/**/*.ts'],
    ignores: ['src/parts/steps/decision/row.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: enginePaths, patterns: [...coreBoundaryPatterns, ...backendsBoundaryPatterns] },
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
      globals: browserGlobals,
    },
  },
  {
    // Тесты витрины исполняются `node --test`, не браузером: окружение Node
    // вместо браузерного.
    //
    // `languageOptions` — не опции правила: их плоский конфиг как раз СЛИВАЕТ
    // (`globals` и `parserOptions` объединяются по ключам, `parser`
    // наследуется), и только поэтому тестам достаётся TS-парсер блока `ui/**`
    // выше, под шаблон которого `ui/test/**` подпадает тоже. Из того же
    // слияния следует, что браузерные глобали сами собой отсюда не уходят:
    // чтобы `window` в тесте, идущем без DOM, не считался объявленным, каждая
    // из них гасится явным `off`.
    files: ['ui/test/**/*.ts', 'ui/test/**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...disabled(browserGlobals),
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        globalThis: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);
