import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Сборщик — обычный `.mjs` без сборки, поэтому тест зовёт его отдельным
 * процессом, как `test/backlog.test.ts` зовёт `scripts/backlog.mjs`. Путь
 * считается от собранного файла теста (`dist/test/`), а не от рабочего
 * каталога.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/status.mjs', import.meta.url));

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function status(args: readonly string[]): Result {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'stepcast-status-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'openspec', 'changes'), { recursive: true });
  return root;
}

function writeBase(root: string, content: string): void {
  writeFileSync(join(root, 'docs', 'status.base.md'), content);
}

function writeFragment(
  root: string,
  slug: string,
  content: string,
  options: { archivedDate?: string } = {},
): void {
  const dirName = options.archivedDate === undefined ? slug : `${options.archivedDate}-${slug}`;
  const parent =
    options.archivedDate === undefined
      ? join(root, 'openspec', 'changes')
      : join(root, 'openspec', 'changes', 'archive');
  mkdirSync(join(parent, dirName), { recursive: true });
  writeFileSync(join(parent, dirName, 'status.md'), content);
}

function readDoc(root: string): string {
  return readFileSync(join(root, 'docs', 'status.md'), 'utf8');
}

function build(root: string): Result {
  return status(['--write', '--root', root]);
}

function check(root: string): Result {
  return status(['--check', '--root', root]);
}

const MIN_BASE = `Вводная проза.

## Работает

- **Ключ1**: текст1

## Пока нет

- **Ключ2**: текст2

## Известные ограничения

**Лид один.** Абзац первый.
`;

describe('сборка из одной базы', () => {
  it('воспроизводит разделы, строки и абзацы базы', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);

    const result = build(root);
    assert.equal(result.code, 0, result.stderr);

    const doc = readDoc(root);
    assert.match(doc, /^# Что реализовано\n\nВводная проза\./);
    assert.match(doc, /\| Ключ1 \| текст1 \|/);
    assert.match(doc, /\| Ключ2 \| текст2 \|/);
    assert.match(doc, /\*\*Лид один\.\*\* Абзац первый\./);
    assert.ok(!doc.includes('*Заведено изменением'));
  });

  it('раздел «Примечания» идёт последним', () => {
    const root = makeRoot();
    writeBase(
      root,
      `${MIN_BASE}
## Примечания

Хвостовой абзац.
`,
    );

    const result = build(root);
    assert.equal(result.code, 0, result.stderr);

    const doc = readDoc(root);
    const limitIndex = doc.indexOf('## Известные ограничения');
    const notesIndex = doc.indexOf('## Примечания');
    assert.ok(notesIndex > limitIndex);
    assert.ok(doc.trim().endsWith('Хвостовой абзац.'));
  });
});

describe('вклад фрагмента', () => {
  it('дописывает клаузу, строку и блок в соответствующие разделы', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(
      root,
      'some-change',
      `## Работает

- **Ключ1**: дополнение

## Пока нет

- **Ключ3**: текст3

## Известные ограничения

**Лид два.** Абзац два.
`,
    );

    const result = build(root);
    assert.equal(result.code, 0, result.stderr);

    const doc = readDoc(root);
    assert.match(doc, /\| Ключ1 \| текст1; дополнение \|/);
    assert.match(doc, /\| Ключ3 \| текст3 \|/);
    assert.match(doc, /\*\*Лид два\.\*\* Абзац два\.\n\n\*Заведено изменением `some-change`\.\*/);
  });

  it('изменение без фрагмента ничего не вносит', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    mkdirSync(join(root, 'openspec', 'changes', 'no-fragment'), { recursive: true });

    const before = build(root);
    assert.equal(before.code, 0, before.stderr);
    const doc1 = readDoc(root);

    const after = build(root);
    assert.equal(after.code, 0, after.stderr);
    assert.equal(readDoc(root), doc1);
  });
});

describe('склейка клауз «Работает»', () => {
  it('две клаузы одного ключа склеиваются через «; » в порядке слагов', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'budget-cost-ceiling', '## Работает\n\n- **Ключ1**: budget\n');
    writeFragment(root, 'agent-permissions', '## Работает\n\n- **Ключ1**: agent\n');

    const result = build(root);
    assert.equal(result.code, 0, result.stderr);

    assert.match(readDoc(root), /\| Ключ1 \| текст1; agent; budget \|/);
  });

  it('новый ключ приписывается в конец таблицы', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'zz-change', '## Работает\n\n- **Новый**: значение\n');

    const result = build(root);
    assert.equal(result.code, 0, result.stderr);

    const doc = readDoc(root);
    const worksSection = doc.split('## Работает')[1]?.split('## Пока нет')[0] ?? '';
    const rows = worksSection
      .split('\n')
      .filter((line) => line.startsWith('| '))
      .filter((line) => line !== '| | |');
    assert.deepEqual(
      rows.map((row) => row.split('|')[1]?.trim()),
      ['Ключ1', 'Новый'],
    );
  });
});

