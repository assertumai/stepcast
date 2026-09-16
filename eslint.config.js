import tseslint from 'typescript-eslint';

// Опции одноимённого правила блоки плоского конфига не сливают: последний
// совпавший блок заменяет их целиком. Поэтому запреты не раскладываются по
// блокам «по одному на тему», а собираются здесь и перечисляются вместе всюду,
// где на файл действует больше одного.

// Единая граница ядра (`source-tree-microkernel-layout`, design.md,
// Решение 2): `src/kernel/**` не импортирует `src/parts/**`, `src/plugin/**`
// и `src/bin.ts` — значением, типом и реэкспортом. Перечни доменных деревьев
// по именам сегментов (`pipeline/`, `backend/`, `run/`, `expect/`,
// `journal/`, `config/`) и оба поимённых исключения (`config/resolve.js`,
// `config/schema.js`), нужные, пока домен жил рядом с ядром в `src/core/`, —
// сняты вместе с самим `src/core/`: домен целиком под `src/parts/`, и одна
// запись накрывает его без перечня имён. Запрет на `src/plugin/**` — не
// педантизм: публичная поверхность собирает то, что вправе видеть автор
// плагина, и импорт её ядром завёл бы цикл смысла («ядро зависит от витрины
// своих же объявлений»).
const KERNEL_BOUNDARY_MESSAGE =
  'Ядро (src/kernel/**) не импортирует src/parts/**, src/plugin/** и src/bin.ts (design.md, Решение 2).';

const kernelBoundaryPatterns = [
  {
    group: ['**/parts/**', '**/plugin/**', '../bin.js', '../../bin.js'],
    message: KERNEL_BOUNDARY_MESSAGE,
  },
];

// `load.ts` и `registry.ts` — единственное оставшееся исключение
// (`source-tree-microkernel-layout`, design.md Решение 4, шестое отступление,
// найдено самим переездом, а не запланировано заранее). Оба читают контракт
// декларативного плагина (`StepcastPluginSchema`, типы вклада и различители
// `isNative*`) — зависимость доменная и была ей до переезда тоже, но модуль
// назывался `pipeline-contract.ts` (совпадение подстроки, не сегмента пути),
// и прежний перечень имён его не ловил; переезд в `parts/pipeline/contract.ts`
// завёл настоящий сегмент `parts`, и то же самое имя стало нарушением.
// Исключение поимённое и на два файла, а не на дерево — снять его значило бы
// переписать `load.ts`/`registry.ts` на структурный вход, как это уже сделано
// для `ResolvedConfig` (design.md, Решение 5), а такая правка — не
// переименование.
//
// Свой набор шаблонов, а не производный вид `kernelBoundaryPatterns` с
// довешенным отрицанием: `**/parts/**` ловит специфик независимо от
// отрицания на соседнем шаблоне той же группы (проверено `Linter` напрямую),
// а отрицание глубже одного сегмента под баном не достаёт
// (`eslint-restricted-imports-negation-ancestor-limit`). Первая группа
// перечисляет четыре файла на корне `parts/` литералом вместо `**/parts/**`
// (единственный источник домена на этой глубине, которого не ловят прочие
// деревья) и повторяет запрет на `plugin/`/`bin.ts`; вторая разрешает ровно
// `parts/pipeline/contract.js` — прямого потомка уже суженного бана, что и
// работает; третья закрывает прочие поддеревья `parts/` по имени сегмента.
const kernelContractCarryoverPatterns = [
  {
    group: [
      '../parts/builtin.js',
      '../parts/load.js',
      '../parts/resolve.js',
      '../parts/rows.js',
      '**/plugin/**',
      '../bin.js',
      '../../bin.js',
    ],
    message: KERNEL_BOUNDARY_MESSAGE,
  },
  {
    group: ['../parts/pipeline/**', '!../parts/pipeline/contract.js'],
    message: KERNEL_BOUNDARY_MESSAGE,
  },
  {
    group: ['**/backends/**', '**/ui/**', '**/cli/**'],
    message: KERNEL_BOUNDARY_MESSAGE,
  },
];

