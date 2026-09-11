import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildWidgets,
  createWidgetCompiler,
  listProjectWidgetIds,
  resolveWidgetFile,
  widgetsDirPath,
  type CompileOutcome,
} from '../src/ui/widgets.js';
import { makeJournalBed, seedRun } from './helpers.js';
import { tempDir } from './tmp.js';

const HOOK_WIDGET = `import { useState } from 'react';

export default function Clock() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
`;

const BROKEN_WIDGET = `export default function Broken() {
  return <div>
}
`;

function widgetsDir(projectRoot: string): string {
  const dir = widgetsDirPath(projectRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function okCode(outcome: CompileOutcome | undefined): string {
  assert.equal(outcome?.kind, 'ok', `компиляция должна была пройти: ${JSON.stringify(outcome)}`);
  return (outcome as { readonly kind: 'ok'; readonly code: string }).code;
}

describe('ui-widgets: перечисление виджетов проекта', () => {
  it('файл верхнего уровня становится виджетом', () => {
    const { projectRoot } = makeJournalBed();
    writeFileSync(join(widgetsDir(projectRoot), 'clock.tsx'), HOOK_WIDGET);

    assert.deepEqual(listProjectWidgetIds(projectRoot), ['clock']);
  });

  it('вложенный файл и чужое расширение не считаются виджетами', () => {
    const { projectRoot } = makeJournalBed();
    const dir = widgetsDir(projectRoot);
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'deep.tsx'), HOOK_WIDGET);
    writeFileSync(join(dir, 'notes.md'), '# заметка\n');

    assert.deepEqual(listProjectWidgetIds(projectRoot), []);
  });

  it('отсутствующий каталог виджетов даёт пустой состав, а не исключение', () => {
    const { projectRoot } = makeJournalBed();
    assert.deepEqual(listProjectWidgetIds(projectRoot), []);
  });

  it('проект без пути в projects.json не входит в обзор виджетов, остальные — входят', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(widgetsDir(projectRoot), 'clock.tsx'), HOOK_WIDGET);

    const other = tempDir('other-project-');
    mkdirSync(join(other, '.stepcast', 'widgets'), { recursive: true });
    writeFileSync(join(other, '.stepcast', 'widgets', 'gauge.tsx'), HOOK_WIDGET);
    seedRun(runsRoot, other, { runId: 'b' });

    // Ломаем указатель так, чтобы у одного проекта путь пропал, а у другого остался.
    const index = JSON.parse(readFileSync(join(runsRoot, 'projects.json'), 'utf8')) as Record<
      string,
      { path?: string }
    >;
    const brokenKey = Object.keys(index).find((key) => index[key]?.path === projectRoot);
    assert.ok(brokenKey !== undefined);
    delete (index[brokenKey as string] as { path?: string }).path;
    writeFileSync(join(runsRoot, 'projects.json'), JSON.stringify(index));

    const overview = buildWidgets(runsRoot);
    assert.equal(overview.projects.some((project) => project.widgets.some((w) => w.id === 'clock')), false);
    assert.equal(overview.projects.some((project) => project.widgets.some((w) => w.id === 'gauge')), true);
  });

  it('проект с известным путём, но без каталога виджетов, — пустой состав, а не ошибка', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });

    const overview = buildWidgets(runsRoot);
    assert.deepEqual(overview.projects[0]?.widgets, []);
  });
});

describe('ui-widgets: разрешение адреса виджета', () => {
  it('существующий файл разрешается в путь на диске', () => {
    const { projectRoot } = makeJournalBed();
    const dir = widgetsDir(projectRoot);
    const file = join(dir, 'clock.tsx');
    writeFileSync(file, HOOK_WIDGET);

    assert.equal(resolveWidgetFile(projectRoot, 'clock'), realpathSync(file));
  });

  it('отсутствующий файл даёт undefined', () => {
    const { projectRoot } = makeJournalBed();
    widgetsDir(projectRoot);
    assert.equal(resolveWidgetFile(projectRoot, 'ghost'), undefined);
  });

  it('идентификатор с шагом вверх по дереву отклонён', () => {
    const { projectRoot } = makeJournalBed();
    widgetsDir(projectRoot);
    assert.equal(resolveWidgetFile(projectRoot, '../secrets'), undefined);
  });

  it('идентификатор с разделителем пути отклонён', () => {
    const { projectRoot } = makeJournalBed();
    const dir = widgetsDir(projectRoot);
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'clock.tsx'), HOOK_WIDGET);
    assert.equal(resolveWidgetFile(projectRoot, 'sub/clock'), undefined);
  });

  it('идентификатор, выглядящий абсолютным путём, отклонён', () => {
    const { projectRoot } = makeJournalBed();
    widgetsDir(projectRoot);
    assert.equal(resolveWidgetFile(projectRoot, '/etc/passwd'), undefined);
  });

  it('символическая ссылка из каталога виджетов наружу отклонена', () => {
    const { projectRoot } = makeJournalBed();
    const dir = widgetsDir(projectRoot);
    const outside = tempDir('outside-');
    const secret = join(outside, 'secret.tsx');
    writeFileSync(secret, 'export default 1;\n');
    symlinkSync(secret, join(dir, 'escape.tsx'));

    assert.equal(resolveWidgetFile(projectRoot, 'escape'), undefined);
  });
});

