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

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '--quiet', '--initial-branch=main']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Тест']);
}

function bed(options: { readonly git: boolean }): Bed {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-anchor-'));
  const dir = join(base, 'work');
  const stateDir = join(base, 'state');
  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  if (options.git) initGitRepo(dir);

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

  // Задача 3.9 / Сценарий: пустой состав не меняет поведение
  it('на пустом составе ведёт себя буква в букву как без него', () => {
    const dir = bed({ git: true }).dir;
    assert.equal(detectAnchorKind(dir, []), detectAnchorKind(dir));
  });

  it('выбирает composite на непустом составе', () => {
    const b = bed({ git: true });
    initGitRepo(join(b.dir, 'public-site'));
    assert.equal(detectAnchorKind(b.dir, ['public-site']), 'composite');
  });
});

describe('workspace-anchor: составной способ фиксации', () => {
  // Стенд задачи 3.10: корень плюс вложенный git-репозиторий `public-site`.
  //
  // Часть получает начальный коммит: непустой (`HEAD` есть) вложенный
  // репозиторий — это то, что `add -A` корня умеет встроить gitlink-записью;
  // на repo без единого коммита та же команда отказывает («does not have a
  // commit checked out»). Такое дерево встречается — свежий `git init` в
  // части, — и отклоняется предстартовой проверкой состава
  // (`checkWorkspaceAvailability`), а не отказом якоря посреди прогона.
  function compositeBed(): Bed & { initPart(relDir: string): void } {
    const b = bed({ git: true });
    return {
      ...b,
      initPart: (relDir) => {
        const full = join(b.dir, relDir);
        initGitRepo(full);
        writeFileSync(join(full, '.gitkeep'), '');
        commit(full, 'начало части');
      },
    };
  }

  it('правка внутри объявленной части меняет якорь и даёт путь с префиксом', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.write('public-site/src/api.ts', 'один');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['public-site'] });
    const before = anchorer.capture();

    b.write('public-site/src/api.ts', 'два');
    const after = anchorer.capture();

    assert.ok(!sameAnchor(before, after));
    const comparison = anchorer.changedPaths(before, after);
    assert.ok(comparison.comparable);
    assert.deepEqual(comparison.paths, ['public-site/src/api.ts']);
  });

  // Сценарий: правка задевает якорь, даже если корень эту часть игнорирует.
  it('правка в части, игнорируемой корневым репозиторием, меняет якорь', () => {
    const b = compositeBed();
    b.write('.gitignore', 'public-site/\n');
    b.initPart('public-site');
    b.write('public-site/src/api.ts', 'один');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['public-site'] });
    const before = anchorer.capture();

    b.write('public-site/src/api.ts', 'два');
    const after = anchorer.capture();

    assert.ok(!sameAnchor(before, after));
  });

  it('правка в файле, игнорируемом самой частью, якорь не меняет', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.write('public-site/.gitignore', '*.log\n');
    b.write('public-site/src/api.ts', 'один');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['public-site'] });
    const before = anchorer.capture();

    b.write('public-site/debug.log', 'шум');

    assert.ok(sameAnchor(before, anchorer.capture()));
  });

  it('правка в необъявленном вложенном репозитории якорь не меняет', () => {
    const b = compositeBed();
    b.write('.gitignore', 'public-site/\nother-repo/\n');
    b.initPart('public-site');
    initGitRepo(join(b.dir, 'other-repo'));
    b.write('public-site/src/api.ts', 'один');
    b.write('other-repo/file.txt', 'один');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['public-site'] });
    const before = anchorer.capture();

    b.write('other-repo/file.txt', 'два');

    assert.ok(sameAnchor(before, anchorer.capture()));
  });

  it('порядок объявления состава не влияет на идентификатор', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.initPart('vendor-sdk');
    b.write('public-site/index.html', 'a');
    b.write('vendor-sdk/lib.js', 'b');

    const first = createAnchorer({
      dir: b.dir,
      stateDir: b.stateDir,
      scope: 'first',
      nested: ['public-site', 'vendor-sdk'],
    }).capture();
    const second = createAnchorer({
      dir: b.dir,
      stateDir: b.stateDir,
      scope: 'second',
      nested: ['vendor-sdk', 'public-site'],
    }).capture();

    assert.ok(sameAnchor(first, second));
  });

  it('составы разного размера несравнимы с причиной, называющей действующий состав', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.initPart('vendor-sdk');
    b.write('public-site/a.txt', '1');
    b.write('vendor-sdk/b.txt', '1');

    const siteOnly = createAnchorer({ dir: b.dir, stateDir: b.stateDir, scope: 'one', nested: ['public-site'] });
    const both = createAnchorer({
      dir: b.dir,
      stateDir: b.stateDir,
      scope: 'two',
      nested: ['public-site', 'vendor-sdk'],
    });

    const anchorOne = siteOnly.capture();
    const anchorTwo = both.capture();

    const comparison = both.changedPaths(anchorOne, anchorTwo);
    assert.equal(comparison.comparable, false);
    const reason = (comparison as { reason: string }).reason;
    assert.match(reason, /public-site/);
    assert.match(reason, /vendor-sdk/);
  });

  it('составы одного размера, но разного содержания несравнимы с причиной', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.initPart('vendor-sdk');
    b.write('public-site/a.txt', '1');
    b.write('vendor-sdk/b.txt', '1');

    const siteOnly = createAnchorer({ dir: b.dir, stateDir: b.stateDir, scope: 'site', nested: ['public-site'] });
    const sdkOnly = createAnchorer({ dir: b.dir, stateDir: b.stateDir, scope: 'sdk', nested: ['vendor-sdk'] });

    const siteAnchor = siteOnly.capture();
    const sdkAnchor = sdkOnly.capture();

    const comparison = siteOnly.changedPaths(siteAnchor, sdkAnchor);
    assert.equal(comparison.comparable, false);
    assert.match((comparison as { reason: string }).reason, /состав/);
  });

  it('составное состояние и одиночное несравнимы', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.write('public-site/a.txt', '1');

    const composite = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['public-site'] });
    const single = createAnchorer({ dir: b.dir, stateDir: b.stateDir, scope: 'single' });

    const compositeAnchor = composite.capture();
    const singleAnchor = single.capture();

    const comparison = composite.changedPaths(compositeAnchor, singleAnchor);
    assert.equal(comparison.comparable, false);
    assert.match((comparison as { reason: string }).reason, /разными способами/);
  });

  // Обе стороны сравнения сняты чужим составом: между собой их отпечатки
  // совпадают, и различие видно только при сверке с отпечатком сегодняшнего
  // якоря. Без неё oid части чужого состава ушёл бы в `diff-tree` части
  // сегодняшней — исключением из git или молча неверным перечнем путей.
  it('две стороны чужого состава несравнимы, а не сравниваются друг с другом', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.initPart('vendor-sdk');
    b.write('public-site/a.txt', '1');
    b.write('vendor-sdk/b.txt', '1');

    const foreign = createAnchorer({ dir: b.dir, stateDir: b.stateDir, scope: 'sdk', nested: ['vendor-sdk'] });
    const today = createAnchorer({ dir: b.dir, stateDir: b.stateDir, scope: 'site', nested: ['public-site'] });

    const before = foreign.capture();
    b.write('vendor-sdk/b.txt', '2');
    const after = foreign.capture();

    const comparison = today.changedPaths(before, after);
    assert.equal(comparison.comparable, false);
    assert.match((comparison as { reason: string }).reason, /не совпадает с действующим/);
    assert.match((comparison as { reason: string }).reason, /public-site/);
    assert.equal(today.diff(before, after), undefined);
  });

  it('восстановление по якорю чужого состава отказывает, а не лезет в чужую часть', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.initPart('vendor-sdk');
    b.write('public-site/a.txt', '1');
    b.write('vendor-sdk/b.txt', '1');

    const foreign = createAnchorer({ dir: b.dir, stateDir: b.stateDir, scope: 'sdk', nested: ['vendor-sdk'] });
    const today = createAnchorer({ dir: b.dir, stateDir: b.stateDir, scope: 'site', nested: ['public-site'] });
    const foreignAnchor = foreign.capture();

    assert.throws(
      () => today.restorePaths(foreignAnchor, ['public-site/a.txt']),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не совпадает с действующим/);
        return true;
      },
    );
  });

  // Якорь однорепозиторного прогона, попавший в составной якорь (и наоборот):
  // сравнение обязано быть объявленно несравнимым, а не «fatal: bad object».
  it('git-якорь в составном якоре и составной в git-якоре несравнимы без исключения', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.write('public-site/a.txt', '1');

    const composite = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['public-site'] });
    const single = createAnchorer({ dir: b.dir, stateDir: b.stateDir, scope: 'single' });

    const compositeBefore = composite.capture();
    const gitBefore = single.capture();
    b.write('root.txt', '2');
    const compositeAfter = composite.capture();
    const gitAfter = single.capture();

    const inComposite = composite.changedPaths(gitBefore, gitAfter);
    assert.equal(inComposite.comparable, false);
    assert.match((inComposite as { reason: string }).reason, /составной/);
    assert.equal(composite.diff(gitBefore, gitAfter), undefined);

    const inGit = single.changedPaths(compositeBefore, compositeAfter);
    assert.equal(inGit.comparable, false);
    assert.match((inGit as { reason: string }).reason, /composite/);
    assert.equal(single.diff(compositeBefore, compositeAfter), undefined);
  });

  it('diff содержит путь с префиксом при правке части', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.write('public-site/a.txt', 'до\n');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['public-site'] });
    const before = anchorer.capture();

    b.write('public-site/a.txt', 'после\n');
    const after = anchorer.capture();

    const patch = anchorer.diff(before, after);
    assert.ok(patch !== undefined);
    assert.match(patch, /public-site\/a\.txt/);
    assert.match(patch, /\+после/);
    assert.equal(anchorer.diff(before, before), undefined);
  });

  // Сценарий «Изменения корня и части в одном файле»: патч склеивается из
  // патча корня и патчей частей, и оба изменения должны быть в одном файле.
  it('diff склеивает изменение корня и изменение части в один патч', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.write('README.md', 'корень до\n');
    b.write('public-site/a.txt', 'часть до\n');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['public-site'] });
    const before = anchorer.capture();

    b.write('README.md', 'корень после\n');
    b.write('public-site/a.txt', 'часть после\n');
    const after = anchorer.capture();

    const patch = anchorer.diff(before, after);
    assert.ok(patch !== undefined);
    assert.match(patch, /b\/README\.md/);
    assert.match(patch, /\+корень после/);
    assert.match(patch, /b\/public-site\/a\.txt/);
    assert.match(patch, /\+часть после/);
  });

  // Задача 4 (nested-repo-isolation): `restore` перестаёт быть безусловным
  // отказом — приводит и корень, и каждую часть, когда часть на месте.
  it('restore приводит и корень, и часть к сохранённому состоянию', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.write('README.md', 'корень до\n');
    b.write('public-site/a.txt', 'часть до\n');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['public-site'] });
    const saved = anchorer.capture();

    b.write('README.md', 'корень после\n');
    b.write('public-site/a.txt', 'часть после\n');
    anchorer.capture();

    anchorer.restore(saved);

    assert.equal(b.read('README.md'), 'корень до\n');
    assert.equal(b.read('public-site/a.txt'), 'часть до\n');
    assert.ok(sameAnchor(saved, anchorer.capture()), 'состояние должно совпасть с сохранённым');
  });

  // Каталог части снесён мимо якоря (стал обычным каталогом без .git) — та
  // же причина отказа, что у git-якоря на недоступных объектах: объекты
  // части лежат в её собственной базе, которой у такого каталога нет.
  it('restore отказывает, когда часть в приводимом каталоге не является рабочим деревом своего репозитория', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.write('README.md', 'корень\n');
    b.write('public-site/a.txt', '1');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['public-site'] });
    const saved = anchorer.capture();

    b.write('README.md', 'корень изменён\n');
    rmSync(join(b.dir, 'public-site', '.git'), { recursive: true, force: true });

    assert.throws(
      () => anchorer.restore(saved),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /public-site/);
        assert.match(error.message, /не является рабочим деревом/);
        return true;
      },
    );
    // Проверка идёт до первой записи: корень не тронут отказавшей попыткой.
    assert.equal(b.read('README.md'), 'корень изменён\n');
  });

  // Тот же отказ и той же причиной, когда каталога части нет вовсе: пока
  // якорь части заводился при создании составного, этот случай ловил
  // `createGitAnchorer` — сообщением про хеш-манифест, ничего не говорящим о
  // вложенных репозиториях.
  it('restore отказывает названной причиной и когда каталога части нет вовсе', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.write('README.md', 'корень\n');
    b.write('public-site/a.txt', '1');
    const saved = createAnchorer({
      dir: b.dir,
      stateDir: b.stateDir,
      scope: 'снятый',
      nested: ['public-site'],
    }).capture();

    b.write('README.md', 'корень изменён\n');
    rmSync(join(b.dir, 'public-site'), { recursive: true, force: true });

    const anchorer = createAnchorer({
      dir: b.dir,
      stateDir: b.stateDir,
      scope: 'снятый',
      nested: ['public-site'],
    });
    assert.throws(
      () => anchorer.restore(saved),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /public-site/);
        assert.match(error.message, /не является рабочим деревом/);
        assert.match(error.hint ?? '', /собственных базах/);
        return true;
      },
    );
    assert.equal(b.read('README.md'), 'корень изменён\n');
  });

  it('restorePaths восстанавливает файл внутри части', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.write('public-site/a.txt', 'исходное');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['public-site'] });
    const saved = anchorer.capture();

    b.write('public-site/a.txt', 'испорчено');
    anchorer.restorePaths(saved, ['public-site/a.txt']);

    assert.equal(b.read('public-site/a.txt'), 'исходное');
  });

  // Задача 4.4: приведение путей одной части — радиус разрушения не выходит
  // за её границы (design.md, решение 8).
  it('restorePaths по путям одной части оставляет незакоммиченные правки соседней части и корня целыми', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.initPart('vendor-sdk');
    b.write('README.md', 'корень исходное');
    b.write('public-site/a.txt', 'сайт исходное');
    b.write('vendor-sdk/b.txt', 'sdk исходное');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['public-site', 'vendor-sdk'] });
    const saved = anchorer.capture();

    b.write('README.md', 'корень правка пользователя');
    b.write('public-site/a.txt', 'сайт испорчено');
    b.write('vendor-sdk/b.txt', 'sdk правка пользователя');

    anchorer.restorePaths(saved, ['public-site/a.txt']);

    assert.equal(b.read('public-site/a.txt'), 'сайт исходное', 'путь части приведён');
    assert.equal(b.read('README.md'), 'корень правка пользователя', 'правка корня не тронута');
    assert.equal(b.read('vendor-sdk/b.txt'), 'sdk правка пользователя', 'правка соседней части не тронута');
  });

  // Приведение путей только корня не заходит внутрь объявленных частей: их
  // содержимое остаётся тем, что было до вызова.
  it('restorePaths по путям только корня не трогает содержимое частей', () => {
    const b = compositeBed();
    b.initPart('public-site');
    b.write('README.md', 'корень исходное');
    b.write('public-site/a.txt', 'сайт исходное');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['public-site'] });
    const saved = anchorer.capture();

    b.write('README.md', 'корень испорчено');
    b.write('public-site/a.txt', 'сайт правка пользователя');

    anchorer.restorePaths(saved, ['README.md']);

    assert.equal(b.read('README.md'), 'корень исходное', 'корень приведён');
    assert.equal(b.read('public-site/a.txt'), 'сайт правка пользователя', 'содержимое части не тронуто');
  });

  it('вложенные друг в друга объявленные каталоги маршрутизируются по длинному префиксу', () => {
    const b = compositeBed();
    b.initPart('a');
    b.initPart('a/b');
    b.write('a/b/file.txt', 'исходное');
    const anchorer = createAnchorer({ dir: b.dir, stateDir: b.stateDir, nested: ['a', 'a/b'] });
    const saved = anchorer.capture();

    b.write('a/b/file.txt', 'испорчено');
    anchorer.restorePaths(saved, ['a/b/file.txt']);

    assert.equal(b.read('a/b/file.txt'), 'исходное');
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
