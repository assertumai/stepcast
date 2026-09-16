import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { ESLint } from 'eslint';

/**
 * Запреты `no-restricted-imports` проверяются здесь, а не глазами при ревью:
 * в плоском конфиге блоки не сливают опции одноимённого правила, поэтому
 * новый блок способен молча снять чужой запрет с тех же файлов — дерево при
 * этом остаётся зелёным, и потеря обнаруживается только нарушением, которое
 * правило обязано было поймать.
 *
 * Проверяется поведение линта на подставном содержимом: `lintText` берёт путь
 * лишь для выбора применимых блоков конфига, файла с таким путём на диске
 * может не быть.
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

async function restrictedImports(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === 'no-restricted-imports')
    .map((message) => message.message);
}

const CLI_IMPORT = "import { run } from '../../cli/main.js';\n";
const TEMP_IMPORT = "import { mkdtempSync } from 'node:fs';\n";
const TMPDIR_IMPORT = "import { tmpdir } from 'node:os';\n";
const CORE_IMPORT = "import { createClaudeAdapter } from '../../core/backend/claude.js';\n";

// Импорты для файла ядра плагинов (`src/core/plugins/проба.ts`): пути на
// уровень выше, чем у ядра общего вида (`src/core/run/проба.ts`).
const PLUGIN_KERNEL_BACKEND_IMPORT = "import { createClaudeAdapter } from '../backend/claude.js';\n";
const PLUGIN_KERNEL_PIPELINE_IMPORT = "import { RUN_STEP_KIND } from '../pipeline/expand.js';\n";
const PLUGIN_KERNEL_PIPELINE_TYPE_IMPORT = "import type { ExpandOptions } from '../pipeline/expand.js';\n";
const BACKEND_TYPES_IMPORT = "import type { BackendAdapter } from '../backend/types.js';\n";
// Прочие доменные модули, которые несёт доменная половина контракта: ему они
// разрешены поимённо, ядерным соседям — нет.
const EXPECT_IMPORT = "import type { EvaluationInput } from '../expect/evaluate.js';\n";
const JOURNAL_IMPORT = "import type { PredicateResult } from '../journal/schema.js';\n";
const CONFIG_RESOLVE_IMPORT = "import type { Config } from '../config/resolve.js';\n";
// Сосед по тем же деревьям, которого не несёт никто: разрешение поимённое, не
// на дерево.
const JOURNAL_WRITE_IMPORT = "import { openJournal } from '../journal/writer.js';\n";
const CONFIG_OTHER_IMPORT = "import { defaultsFor } from '../config/defaults.js';\n";

// Состав дефолта (`src/parts/проба.ts`) лежит на уровень ближе к корню
// `src/`, чем ядро: поверхность для него — `../cli/main.js`.
const PARTS_CLI_IMPORT = "import { run } from '../cli/main.js';\n";

describe('eslint: запреты импорта действуют одновременно', () => {
  // test-sandbox, «Код движка мимо помощника».
  it('ядро: прямое создание временного каталога отклоняется', async () => {
    const messages = await restrictedImports('src/core/run/проба.ts', TEMP_IMPORT + TMPDIR_IMPORT);
    assert.equal(messages.length, 2, messages.join('\n'));
    assert.ok(messages.every((message) => message.includes('src/core/fs/tempDir.ts')), messages.join('\n'));
  });

  it('ядро: импорт поверхности отклоняется границей ядра', async () => {
    const messages = await restrictedImports('src/core/run/проба.ts', CLI_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('граница ядра')),
      messages.join('\n'),
    );
  });

  // Тот самый случай, ради которого проверка и написана: на файле ядра
  // действуют оба запрета сразу, и ни один не вытесняет другого.
  it('ядро: оба запрета срабатывают в одном файле', async () => {
    const messages = await restrictedImports('src/core/run/проба.ts', CLI_IMPORT + TEMP_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('граница ядра')),
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('withTempDir()')),
      messages.join('\n'),
    );
  });

  it('поверхность движка: прямое создание временного каталога отклоняется', async () => {
    const messages = await restrictedImports('src/cli/commands/проба.ts', TEMP_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('withTempDir()')),
      messages.join('\n'),
    );
  });

  // Помощник заводит каталог напрямую по своему назначению, но границу ядра
  // исключением из первого запрета не теряет.
  it('помощник движка: временный каталог разрешён, граница ядра остаётся', async () => {
    const messages = await restrictedImports('src/core/fs/tempDir.ts', CLI_IMPORT + TEMP_IMPORT + TMPDIR_IMPORT);
    assert.deepEqual(
      messages.filter((message) => message.includes('tempDir.ts')),
      [],
      'помощнику прямое создание разрешено',
    );
    assert.ok(
      messages.some((message) => message.includes('граница ядра')),
      messages.join('\n'),
    );
  });

  // test-sandbox, «Новый тест завёл каталог напрямую».
  it('тест: прямое создание временного каталога отклоняется', async () => {
    const messages = await restrictedImports('test/проба.test.ts', TEMP_IMPORT + TMPDIR_IMPORT);
    assert.equal(messages.length, 2, messages.join('\n'));
    assert.ok(messages.every((message) => message.includes('test/tmp.ts')), messages.join('\n'));
  });

  // test-sandbox, «Модуль песочницы».
  it('модуль песочницы: прямое создание разрешено', async () => {
    assert.deepEqual(await restrictedImports('test/tmp.ts', TEMP_IMPORT + TMPDIR_IMPORT), []);
  });

  // Плагины пакета: близость к ядру ограничена механически (design.md
  // первого настоящего плагина, решение 2). Тот же случай, что и у ядра
  // выше, — оба запрета обязаны сработать в одном файле, иначе новый блок
  // молча снял бы запрет временного каталога с этих файлов.
  it('плагины пакета: импорт ядра отклоняется границей плагина', async () => {
    const messages = await restrictedImports('src/backends/codex/проба.ts', CORE_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('../../plugin.js')),
      messages.join('\n'),
    );
  });

  it('плагины пакета: оба запрета срабатывают в одном файле', async () => {
    const messages = await restrictedImports('src/backends/codex/проба.ts', CORE_IMPORT + TEMP_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('../../plugin.js')),
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('withTempDir()')),
      messages.join('\n'),
    );
  });

  // Задача 6.4 (builtin-step-kinds-as-rows): реализация `decision` переехала
  // в `src/parts/steps/decision/`, где без отдельного блока конфига файлы
  // попали бы под общий `src/parts/**` — там запрета на импорт `src/core` нет
  // (design.md, Решение 8). Тот же образец, что и у `src/backends/codex`.
  it('реализация decision (src/parts/steps/decision) не вправе импортировать src/core', async () => {
    const messages = await restrictedImports('src/parts/steps/decision/проба.ts', CORE_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('plugin.js')),
      messages.join('\n'),
    );
  });

  // Блок плагинов пакета совпадает на этих файлах последним и заменяет опции
  // правила целиком — значит, граница ядра и поверхности, которую строкам
  // поставки даёт блок `src/parts/**`, обязана быть перечислена в нём же.
  // Иначе переезд `decision` под `src/parts/` молча снял бы с него запрет
  // импорта `src/cli`, оставленный всем прочим строкам.
  it('реализация decision: граница плагина и граница поверхности срабатывают вместе', async () => {
    const messages = await restrictedImports('src/parts/steps/decision/проба.ts', CORE_IMPORT + CLI_IMPORT + TEMP_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('plugin.js')),
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('граница ядра')),
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('withTempDir()')),
      messages.join('\n'),
    );
  });

  // `row.ts` той же строки — не реализация вклада, ему нужен тип `BuiltinRow`
  // из `src/core/plugins/load.js`, и границе плагина он не подчиняется
  // (`ignores` блока в `eslint.config.js`).
  it('row.ts строки step-decision вправе импортировать src/core', async () => {
    const messages = await restrictedImports(
      'src/parts/steps/decision/row.ts',
      "import type { BuiltinRow } from '../../../core/plugins/load.js';\n",
    );
    assert.deepEqual(messages, []);
  });

  // Ядро плагинов не зависит от домена (`kernel-domain-free-imports`,
  // design.md, Решение 4): разбор пайплайна и бэкенды — доменные деревья,
  // запрещённые модулям `src/core/plugins/**`.
  it('ядро плагинов: импорт бэкендов значением отклоняется границей домена', async () => {
    const messages = await restrictedImports('src/core/plugins/проба.ts', PLUGIN_KERNEL_BACKEND_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('docs/microkernel-target.md')),
      messages.join('\n'),
    );
  });

  it('ядро плагинов: импорт разбора пайплайна типом отклоняется так же, как значением', async () => {
    const byValue = await restrictedImports('src/core/plugins/проба.ts', PLUGIN_KERNEL_PIPELINE_IMPORT);
    const byType = await restrictedImports('src/core/plugins/проба.ts', PLUGIN_KERNEL_PIPELINE_TYPE_IMPORT);
    assert.ok(
      byValue.some((message) => message.includes('docs/microkernel-target.md')),
      byValue.join('\n'),
    );
    assert.ok(
      byType.some((message) => message.includes('docs/microkernel-target.md')),
      byType.join('\n'),
    );
  });

  // Тот самый случай, ради которого написан этот файл: на модуле ядра
  // плагинов срабатывают все три запрета сразу, и ни один не вытесняет
  // прочие — граница домена, граница ядра и поверхности, запрет временного
  // каталога напрямую.
  it('ядро плагинов: граница домена, граница поверхности и запрет временного каталога срабатывают одновременно', async () => {
    const messages = await restrictedImports(
      'src/core/plugins/проба.ts',
      PLUGIN_KERNEL_PIPELINE_IMPORT + CLI_IMPORT + TEMP_IMPORT,
    );
    assert.ok(
      messages.some((message) => message.includes('docs/microkernel-target.md')),
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('граница ядра')),
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('withTempDir()')),
      messages.join('\n'),
    );
  });

  // Исключение доменного контракта (`plugin-surface-split`, шаг 8, — снято с
  // ядерного `contract.ts` и заведено на соседнем `pipeline-contract.ts`):
  // ровно `backend/types.js`, только типом, и ничего больше из
  // `core/backend/**`.
  it('доменный контракт вклада: backend/types.js разрешён, соседний backend/claude.js — нет', async () => {
    const allowed = await restrictedImports('src/core/plugins/pipeline-contract.ts', BACKEND_TYPES_IMPORT);
    assert.deepEqual(allowed, [], allowed.join('\n'));

    const forbidden = await restrictedImports('src/core/plugins/pipeline-contract.ts', PLUGIN_KERNEL_BACKEND_IMPORT);
    assert.ok(
      forbidden.some((message) => message.includes('docs/microkernel-target.md')),
      forbidden.join('\n'),
    );
  });

  // Требование спеки: доменной половине разрешён РОВНО тот набор доменных
  // импортов, который она несёт. Дерево бэкендов — не единственное: она несёт
  // ещё конфигурацию, вход предиката и схему журнала, и разрешение у них такое
  // же поимённое.
  it('доменный контракт вклада: разрешены ровно несомые модули, соседи по тем же деревьям — нет', async () => {
    const allowed = await restrictedImports(
      'src/core/plugins/pipeline-contract.ts',
      BACKEND_TYPES_IMPORT + CONFIG_RESOLVE_IMPORT + EXPECT_IMPORT + JOURNAL_IMPORT,
    );
    assert.deepEqual(allowed, [], allowed.join('\n'));

    for (const forbidden of [JOURNAL_WRITE_IMPORT, CONFIG_OTHER_IMPORT]) {
      const messages = await restrictedImports('src/core/plugins/pipeline-contract.ts', forbidden);
      assert.ok(messages.length > 0, `${forbidden.trim()} обязан отклоняться: ${messages.join('\n')}`);
    }
  });

  // Обратная сторона снятого исключения: ядерным модулям каталога доменные
  // деревья закрыты целиком, а не только дерево бэкендов. Иначе `contract.ts`
  // вернул бы себе доменные типы вклада соседним импортом — линт смолчал бы,
  // и граница держалась бы на одном везении.
  it('contract.ts (ядро): expect/** и journal/** закрыты так же, как backend/**', async () => {
    for (const forbidden of [EXPECT_IMPORT, JOURNAL_IMPORT, JOURNAL_WRITE_IMPORT]) {
      const messages = await restrictedImports('src/core/plugins/contract.ts', forbidden);
      assert.ok(
        messages.some((message) => message.includes('docs/microkernel-target.md')),
        `${forbidden.trim()}: ${messages.join('\n')}`,
      );
    }
  });

  // Конфигурация закрыта ядру не целиком: два её модуля читают загрузчик
  // (`ResolvedConfig`) и дерево строк (`PluginPatchRow`) — они названы
  // поимённо, остальное дерево закрыто. Остаток снимается переездом этих
  // модулей (шаг 10 плана), а не молчанием линта.
  it('ядро плагинов: из конфигурации разрешены два названных модуля, прочее дерево — нет', async () => {
    const allowed = await restrictedImports(
      'src/core/plugins/проба.ts',
      CONFIG_RESOLVE_IMPORT + "import type { PluginPatchRow } from '../config/schema.js';\n",
    );
    assert.deepEqual(allowed, [], allowed.join('\n'));

    const messages = await restrictedImports('src/core/plugins/проба.ts', CONFIG_OTHER_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('docs/microkernel-target.md')),
      messages.join('\n'),
    );
  });

  // Блок исключения заменяет опции правила, унаследованные от блока
  // `src/core/**/*.ts`, целиком — и обязан повторить их (требование спеки:
  // «MUST действовать одновременно с прочими запретами… не снимая ни одного
  // из них»). Без этого случая потеря была бы видна только нарушением,
  // которое правило обязано было поймать.
  it('доменный контракт вклада: исключение не сняло ни границы поверхности, ни запрета временного каталога', async () => {
    const messages = await restrictedImports(
      'src/core/plugins/pipeline-contract.ts',
      BACKEND_TYPES_IMPORT + PLUGIN_KERNEL_PIPELINE_IMPORT + CLI_IMPORT + TEMP_IMPORT,
    );
    assert.ok(
      messages.some((message) => message.includes('docs/microkernel-target.md')),
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('граница ядра')),
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('withTempDir()')),
      messages.join('\n'),
    );
  });

  // Задача 6.2 (`plugin-surface-split`): исключение снято с `contract.ts` —
  // теперь он подчиняется общему блоку `src/core/plugins/**` наравне с прочими
  // ядерными модулями, и `backend/types.js` в нём запрещён так же, как
  // `backend/claude.js`.
  it('contract.ts (ядро): backend/types.js запрещён так же, как прочее из core/backend', async () => {
    const messages = await restrictedImports('src/core/plugins/contract.ts', BACKEND_TYPES_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('docs/microkernel-target.md')),
      messages.join('\n'),
    );
  });

  // Переезд `builtin.ts`/`resolve.ts` из `src/core/plugins/` в `src/parts/`
  // (`kernel-domain-free-imports`, Решение 2) вывел их из-под блока ядра:
  // граница ядра и поверхности на новом месте держится собственным блоком, а
  // не тем, что её никто не нарушал.
  it('состав дефолта: импорт поверхности отклоняется границей ядра', async () => {
    const messages = await restrictedImports('src/parts/проба.ts', PARTS_CLI_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('граница ядра')),
      messages.join('\n'),
    );
  });

  it('состав дефолта: оба запрета срабатывают в одном файле', async () => {
    const messages = await restrictedImports('src/parts/проба.ts', PARTS_CLI_IMPORT + TEMP_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('граница ядра')),
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('withTempDir()')),
      messages.join('\n'),
    );
  });
});