describe('ui-widgets: компиляция одного файла', () => {
  it('хук и JSX компилируются в ES-модуль с внешними импортами react и экспортом по умолчанию', async () => {
    const { projectRoot } = makeJournalBed();
    const file = join(widgetsDir(projectRoot), 'clock.tsx');
    writeFileSync(file, HOOK_WIDGET);

    const compiler = createWidgetCompiler();
    const code = okCode(await compiler.compile(file));
    await compiler.dispose();

    assert.match(code, /from "react\/jsx-runtime"/);
    assert.match(code, /from "react"/);
    assert.match(code, /Clock as default/);
    assert.doesNotMatch(code, /function useState/, 'тело React не должно попасть в модуль');
  });

  it('файл с синтаксической ошибкой даёт файл, строку, колонку и текст, а не исключение', async () => {
    const { projectRoot } = makeJournalBed();
    const file = join(widgetsDir(projectRoot), 'broken.tsx');
    writeFileSync(file, BROKEN_WIDGET);

    const compiler = createWidgetCompiler();
    const outcome = await compiler.compile(file);
    await compiler.dispose();

    assert.equal(outcome?.kind, 'error');
    const failure = (
      outcome as { readonly kind: 'error'; readonly failure: { file: string; line: number; column: number; text: string } }
    ).failure;
    assert.equal(failure.file, file);
    assert.ok(failure.line > 0, 'строка ошибки должна быть известна');
    assert.equal(typeof failure.column, 'number');
    assert.ok(failure.text.length > 0, 'текст ошибки не должен быть пустым');
  });

  it('исчезнувший между разрешением и компиляцией файл даёт undefined', async () => {
    const { projectRoot } = makeJournalBed();
    const file = join(widgetsDir(projectRoot), 'ghost.tsx');

    const compiler = createWidgetCompiler();
    const outcome = await compiler.compile(file);
    await compiler.dispose();

    assert.equal(outcome, undefined);
  });

  it('компиляция и отдача не пишут в каталог проекта', async () => {
    const { projectRoot } = makeJournalBed();
    const dir = widgetsDir(projectRoot);
    const file = join(dir, 'clock.tsx');
    writeFileSync(file, HOOK_WIDGET);
    const before = readFileSync(file, 'utf8');
    const entriesBefore = readdirSync(projectRoot).sort();

    const compiler = createWidgetCompiler();
    await compiler.compile(file);
    await compiler.dispose();

    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(readdirSync(projectRoot).sort(), entriesBefore);
  });
});

