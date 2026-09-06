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
});