describe('архивация не меняет документ', () => {
  it('перенос каталога фрагмента в archive/<дата>-<slug>/ даёт побайтно тот же документ', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'some-change', '## Работает\n\n- **Ключ1**: дополнение\n');

    assert.equal(build(root).code, 0);
    const before = readDoc(root);

    mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true });
    renameSync(
      join(root, 'openspec', 'changes', 'some-change'),
      join(root, 'openspec', 'changes', 'archive', '2026-08-23-some-change'),
    );

    assert.equal(build(root).code, 0);
    assert.equal(readDoc(root), before);
  });

  it('порядок блоков по слагу не зависит от того, какое изменение заархивировано', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'budget-cost-ceiling', '## Известные ограничения\n\n**Budget.** Текст.\n');
    writeFragment(
      root,
      'agent-permissions',
      '## Известные ограничения\n\n**Agent.** Текст.\n',
      { archivedDate: '2026-08-01' },
    );

    const result = build(root);
    assert.equal(result.code, 0, result.stderr);

    const doc = readDoc(root);
    assert.ok(doc.indexOf('**Agent.**') < doc.indexOf('**Budget.**'));
  });
});

describe('снятие строк и блоков', () => {
  it('снимает строку «Пока нет» фрагментом', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(
      root,
      'ships-it',
      `## Пока нет: снято

- **Ключ2**

## Работает

- **Ключ2**: теперь работает
`,
    );

    const result = build(root);
    assert.equal(result.code, 0, result.stderr);

    const doc = readDoc(root);
    assert.ok(!doc.includes('| Ключ2 | текст2 |'));
    assert.match(doc, /\| Ключ2 \| теперь работает \|/);
  });

  it('снятую строку тот же фрагмент заводит заново со своей формулировкой', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(
      root,
      'reword',
      `## Пока нет: снято

- **Ключ2**

## Пока нет

- **Ключ2**: переформулировано
`,
    );

    const result = build(root);
    assert.equal(result.code, 0, result.stderr);

    const doc = readDoc(root);
    assert.match(doc, /\| Ключ2 \| переформулировано \|/);
    assert.ok(!doc.includes('| Ключ2 | текст2 |'));
  });

  it('снятие несуществующей строки «Пока нет» — отказ с указанием файла и ключа', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'broken', '## Пока нет: снято\n\n- **НетТакого**\n');

    const result = build(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /НетТакого/);
    assert.match(result.stderr, /broken/);
  });

  it('снятие несуществующего блока ограничений — отказ с указанием файла и лида', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'broken', '## Известные ограничения: снято\n\n- **Нет такого лида**\n');

    const result = build(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Нет такого лида/);
    assert.match(result.stderr, /broken/);
  });
});

describe('отказы разбора', () => {
  it('незнакомый заголовок фрагмента, включая «Примечания»', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'broken', '## Примечания\n\nТекст.\n');

    const result = status(['--write', '--root', root]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Примечания/);
  });

  it('пункт без ключа', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'broken', '## Работает\n\n- просто текст без ключа\n');

    const result = build(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /без ключа/);
  });

  it('пункт с двоеточием, но без жирного ключа — отказ, а не догадка', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'broken', '## Работает\n\n- Бюджет: `on_exceed: wait` усыпляет прогон\n');

    const result = build(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /без ключа/);
    assert.match(result.stderr, /жирным лидом/);
  });

  it('снятие без жирного ключа — отказ', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'broken', '## Пока нет: снято\n\n- Ключ2\n');

    const result = build(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /жирным лидом/);
  });

  it('текст вне разделов фрагмента', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'broken', 'Клауза мимо раздела.\n\n## Работает\n\n- **Ключ1**: текст\n');

    const result = build(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /вне разделов/);
    assert.match(result.stderr, /Клауза мимо раздела/);
  });

  it('абзац ограничения без жирного лида', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'broken', '## Известные ограничения\n\nАбзац без лида.\n');

    const result = build(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /жирного лида/);
  });

  it('повторённый ключ во фрагменте', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'broken', '## Работает\n\n- **Дубль**: раз\n- **Дубль**: два\n');

    const result = build(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Дубль/);
    assert.match(result.stderr, /повторяется/);
  });

  it('один слаг в активном и архивном каталоге — отказ с указанием обоих путей', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'dup-slug', '## Работает\n\n- **А**: б\n');
    writeFragment(root, 'dup-slug', '## Работает\n\n- **В**: г\n', { archivedDate: '2026-08-23' });

    const result = build(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /dup-slug/);
    assert.match(result.stderr, /archive/);
  });
});

