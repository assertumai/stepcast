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
const PLUGIN_KERNEL_PIPELINE_IMPORT = "import { registerBuiltinStepKinds } from '../pipeline/expand.js';\n";
const PLUGIN_KERNEL_PIPELINE_TYPE_IMPORT = "import type { ExpandOptions } from '../pipeline/expand.js';\n";
const BACKEND_TYPES_IMPORT = "import type { BackendAdapter } from '../backend/types.js';\n";

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

  // Исключение поверхности контракта (design.md, «Что в пункте очереди
  // уточнено»): ровно `backend/types.js`, только типом, и ничего больше из
  // `core/backend/**`.
  it('контракт вклада: backend/types.js разрешён, соседний backend/claude.js — нет', async () => {
    const allowed = await restrictedImports('src/core/plugins/contract.ts', BACKEND_TYPES_IMPORT);
    assert.deepEqual(allowed, [], allowed.join('\n'));

    const forbidden = await restrictedImports('src/core/plugins/contract.ts', PLUGIN_KERNEL_BACKEND_IMPORT);
    assert.ok(
      forbidden.some((message) => message.includes('docs/microkernel-target.md')),
      forbidden.join('\n'),
    );
  });

  // Блок исключения заменяет опции правила, унаследованные от блока
  // `src/core/**/*.ts`, целиком — и обязан повторить их (требование спеки:
  // «MUST действовать одновременно с прочими запретами… не снимая ни одного
  // из них»). Без этого случая потеря была бы видна только нарушением,
  // которое правило обязано было поймать.
  it('контракт вклада: исключение не сняло ни границы поверхности, ни запрета временного каталога', async () => {
    const messages = await restrictedImports(
      'src/core/plugins/contract.ts',
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