describe('ui-widgets: кеш компиляции', () => {
  it('повторный запрос без правки возвращает ту же запись без повторной компиляции', async () => {
    const { projectRoot } = makeJournalBed();
    const file = join(widgetsDir(projectRoot), 'clock.tsx');
    writeFileSync(file, HOOK_WIDGET);

    const compiler = createWidgetCompiler();
    const first = await compiler.compile(file);
    const second = await compiler.compile(file);
    await compiler.dispose();

    assert.equal(first, second, 'без правки файла кеш обязан вернуть тот же объект результата');
  });

  it('правка файла обесценивает запись кеша', async () => {
    const { projectRoot } = makeJournalBed();
    const file = join(widgetsDir(projectRoot), 'clock.tsx');
    writeFileSync(file, HOOK_WIDGET);

    const compiler = createWidgetCompiler();
    const first = await compiler.compile(file);

    writeFileSync(file, HOOK_WIDGET.replace('Clock', 'ClockV2'));
    // mtime может не сдвинуться в пределах той же секунды — двигаем отпечаток явно.
    const bumped = new Date(Date.now() + 5_000);
    utimesSync(file, bumped, bumped);

    const second = await compiler.compile(file);
    await compiler.dispose();

    assert.notEqual(first, second);
    assert.match(okCode(second), /ClockV2/);
  });

  it('кеш ограничен числом записей и вытесняет давние', async () => {
    const { projectRoot } = makeJournalBed();
    const dir = widgetsDir(projectRoot);
    const files = ['a', 'b', 'c'].map((id) => {
      const file = join(dir, `${id}.tsx`);
      writeFileSync(file, `export default function ${id.toUpperCase()}() { return null; }\n`);
      return file;
    });

    const compiler = createWidgetCompiler({ maxCacheEntries: 2 });
    const firstA = await compiler.compile(files[0] as string);
    await compiler.compile(files[1] as string);
    await compiler.compile(files[2] as string); // третья запись выталкивает первую при пределе в две
    const againA = await compiler.compile(files[0] as string);
    await compiler.dispose();

    assert.notEqual(firstA, againA, 'запись первого файла должна была быть вытеснена и пересчитана заново');
  });

  it('без переполнения кеша запись не пересчитывается', async () => {
    const { projectRoot } = makeJournalBed();
    const dir = widgetsDir(projectRoot);
    const files = ['a', 'b'].map((id) => {
      const file = join(dir, `${id}.tsx`);
      writeFileSync(file, `export default function ${id.toUpperCase()}() { return null; }\n`);
      return file;
    });

    const compiler = createWidgetCompiler({ maxCacheEntries: 10 });
    const firstA = await compiler.compile(files[0] as string);
    await compiler.compile(files[1] as string);
    const againA = await compiler.compile(files[0] as string);
    await compiler.dispose();

    assert.equal(firstA, againA);
  });

  it('два компилятора в одном процессе не делят кеш', async () => {
    const { projectRoot: rootA } = makeJournalBed();
    const { projectRoot: rootB } = makeJournalBed();
    const fileA = join(widgetsDir(rootA), 'clock.tsx');
    const fileB = join(widgetsDir(rootB), 'clock.tsx');
    writeFileSync(fileA, HOOK_WIDGET);
    writeFileSync(fileB, HOOK_WIDGET.replace('Clock', 'ClockB'));

    const compilerA = createWidgetCompiler();
    const compilerB = createWidgetCompiler();

    assert.match(okCode(await compilerA.compile(fileA)), /Clock as default/);
    assert.match(okCode(await compilerB.compile(fileB)), /ClockB as default/);

    await compilerA.dispose();
    await compilerB.dispose();
  });
});

describe('ui-widgets: отказ подъёма компилятора', () => {
  /** Тот же отказ, что даёт `import('esbuild')` без пакета или без его платформенного бинарника. */
  function failingLoad(): Promise<never> {
    return Promise.reject(new Error("Cannot find package 'esbuild'"));
  }

  it('отсутствующая зависимость — названная ошибка в ответе и строка в логе, а не исключение наружу', async () => {
    const { projectRoot } = makeJournalBed();
    const file = join(widgetsDir(projectRoot), 'clock.tsx');
    writeFileSync(file, HOOK_WIDGET);

    const lines: string[] = [];
    const compiler = createWidgetCompiler({ log: (line) => lines.push(line), loadCompiler: failingLoad });
    const outcome = await compiler.compile(file);
    await compiler.dispose();

    assert.equal(outcome?.kind, 'error');
    const failure = (outcome as { readonly kind: 'error'; readonly failure: { text: string; file: string } })
      .failure;
    assert.match(failure.text, /esbuild/, 'ответ обязан называть отсутствующую зависимость');
    assert.equal(failure.file, file);
    assert.equal(lines.length, 1, `в лог демона обязана уйти строка об отказе: ${JSON.stringify(lines)}`);
    assert.match(lines[0] as string, /esbuild/);
  });

  it('второй запрос не плодит строк в логе — подъём пробуется один раз', async () => {
    const { projectRoot } = makeJournalBed();
    const dir = widgetsDir(projectRoot);
    const first = join(dir, 'a.tsx');
    const second = join(dir, 'b.tsx');
    writeFileSync(first, HOOK_WIDGET);
    writeFileSync(second, HOOK_WIDGET);

    const lines: string[] = [];
    let loads = 0;
    const compiler = createWidgetCompiler({
      log: (line) => lines.push(line),
      loadCompiler: () => {
        loads += 1;
        return failingLoad();
      },
    });
    await compiler.compile(first);
    await compiler.compile(second);
    await compiler.dispose();

    assert.equal(loads, 1, 'отказавший подъём не пробуется заново на каждый запрос');
    assert.equal(lines.length, 1);
  });
});
