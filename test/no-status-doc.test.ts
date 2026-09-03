import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * `drop-status-doc` упразднил сводный учёт: документ, его основу, сборщик
 * `scripts/status.mjs`, фрагменты в каталогах изменений и гейт `status:check`
 * в составе объявленной проверки. Механизм возвращается двумя разными
 * способами — ссылкой из кода, промпта или работы и возвратом файла-фрагмента,
 * — поэтому проверок здесь тоже две.
 *
 * Зелёный тест на уже вычищенном дереве сам по себе ничего не доказывает,
 * поэтому обе проверки называют место отказа: файл со строкой либо путь
 * вернувшегося фрагмента.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Упоминание документа, его основы, сборщика или любого из снятых скриптов. */
const MENTION = /status\.md|status\.base|status:build|status:check|status\.mjs/;

const SCANNED_PREFIXES = ['src/', 'test/', 'ui/', 'docs/', '.stepcast/', 'schema/', 'scripts/'];
const SCANNED_FILES = ['README.md', 'package.json', '.gitattributes'];

/**
 * Не смотрятся четыре места, причина у каждого своя:
 *
 * - `backlog.md` — его ведёт движок петли, агентским работам трогать
 *   запрещено, а клаузы `done_when` прошлых пунктов обязаны называть
 *   упразднённое по имени: это запись решения, а не живая ссылка;
 * - `examples/README.md` — до этого изменения лежал вне объявленных границ
 *   правок, и расширение границ действует лишь со следующего прогона;
 * - `docs/superpowers/plans/**` — архив прошлых планов, где упоминания
 *   историчны по смыслу;
 * - сам этот файл — он обязан называть то, что стережёт.
 *
 * Исключения — необход, а не требование: когда упоминания уйдут и оттуда,
 * тест обязан остаться зелёным.
 */
const SKIPPED_PREFIXES = ['docs/superpowers/plans/'];
const SKIPPED_FILES = ['test/no-status-doc.test.ts'];

function tracked(args: readonly string[]): readonly string[] {
  const result = spawnSync('git', ['-C', ROOT, 'ls-files', '-z', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ls-files отказал: ${result.stderr}`);
  return result.stdout.split('\0').filter((line) => line !== '');
}

describe('упразднённый сводный учёт не возвращается', () => {
  it('ни один отслеживаемый файл кода, документации и петли его не упоминает', () => {
    const files = tracked([]).filter(
      (file) =>
        (SCANNED_PREFIXES.some((prefix) => file.startsWith(prefix)) || SCANNED_FILES.includes(file)) &&
        !SKIPPED_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
        !SKIPPED_FILES.includes(file),
    );
    assert.ok(files.length > 0, 'ни одного файла к просмотру — проверка выродилась в пустую');

    const found: string[] = [];
    for (const file of files) {
      readFileSync(join(ROOT, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (MENTION.test(line)) found.push(`${file}:${index + 1}: ${line.trim()}`);
        });
    }

    assert.deepEqual(found, [], `упоминание упразднённого учёта:\n${found.join('\n')}`);
  });

  /**
   * Содержимое каталогов изменений не сканируется: `proposal.md` и `design.md`
   * этого и прошлых изменений обязаны называть упразднённое по имени — это
   * запись решения. А вот возврат фрагмента ловится именем файла.
   */
  it('под openspec/ нет ни одного файла с этим именем', () => {
    const fragments = tracked(['openspec']).filter((file) => file.endsWith('/status.md'));
    assert.deepEqual(fragments, [], `фрагмент учёта вернулся:\n${fragments.join('\n')}`);
  });
});
