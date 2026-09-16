import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
 *
 * Граница ядра сведена в одну запись правила на ступени 8 переезда
 * `source-tree-microkernel-layout` (design.md, Решение 2): `src/kernel/**` не
 * импортирует `src/parts/**`, `src/plugin/**` и `src/bin.ts`. Перечни
 * доменных деревьев по именам сегментов и оба поимённых исключения
 * (`config/resolve.js`, `config/schema.js`), нужные, пока домен жил рядом с
 * ядром в `src/core/`, сняты вместе с самим `src/core/`. Единственное
 * оставшееся исключение — `load.ts`/`registry.ts`, и только на
 * `parts/pipeline/contract.js` (design.md, Решение 4, шестое отступление);
 * проверки ниже называют его прямо и проверяют, что больше ни один модуль
 * ядра исключения не несёт.
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

async function restrictedImports(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === 'no-restricted-imports')
    .map((message) => message.message);
}

const TEMP_IMPORT = "import { mkdtempSync } from 'node:fs';\n";
const TMPDIR_IMPORT = "import { tmpdir } from 'node:os';\n";

/**
 * Подставные файлы двух плагинов поставки: границу проверяем с их глубины,
 * потому что специфик, который они пишут, относительный и глубину знает.
 */
const CODEX_PROBE = 'src/parts/backends/codex/проба.ts';
const DECISION_PROBE = 'src/parts/pipeline/steps/decision/проба.ts';

/**
 * Внутренние модули движка — теми спецификами, какими их назвал бы сам плагин
 * со своей глубины. Адреса настоящие, и проверка ниже это требует: до переезда
 * `source-tree-microkernel-layout` запрет был назван деревом каталога `core`, а
 * проба — адресом `../../core/backend/claude.js`; когда дерево `src/core/`
 * снялось, правило и проба разошлись с действительностью одинаково и остались
 * зелёными вдвоём. `no-restricted-imports` сверяет текст специфика, а не его
 * разрешение, поэтому проба по несуществующему адресу проходит тавтологически
 * и вакуумного правила не замечает.
 */
const CODEX_INTERNAL = [
  '../../pipeline/run/journal/schema.js',
  '../../pipeline/contract.js',
  '../../pipeline/config/resolve.js',
  '../../load.js',
  '../claude/adapter.js',
  '../../../kernel/load.js',
];
const DECISION_INTERNAL = [
  '../../run/journal/schema.js',
  '../../document/expand.js',
  '../../contract.js',
  '../../services.js',
  '../../../load.js',
  '../../../../kernel/load.js',
];

/**
 * Подъём выше `src/` — отдельная запись правила: разрешённый вход вклада
 * глубже четырёх ступеней не поднимается, отрицать там нечего. Адрес
 * настоящий, как и у прочих проб.
 */
const ABOVE_SRC = '../../../../../test/tmp.js';

/** Разрешённый вход вклада: два публичных подпутя, каждый со своей глубины. */
const CODEX_SURFACE = ['../../pipeline/surface.js', '../../../plugin/index.js'];
const DECISION_SURFACE = ['../../surface.js', '../../../../plugin/index.js'];

function importLine(specifier: string): string {
  return `import * as probe from '${specifier}';\n`;
}

/** Адрес, на который специфик указывает с диска: `.js` в исходнике — расширение сборки. */
function targetOf(probeFile: string, specifier: string): string {
  return resolve(repoRoot, dirname(probeFile), specifier).replace(/\.js$/, '.ts');
}

// Импорты строки поставки (`src/parts/pipeline/services.js`) — тем же
// спецификом, каким его назвал бы модуль ядра (`src/kernel/kernel.ts`).
const PARTS_VALUE_IMPORT = "import { PIPELINE_SERVICES } from '../parts/pipeline/services.js';\n";
const PARTS_TYPE_IMPORT = "import type { PartRow } from '../parts/pipeline/services.js';\n";
const PLUGIN_SURFACE_IMPORT = "import { definePlugin } from '../plugin/index.js';\n";
const BIN_IMPORT = "import '../bin.js';\n";
const BIN_IMPORT_DEEP = "import '../../bin.js';\n";