// Плагины пакета (`src/parts/backends/codex/**`, `src/parts/pipeline/steps/decision/**`) —
// не половина ядра: близость ограничена механически, тем же приёмом, что и
// граница ядра/поверхности выше (design.md первого настоящего плагина,
// решение 2; design.md `user-decision-steps`, решение 12).
//
// Запрет назван подъёмом из каталога плагина, а не именем дерева движка
// (`**/core/**` до переезда `source-tree-microkernel-layout`): после переезда
// оба плагина лежат ВНУТРИ `src/parts/`, и внутренний модуль они называют
// относительным спецификом без единого узнаваемого сегмента
// (`../../run/journal/schema.js` из `steps/decision/`). Правило, названное
// деревом, стало бы вакуумным — сообщение есть, срабатывать не на чем.
// Поэтому: запрещён любой подъём выше собственного каталога, кроме двух
// публичных подпутей, которые и есть разрешённый вход вклада.
//
// Механика шаблонов проверена `Linter` напрямую, а не выведена по аналогии:
// - `[a-z]*` вместо `*` обязателен. Голая `*` совпадает и с сегментом `..`,
//   а совпавший сегмент-каталог исключает всё под собой каскадом — `../*`
//   тихо накрыл бы и `../../surface.js`, и отрицание его уже не вернуло бы
//   (`eslint-restricted-imports-negation-ancestor-limit`).
// - отрицание достаёт только прямого потомка запрещённого шаблона вида
//   `X/**` (сам каталог `X` таким шаблоном не запрещён) — обе поверхности
//   названы ровно так.
// - разная глубина двух плагинов даёт по паре шаблонов на ступень подъёма:
//   `../../surface.js` — вход `steps/decision/`, `../../pipeline/surface.js` —
//   вход `backends/codex/`; лишний для одного из них шаблон другому не мешает,
//   потому что несуществующий адрес никто не импортирует.
const backendsBoundaryPatterns = [
  {
    group: [
      '../[a-z]*',
      '../[a-z]*/**',
      '../../[a-z]*.js',
      '!../../surface.js',
      '../../[a-z]*/**',
      '!../../pipeline/surface.js',
      '../../../[a-z]*.js',
      '../../../[a-z]*/**',
      '!../../../plugin/index.js',
      '../../../../[a-z]*.js',
      '../../../../[a-z]*/**',
      '!../../../../plugin/index.js',
    ],
    message:
      'src/parts/backends/codex и src/parts/pipeline/steps/decision не должны импортировать внутренние модули движка — вклад обязан идти через публичные подпути stepcast/plugin (src/plugin/index.ts) и stepcast/pipeline (src/parts/pipeline/surface.ts) (design.md, решение 2).',
  },
  // Подъём выше `src/` — отдельной записью, а не в группе выше: там каждый
  // шаблон соседствует с отрицанием, а здесь отрицать нечего — разрешённый
  // вход вклада глубже четырёх ступеней не поднимается ни у одного из двух
  // плагинов.
  {
    group: ['../../../../../**'],
    message:
      'src/parts/backends/codex и src/parts/pipeline/steps/decision не должны импортировать ничего выше src/ — вклад обязан идти через публичные подпути stepcast/plugin (src/plugin/index.ts) и stepcast/pipeline (src/parts/pipeline/surface.ts) (design.md, решение 2).',
  },
];

