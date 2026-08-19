import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createAnchorer, detectAnchorKind, sameAnchor } from '../src/core/anchor/index.js';
import { loadIgnoreRules } from '../src/core/anchor/ignore.js';
import { StepcastError } from '../src/core/errors.js';

interface Bed {
  readonly dir: string;
  readonly stateDir: string;
  write(relativePath: string, content: string): void;
  remove(relativePath: string): void;
  read(relativePath: string): string;
}

function bed(options: { readonly git: boolean }): Bed {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-anchor-'));
  const dir = join(base, 'work');
  const stateDir = join(base, 'state');
  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  if (options.git) {
    execFileSync('git', ['-C', dir, 'init', '--quiet', '--initial-branch=main']);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Тест']);
  }

  return {
    dir,
    stateDir,
    write(relativePath, content) {
      const full = join(dir, relativePath);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    },
    remove(relativePath) {
      rmSync(join(dir, relativePath), { force: true, recursive: true });
    },
    read(relativePath) {
      return readFileSync(join(dir, relativePath), 'utf8');
    },
  };
}

function commit(dir: string, message: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', message]);
}

describe('workspace-anchor: фиксация состояния', () => {
  // Сценарий: «Одинаковые деревья дают одинаковый якорь»
  it('даёт одинаковый якорь для посодержимо одинаковых деревьев', () => {
    for (const git of [true, false]) {
      const b = bed({ git });
      b.write('src/a.ts', 'один');
      const first = createAnchorer({ dir: b.dir, stateDir: b.stateDir }).capture();

      b.write('src/a.ts', 'два');
      b.write('src/a.ts', 'один');
      const second = createAnchorer({ dir: b.dir, stateDir: b.stateDir, scope: 'второй' }).capture();

      assert.ok(sameAnchor(first, second), `способ ${git ? 'git' : 'manifest'}`);
    }
  });

  it('меняет якорь при изменении содержимого', () => {
    for (const git of [true, false]) {
      const b = bed({ git });
      b.write('a.txt', 'один');
      const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir });
      const before = anchorer.capture();

      b.write('a.txt', 'два');
      const after = anchorer.capture();

      assert.ok(!sameAnchor(before, after), `способ ${git ? 'git' : 'manifest'}`);
    }
  });

  // Сценарий: «История проекта не затронута»
  it('не создаёт коммитов, не двигает HEAD и не трогает индекс репозитория', () => {
    const b = bed({ git: true });
    b.write('a.txt', 'начало');
    commit(b.dir, 'первый');

    // Пользователь подготовил к коммиту одно из двух изменений.
    b.write('a.txt', 'правка пользователя');
    b.write('b.txt', 'не подготовлено');
    execFileSync('git', ['-C', b.dir, 'add', 'a.txt']);

    const headBefore = execFileSync('git', ['-C', b.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const logBefore = execFileSync('git', ['-C', b.dir, 'log', '--oneline'], { encoding: 'utf8' });
    const indexBefore = execFileSync('git', ['-C', b.dir, 'diff', '--cached', '--name-only'], {
      encoding: 'utf8',
    });

    createAnchorer({ dir: b.dir, stateDir: b.stateDir }).capture();

    assert.equal(execFileSync('git', ['-C', b.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), headBefore);
    assert.equal(execFileSync('git', ['-C', b.dir, 'log', '--oneline'], { encoding: 'utf8' }), logBefore);
    assert.equal(
      execFileSync('git', ['-C', b.dir, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }),
      indexBefore,
      'индекс пользователя должен остаться нетронутым',
    );
  });
});

describe('workspace-anchor: исключения совпадают с видимостью git', () => {
  // Сценарий: «Игнорируемые пути не влияют на якорь»
  it('не замечает появления игнорируемого файла', () => {
    for (const git of [true, false]) {
      const b = bed({ git });
      b.write('.gitignore', 'ignored/\n*.log\n');
      b.write('src/a.ts', 'код');
      const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir });
      const before = anchorer.capture();

      b.write('ignored/thing.txt', 'мусор');
      b.write('debug.log', 'шум');

      assert.ok(sameAnchor(before, anchorer.capture()), `способ ${git ? 'git' : 'manifest'}`);
    }
  });

  // Сценарий: «Неотслеживаемый, но не игнорируемый файл учитывается»
  it('замечает новый неигнорируемый файл', () => {
    for (const git of [true, false]) {
      const b = bed({ git });
      b.write('.gitignore', '*.log\n');
      b.write('src/a.ts', 'код');
      const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir });
      const before = anchorer.capture();

      b.write('src/b.ts', 'новый');

      assert.ok(!sameAnchor(before, anchorer.capture()), `способ ${git ? 'git' : 'manifest'}`);
    }
  });
});