// Единственное разрешённое исключение (design.md, Решение 4, шестое
// отступление): контракт декларативного плагина, переехавший в
// `parts/pipeline/contract.ts`. Оба файла — `load.ts` и `registry.ts` — лежат
// прямо в `src/kernel/`, и специфик у обоих один.
const CONTRACT_IMPORT = "import { StepcastPluginSchema } from '../parts/pipeline/contract.js';\n";

describe('eslint: запреты импорта действуют одновременно', () => {
  // test-sandbox, «Код движка мимо помощника»: запрет прямого создания
  // временного каталога действует широко, по всему src/, не только на ядре.
  it('движок: прямое создание временного каталога отклоняется', async () => {
    const messages = await restrictedImports('src/parts/pipeline/run/проба.ts', TEMP_IMPORT + TMPDIR_IMPORT);
    assert.equal(messages.length, 2, messages.join('\n'));
    assert.ok(messages.every((message) => message.includes('src/kernel/fs/tempDir.ts')), messages.join('\n'));
  });

  it('ядро: импорт строки поставки отклоняется границей ядра', async () => {
    const messages = await restrictedImports('src/kernel/kernel.ts', PARTS_VALUE_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('design.md, Решение 2')),
      messages.join('\n'),
    );
  });

  it('ядро: импорт строки поставки типом отклоняется так же, как значением', async () => {
    const messages = await restrictedImports('src/kernel/kernel.ts', PARTS_TYPE_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('design.md, Решение 2')),
      messages.join('\n'),
    );
  });

  it('ядро: импорт публичной поверхности отклоняется той же границей', async () => {
    const messages = await restrictedImports('src/kernel/kernel.ts', PLUGIN_SURFACE_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('design.md, Решение 2')),
      messages.join('\n'),
    );
  });

  it('ядро: импорт src/bin.ts отклоняется той же границей на любой относительной глубине', async () => {
    const shallow = await restrictedImports('src/kernel/kernel.ts', BIN_IMPORT);
    const deep = await restrictedImports('src/kernel/tree/tree.ts', BIN_IMPORT_DEEP);
    assert.ok(
      shallow.some((message) => message.includes('design.md, Решение 2')),
      shallow.join('\n'),
    );
    assert.ok(
      deep.some((message) => message.includes('design.md, Решение 2')),
      deep.join('\n'),
    );
  });

  // Тот самый случай, ради которого проверка и написана: на файле ядра
  // действуют оба запрета сразу, и ни один не вытесняет другого.
  it('ядро: граница ядра и запрет временного каталога срабатывают в одном файле', async () => {
    const messages = await restrictedImports('src/kernel/kernel.ts', PARTS_VALUE_IMPORT + TEMP_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('design.md, Решение 2')),
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('withTempDir()')),
      messages.join('\n'),
    );
  });

  // Помощник заводит каталог напрямую по своему назначению, но границу ядра
  // исключением из первого запрета не теряет.
  it('помощник ядра: временный каталог разрешён, граница ядра остаётся', async () => {
    const messages = await restrictedImports('src/kernel/fs/tempDir.ts', PARTS_VALUE_IMPORT + TEMP_IMPORT + TMPDIR_IMPORT);
    assert.deepEqual(
      messages.filter((message) => message.includes('tempDir.ts')),
      [],
      'помощнику прямое создание разрешено',
    );
    assert.ok(
      messages.some((message) => message.includes('design.md, Решение 2')),
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

  // Проба границы плагина поставки обязана называть адрес, который на диске
  // есть: правило сверяет текст специфика, и проба по снесённому дереву
  // проходит, что бы правило ни запрещало. Этим и держится смысл проверок
  // ниже — без неё вакуумное правило выглядело бы работающим.
  it('пробы границы плагина названы настоящими модулями движка', () => {
    for (const [probe, specifiers] of [
      [CODEX_PROBE, [...CODEX_INTERNAL, ...CODEX_SURFACE]],
      [DECISION_PROBE, [...DECISION_INTERNAL, ...DECISION_SURFACE, ABOVE_SRC]],
    ] as const) {
      for (const specifier of specifiers) {
        const target = targetOf(probe, specifier);
        assert.ok(existsSync(target), `${probe}: '${specifier}' → ${target} — такого модуля нет`);
      }
    }
  });

  // Плагины пакета: близость к ядру ограничена механически (design.md
  // первого настоящего плагина, решение 2). Запрет назван подъёмом из
  // каталога плагина, а не деревом движка: оба плагина лежат внутри
  // `src/parts/`, и внутренний модуль они называют относительным спецификом
  // без узнаваемого сегмента.
  it('плагины пакета: импорт внутреннего модуля движка отклоняется границей плагина', async () => {
    for (const specifier of CODEX_INTERNAL) {
      const messages = await restrictedImports(CODEX_PROBE, importLine(specifier));
      assert.ok(
        messages.some((message) => message.includes('src/plugin/index.ts')),
        `${specifier}: ${messages.join('\n')}`,
      );
    }
  });

  // Обратная сторона запрета: разрешённый вход вклада им не задет. Без этой
  // проверки границу можно было бы «починить» запретом всего подряд, и
  // сломался бы сам плагин, а не тест.
  it('плагины пакета: публичные подпути границей не задеты', async () => {
    for (const specifier of CODEX_SURFACE) {
      const messages = await restrictedImports(CODEX_PROBE, importLine(specifier));
      assert.deepEqual(messages, [], `${specifier}: ${messages.join('\n')}`);
    }
  });

  // Тот же случай, что и у ядра выше, — оба запрета обязаны сработать в одном
  // файле, иначе блок плагина молча снял бы запрет временного каталога.
  it('плагины пакета: оба запрета срабатывают в одном файле', async () => {
    const messages = await restrictedImports(CODEX_PROBE, importLine(CODEX_INTERNAL[0]!) + TEMP_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('src/plugin/index.ts')),
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('withTempDir()')),
      messages.join('\n'),
    );
  });

  // Реализация `decision` (`src/parts/pipeline/steps/decision/`) — без
  // отдельного блока конфига файлы попали бы под общий `src/**` выше, где
  // запрета на внутренние модули движка нет (design.md, Решение 8). Глубина у
  // неё своя, и специфики те же модули называют иначе, чем у codex.
  it('реализация decision (src/parts/pipeline/steps/decision) не вправе импортировать внутренние модули движка', async () => {
    for (const specifier of DECISION_INTERNAL) {
      const messages = await restrictedImports(DECISION_PROBE, importLine(specifier));
      assert.ok(
        messages.some((message) => message.includes('src/plugin/index.ts')),
        `${specifier}: ${messages.join('\n')}`,
      );
    }
  });

  it('реализация decision: подъём выше src/ отклоняется тем же блоком', async () => {
    const messages = await restrictedImports(DECISION_PROBE, importLine(ABOVE_SRC));
    assert.ok(
      messages.some((message) => message.includes('src/plugin/index.ts')),
      messages.join('\n'),
    );
  });

  it('реализация decision: публичные подпути границей не задеты', async () => {
    for (const specifier of DECISION_SURFACE) {
      const messages = await restrictedImports(DECISION_PROBE, importLine(specifier));
      assert.deepEqual(messages, [], `${specifier}: ${messages.join('\n')}`);
    }
  });

  // Блок плагинов пакета совпадает на этих файлах последним и заменяет опции
  // правила целиком — значит, запрет временного каталога, который дают все
  // строки поставки, обязан быть перечислен в нём же. Иначе переезд
  // `decision` под `src/parts/` молча снял бы его с одной этой реализации.
  it('реализация decision: граница плагина и запрет временного каталога срабатывают вместе', async () => {
    const messages = await restrictedImports(DECISION_PROBE, importLine(DECISION_INTERNAL[0]!) + TEMP_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('src/plugin/index.ts')),
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('withTempDir()')),
      messages.join('\n'),
    );
  });

  // `row.ts` той же строки — не реализация вклада, ему нужна строка-поставщик
  // (`src/parts/pipeline/services.js`), и границе плагина он не подчиняется
  // (`ignores` блока в `eslint.config.js`): специфик, отклоняемый у соседей,
  // ему не грозит вовсе, потому что блок его не касается.
  it('row.ts строки step-decision не подчиняется границе плагина', async () => {
    for (const specifier of DECISION_INTERNAL) {
      const messages = await restrictedImports('src/parts/pipeline/steps/decision/row.ts', importLine(specifier));
      assert.deepEqual(messages, [], `${specifier}: ${messages.join('\n')}`);
    }
  });

  // Единственное оставшееся исключение границы ядра (design.md, Решение 4,
  // шестое отступление): ровно `parts/pipeline/contract.js`, только этим
  // двум файлам.
  it('load.ts и registry.ts: контракт декларативного плагина разрешён, прочая строка поставки — нет', async () => {
    for (const file of ['src/kernel/load.ts', 'src/kernel/registry.ts']) {
      const allowed = await restrictedImports(file, CONTRACT_IMPORT);
      assert.deepEqual(allowed, [], `${file}: ${allowed.join('\n')}`);

      const forbidden = await restrictedImports(file, PARTS_VALUE_IMPORT);
      assert.ok(
        forbidden.some((message) => message.includes('design.md, Решение 2')),
        `${file}: ${forbidden.join('\n')}`,
      );
    }
  });

  // Исключение не снимает ни запрет на публичную поверхность, ни запрет
  // временного каталога — оно узкое, на один специфик, а не общее
  // ослабление границы этих двух файлов.
  it('load.ts: исключение контракта не снимает ни поверхность, ни временный каталог', async () => {
    const messages = await restrictedImports('src/kernel/load.ts', CONTRACT_IMPORT + PLUGIN_SURFACE_IMPORT + TEMP_IMPORT);
    assert.deepEqual(
      messages.filter((message) => message.includes('parts/pipeline/contract')),
      [],
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('design.md, Решение 2')),
      messages.join('\n'),
    );
    assert.ok(
      messages.some((message) => message.includes('withTempDir()')),
      messages.join('\n'),
    );
  });

  // Обратная сторона: у соседей `load.ts`/`registry.ts` по каталогу того же
  // исключения нет — контракт декларативного плагина запрещён им так же, как
  // и прочая строка поставки. Без этой проверки исключение легко расползлось
  // бы на весь `src/kernel/` незаметно.
  it('прочие модули ядра исключения не несут: контракт декларативного плагина запрещён так же, как прочая строка поставки', async () => {
    for (const file of ['src/kernel/kernel.ts', 'src/kernel/contract.ts', 'src/kernel/tree/tree.ts', 'src/kernel/introspect.ts']) {
      const messages = await restrictedImports(file, CONTRACT_IMPORT);
      assert.ok(
        messages.some((message) => message.includes('design.md, Решение 2')),
        `${file}: ${messages.join('\n')}`,
      );
    }
  });

  // Переезд `builtin.ts`/`resolve.ts`/`load.ts`/`rows.ts` из `src/core/plugins/`
  // в `src/parts/` (`kernel-domain-free-imports`, Решение 2) вывел их из-под
  // блока ядра: они больше не подчиняются границе ядра вовсе — состав дефолта
  // вправе импортировать что угодно из своего дерева, только запрет
  // временного каталога держится на нём тем же общим блоком, что и на любом
  // другом модуле движка.
  it('состав дефолта: временный каталог напрямую по-прежнему отклоняется', async () => {
    const messages = await restrictedImports('src/parts/проба.ts', TEMP_IMPORT);
    assert.ok(
      messages.some((message) => message.includes('withTempDir()')),
      messages.join('\n'),
    );
  });
});