/** Прямое создание временного каталога заводит утечку у пользователя, а не только под тестом. */
const enginePaths = [
  {
    name: 'node:fs',
    importNames: ['mkdtempSync'],
    message: 'Временный каталог заводится через withTempDir() из src/kernel/fs/tempDir.ts, а не напрямую.',
  },
  {
    name: 'node:os',
    importNames: ['tmpdir'],
    message: 'Системный временный каталог — дело src/kernel/fs/tempDir.ts; вызывающему он не нужен напрямую.',
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
    // Весь движок: временный каталог заводится общим помощником
    // (`src/kernel/fs/tempDir.ts`). Более узкие блоки ниже (сам помощник,
    // ядро) совпадают последними и заменяют этот набор целиком для своих
    // файлов.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: enginePaths }],
    },
  },
  {
    // Ядро: граница ядра (см. `kernelBoundaryPatterns` выше) плюс запрет
    // временного каталога напрямую. Оба перечислены одной записью правила —
    // раздельные блоки на одном наборе файлов не сливаются, второй молча
    // заменил бы первый. `load.ts`/`registry.ts` и сам помощник каталога
    // исключены — у них собственные блоки ниже.
    files: ['src/kernel/**/*.ts'],
    ignores: ['src/kernel/fs/tempDir.ts', 'src/kernel/load.ts', 'src/kernel/registry.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: enginePaths, patterns: kernelBoundaryPatterns }],
    },
  },
  {
    // Помощник ядра заводит временный каталог напрямую — это его работа;
    // граница ядра при этом распространяется на него наравне с остальным
    // ядром.
    files: ['src/kernel/fs/tempDir.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: kernelBoundaryPatterns }],
    },
  },
  {
    // Единственное оставшееся исключение границы ядра (см.
    // `kernelContractCarryoverPatterns` выше): эти два модуля, и только они,
    // вправе назвать `parts/pipeline/contract.js`.
    files: ['src/kernel/load.ts', 'src/kernel/registry.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: enginePaths, patterns: kernelContractCarryoverPatterns }],
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
    // Плагины в том же пакете: граница плагина поставки плюс запрет
    // временного каталога напрямую. Оба перечислены одной записью правила по
    // той же причине, что и у блока ядра выше — раздельные блоки на одном
    // наборе файлов не сливаются, второй молча заменил бы первый.
    //
    // `src/parts/pipeline/steps/decision/**` — реализация встроенного
    // плагинного вида `decision`, лежащая рядом с родственными видами шага
    // (`builtin-step-kinds-as-rows`, design.md, Решение 8; переехала вместе с
    // остальным `parts/steps/**` на ступени 2 `source-tree-microkernel-layout`);
    // она написана тем же контрактом, что видит сторонний автор плагина, и
    // без этого блока (файлы попали бы под общий `src/**` выше, где запрета
    // на внутренние модули движка нет) граница молча исчезла бы. `row.ts` той же
    // строки — исключение: он не реализация вклада, ему нужен тип
    // `BuiltinRow` из `src/kernel/load.js`, а братьям (`run/`, `uses/`,
    // `script/`, `agent/row.ts`) под `src/parts/pipeline/steps/**` этот запрет
    // не грозит вовсе — они лишь называют внутреннюю форму разбора из
    // `parts/pipeline/document/expand.js` и под этот блок не подпадают.
    //
    // Перечень каталогов, а не дерево `src/parts/backends/**` целиком
    // (`source-tree-microkernel-layout`, Решение 8): адаптер `claude` тоже
    // переехал под `src/parts/backends/`, но написан внутренними импортами и
    // публичной поверхностью никогда не пользовался — правило, названное
    // деревом, потребовало бы либо переписать его на `stepcast/plugin`
    // (правка поведения в изменении-переименовании), либо дать ему именное
    // исключение, то есть то же самое, чего это решение избегает для ядра.
    // Переписывание `claude` на публичный подпуть — открытый вопрос плана.
    files: ['src/parts/backends/codex/**/*.ts', 'src/parts/pipeline/steps/decision/**/*.ts'],
    ignores: ['src/parts/pipeline/steps/decision/row.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: enginePaths, patterns: backendsBoundaryPatterns },
      ],
    },
  },
  {
    // Витрина исполняется в браузере, не в Node: своё окружение и JSX.
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
