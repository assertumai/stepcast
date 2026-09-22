import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  builtinWidgetsDir,
  createWidgetCompiler,
  installBuiltinWidget,
  listBuiltinWidgets,
  resolveBuiltinWidgetFile,
  widgetDescription,
  widgetsDirPath,
} from '../src/parts/ui/widgets.js';
import { tempDir } from './tmp.js';

/**
 * Каталог виджетов поставки (`ui-overhaul`): образцы лежат в
 * `src/builtin/widgets/`, перечисляются с описанием из ведущего комментария,
 * компилируются тем же компилятором, что и виджеты проекта, и копируются в
 * проект без перезаписи того, что там уже есть.
 */

describe('ui-widgets: каталог поставки', () => {
  it('описание — первый абзац ведущего блочного комментария, без звёздочек', () => {
    const source = `import x from 'y';\n\n/**\n * A ticking clock with a\n * pause button.\n *\n * Второй абзац не входит.\n */\nexport default function C() {}\n`;
    assert.equal(widgetDescription(source), 'A ticking clock with a pause button.');
    assert.equal(widgetDescription('export default function C() {}'), '');
  });

  it('поставка несёт хотя бы clock, projects, active-runs и usage-today, каждый с описанием и версией', () => {
    const ids = listBuiltinWidgets().map((widget) => widget.id);
    for (const expected of ['active-runs', 'clock', 'projects', 'usage-today']) assert.ok(ids.includes(expected), ids.join(', '));
    for (const widget of listBuiltinWidgets()) {
      assert.notEqual(widget.description, '', `${widget.id}: описание пусто`);
      assert.match(widget.version, /^\d+(\.\d+)?:\d+$/);
    }
  });

  it('каждый виджет поставки компилируется настоящим компилятором и импортирует только общие модули', async () => {
    const compiler = createWidgetCompiler({ log: () => {} });
    try {
      for (const widget of listBuiltinWidgets()) {
        const file = resolveBuiltinWidgetFile(widget.id);
        assert.ok(file !== undefined, widget.id);
        const outcome = await compiler.compile(file);
        assert.equal(outcome?.kind, 'ok', `${widget.id}: ${JSON.stringify(outcome)}`);
        const code = (outcome as { readonly code: string }).code;
        const specifiers = [...code.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
        for (const specifier of specifiers) {
          assert.ok(['react', 'react/jsx-runtime', '@stepcast/ui', '@stepcast/slots'].includes(specifier as string), `${widget.id}: ${specifier}`);
        }
      }
    } finally {
      await compiler.dispose();
    }
  });

  it('небезопасный или неизвестный идентификатор не разрешается в файл', () => {
    assert.equal(resolveBuiltinWidgetFile('../clock'), undefined);
    assert.equal(resolveBuiltinWidgetFile('no-such-widget'), undefined);
    assert.ok(existsSync(builtinWidgetsDir()));
  });

  it('установка копирует файл в .stepcast/widgets проекта, повтор — отказ без перезаписи, неизвестный — unknown', () => {
    const projectRoot = tempDir('widget-install-');
    mkdirSync(projectRoot, { recursive: true });

    const first = installBuiltinWidget(projectRoot, 'clock');
    assert.equal(first.status, 'installed');
    const target = join(widgetsDirPath(projectRoot), 'clock.tsx');
    assert.ok(existsSync(target));
    assert.equal(readFileSync(target, 'utf8'), readFileSync(resolveBuiltinWidgetFile('clock') as string, 'utf8'));

    writeFileSync(target, '// edited by hand\n');
    const second = installBuiltinWidget(projectRoot, 'clock');
    assert.equal(second.status, 'exists');
    assert.equal(readFileSync(target, 'utf8'), '// edited by hand\n');

    assert.deepEqual(installBuiltinWidget(projectRoot, 'no-such-widget'), { status: 'unknown' });
  });
});
