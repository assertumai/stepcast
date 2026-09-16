import { readFileSync } from 'node:fs';

import { ExitCode, type ExitCodeValue } from '../../../kernel/errors.js';
import { findProjectRoot } from '../../pipeline/run/journal/paths.js';
import { SHARED_MODULE_TABLE_VERSION } from '../daemon/sharedModules.js';
import { listProjectWidgetIds, resolveWidgetFile } from '../widgets.js';
import { parseWidgetImports, unresolvedSharedNames } from '../widgetImports.js';
import { commandRow } from '../../../kernel/cli/commandRow.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';

/**
 * `stepcast widgets [--json]` — состав виджетов проекта: имя, файл, голые
 * спецификаторы и то, какие имена среди них действующая таблица не несёт
 * (`widget-migration`, «Команда печатает состав виджетов проекта и их
 * разрешимость»). Тот же разбор, что видит демон (`src/parts/ui/widgets.ts`,
 * `src/parts/ui/widgetImports.ts`) — расхождение между командой и витриной здесь
 * невозможно, они зовут один и тот же код.
 */

interface UnresolvedNameView {
  /** `specifier` — таблица не несёт самого голого спецификатора; `name` — специфик остался, а имя из него ушло. */
  readonly kind: 'specifier' | 'name';
  readonly specifier: string;
  readonly name: string;
  readonly noteText?: string;
}

interface WidgetSummary {
  readonly id: string;
  readonly file: string;
  readonly imports: readonly string[];
  readonly unresolved: readonly UnresolvedNameView[];
}

function summarize(projectRoot: string): readonly WidgetSummary[] {
  const summaries: WidgetSummary[] = [];
  for (const id of listProjectWidgetIds(projectRoot)) {
    const file = resolveWidgetFile(projectRoot, id);
    if (file === undefined) continue;
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const imports = parseWidgetImports(source);
    const unresolved = unresolvedSharedNames(imports).map(
      (item): UnresolvedNameView => ({
        kind: item.kind,
        specifier: item.specifier,
        name: item.name,
        ...(item.noteText === undefined ? {} : { noteText: item.noteText }),
      }),
    );
    summaries.push({ id, file, imports: imports.map((item) => item.specifier), unresolved });
  }
  return summaries;
}

export function runWidgetsCommand(args: ParsedArgs, write: (line: string) => void, cwd: string): ExitCodeValue {
  const projectRoot = findProjectRoot(cwd);
  const widgets = summarize(projectRoot);
  const payload = { widgets, tableVersion: SHARED_MODULE_TABLE_VERSION };

  if (args.flags.json === true) {
    write(JSON.stringify(payload, null, 2));
    return ExitCode.ok;
  }

  if (widgets.length === 0) {
    write('виджетов нет');
    return ExitCode.ok;
  }

  for (const widget of widgets) {
    const importsLabel = widget.imports.length === 0 ? '—' : widget.imports.join(', ');
    const status =
      widget.unresolved.length === 0
        ? 'ok'
        : `устарел: ${widget.unresolved
            .map((item) => (item.kind === 'specifier' ? item.name : `${item.name} (из ${item.specifier})`))
            .join(', ')}`;
    write(`${widget.id} (${widget.file}) — импорт: ${importsLabel} — ${status}`);
  }
  write(`версия таблицы общих модулей: ${SHARED_MODULE_TABLE_VERSION}`);
  return ExitCode.ok;
}

export const row = commandRow(
  {
    name: 'widgets',
    spec: {
      description: 'печатать состав виджетов проекта: имя, файл, голые импорты и неразрешимые по действующей таблице',
      flags: {
        json: { kind: 'boolean', description: 'печатать тот же состав машинным JSON' },
      },
    },
    run: (args, io, env) => runWidgetsCommand(args, io.out, env.cwd),
  },
);