describe('занятый ключ «Пока нет»', () => {
  it('два фрагмента с одним ключом — отказ, называющий ключ и оба источника', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'first-change', '## Пока нет\n\n- **Общий**: раз\n');
    writeFragment(root, 'second-change', '## Пока нет\n\n- **Общий**: два\n');

    const result = build(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Общий/);
    assert.match(result.stderr, /first-change/);
    assert.match(result.stderr, /second-change/);
  });

  it('фрагмент с ключом базы — отказ, называющий ключ, фрагмент и базу', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'some-change', '## Пока нет\n\n- **Ключ2**: другое\n');

    const result = build(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Ключ2/);
    assert.match(result.stderr, /some-change/);
    assert.match(result.stderr, /status\.base\.md/);
  });
});

describe('атрибуция блоков', () => {
  it('блок из фрагмента несёт строку с его слагом', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    writeFragment(root, 'judge-predicate', '## Известные ограничения\n\n**Судья.** Текст.\n');

    const result = build(root);
    assert.equal(result.code, 0, result.stderr);
    assert.match(readDoc(root), /\*Заведено изменением `judge-predicate`\.\*/);
  });

  it('блок из базы атрибуции не несёт', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);

    const result = build(root);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!readDoc(root).includes('*Заведено изменением'));
  });
});

describe('ключ и лид с непростой разметкой', () => {
  it('ключ с двоеточием внутри разбирается целиком', () => {
    const root = makeRoot();
    writeBase(
      root,
      `Вводная проза.

## Пока нет

- **Триггеры: расписание, GitHub**: нет
`,
    );

    const result = build(root);
    assert.equal(result.code, 0, result.stderr);
    assert.match(readDoc(root), /\| Триггеры: расписание, GitHub \| нет \|/);
  });

  it('лид, разбитый переносом строки, остаётся отдельным блоком и снимается', () => {
    const root = makeRoot();
    writeBase(
      root,
      `Вводная проза.

## Известные ограничения

**Лид один.** Абзац первый.

**Лид, разбитый
переносом строки.** Абзац второй.
`,
    );
    writeFragment(
      root,
      'lifts-it',
      '## Известные ограничения: снято\n\n- **Лид, разбитый переносом строки.**\n',
    );

    const result = build(root);
    assert.equal(result.code, 0, result.stderr);

    const doc = readDoc(root);
    assert.ok(!doc.includes('Абзац второй.'));
    assert.match(doc, /\*\*Лид один\.\*\* Абзац первый\./);
  });

  it('пустой раздел «Известные ограничения» в документ не попадает', () => {
    const root = makeRoot();
    writeBase(root, 'Вводная проза.\n\n## Работает\n\n- **Ключ1**: текст1\n');

    const result = build(root);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!readDoc(root).includes('## Известные ограничения'));
  });
});

describe('разбор аргументов', () => {
  it('--root без значения — отказ, а не молчаливый рабочий каталог', () => {
    const result = status(['--check', '--root']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--root/);
  });

  it('неизвестный ключ — отказ', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);

    const result = status(['--write', '--root', root, '--force']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--force/);
  });
});

describe('режим --check', () => {
  it('совпадение даёт ноль и ничего не пишет', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    assert.equal(build(root).code, 0);
    const before = readDoc(root);

    const result = check(root);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readDoc(root), before);
  });

  it('расхождение даёт ненулевой код и упоминает команду пересборки', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);
    assert.equal(build(root).code, 0);
    writeFileSync(join(root, 'docs', 'status.md'), 'испорченный документ\n');

    const result = check(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /status:build/);
  });

  it('отсутствующий docs/status.md — расхождение, а не падение', () => {
    const root = makeRoot();
    writeBase(root, MIN_BASE);

    const result = check(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /status:build/);
  });
});