describe('workspace-anchor: восстановление', () => {
  // Сценарий: «Восстановление состояния»
  it('приводит дерево к зафиксированному состоянию', () => {
    const b = bed({ git: true });
    b.write('a.txt', 'начало');
    b.write('b.txt', 'останется');
    commit(b.dir, 'первый');

    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir });
    const saved = anchorer.capture();

    b.write('a.txt', 'испорчено');
    b.write('лишний.txt', 'появился после');
    b.remove('b.txt');

    anchorer.restore(saved);

    assert.equal(b.read('a.txt'), 'начало');
    assert.equal(b.read('b.txt'), 'останется');
    assert.ok(sameAnchor(saved, anchorer.capture()), 'состояние должно совпасть с сохранённым');
  });

  // Сценарий: «Объекты недоступны»
  it('отказывает при недоступных объектах и не трогает дерево', () => {
    const b = bed({ git: true });
    b.write('a.txt', 'значение');
    commit(b.dir, 'первый');

    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir });

    assert.throws(
      () => anchorer.restore({ kind: 'git', id: '0'.repeat(40) }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /недоступны/);
        return true;
      },
    );

    assert.equal(b.read('a.txt'), 'значение', 'дерево должно остаться нетронутым');
  });

  // Сценарий: «Восстановление отклоняется для хеш-манифеста»
  it('объясняет, почему манифест не восстанавливает дерево', () => {
    const b = bed({ git: false });
    b.write('a.txt', 'значение');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir });
    const saved = anchorer.capture();

    assert.throws(
      () => anchorer.restore(saved),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /хеш-манифестом/);
        assert.match(error.hint ?? '', /содержимого файлов не хранит/);
        return true;
      },
    );
  });
});

describe('workspace-anchor: различия между состояниями', () => {
  it('перечисляет изменившиеся пути обоими способами', () => {
    for (const git of [true, false]) {
      const b = bed({ git });
      b.write('src/a.ts', 'один');
      b.write('src/b.ts', 'два');
      if (git) commit(b.dir, 'первый');

      const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir });
      const before = anchorer.capture();

      b.write('src/b.ts', 'изменён');
      b.write('src/c.ts', 'добавлен');
      const after = anchorer.capture();

      const comparison = anchorer.changedPaths(before, after);
      assert.ok(comparison.comparable, `способ ${git ? 'git' : 'manifest'}`);
      assert.deepEqual(comparison.paths, ['src/b.ts', 'src/c.ts']);
    }
  });

  it('даёт пустой список для совпавших состояний', () => {
    const b = bed({ git: true });
    b.write('a.txt', 'значение');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir });
    const anchor = anchorer.capture();

    const comparison = anchorer.changedPaths(anchor, anchor);
    assert.ok(comparison.comparable);
    assert.deepEqual(comparison.paths, []);
  });

  // Сценарий: «Способы не смешиваются»
  it('считает якоря разных способов несравнимыми, а не различающимися', () => {
    const b = bed({ git: true });
    b.write('a.txt', 'значение');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir });
    const git = anchorer.capture();

    const comparison = anchorer.changedPaths(git, { kind: 'manifest', id: 'что-то' });
    assert.equal(comparison.comparable, false);
    assert.match(
      (comparison as { reason: string }).reason,
      /разными способами/,
      'причина должна называть несравнимость, а не различие',
    );
  });

  it('выводит патч из пары состояний git', () => {
    const b = bed({ git: true });
    b.write('a.txt', 'до\n');
    commit(b.dir, 'первый');

    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir });
    const before = anchorer.capture();
    b.write('a.txt', 'после\n');
    const after = anchorer.capture();

    const patch = anchorer.diff(before, after);
    assert.ok(patch !== undefined);
    assert.match(patch, /a\.txt/);
    assert.match(patch, /\+после/);
    assert.equal(anchorer.diff(before, before), undefined, 'совпавшие состояния патча не дают');
  });
});

describe('workspace-anchor: выбор способа фиксации', () => {
  it('выбирает git внутри репозитория и манифест вне его', () => {
    assert.equal(detectAnchorKind(bed({ git: true }).dir), 'git');
    assert.equal(detectAnchorKind(bed({ git: false }).dir), 'manifest');
  });
});

describe('workspace-anchor: правила игнорирования вне git', () => {
  it('разбирает каталоги, маски и привязку к корню', () => {
    const b = bed({ git: false });
    b.write('.gitignore', '# комментарий\nnode_modules/\n*.log\n/только-в-корне\n');
    const rules = loadIgnoreRules(b.dir);

    assert.equal(rules.ignores('node_modules', true), true);
    assert.equal(rules.ignores('src/node_modules', true), true);
    assert.equal(rules.ignores('node_modules', false), false, 'правило только для каталога');
    assert.equal(rules.ignores('debug.log', false), true);
    assert.equal(rules.ignores('только-в-корне', false), true);
    assert.equal(rules.ignores('src/только-в-корне', false), false);
    assert.equal(rules.ignores('.git/config', false), true);
    assert.equal(rules.ignores('src/a.ts', false), false);
  });
});
