import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { z } from 'zod';

import { resolveConfig } from '../../core/config/resolve.js';
import { renderIndex } from '../../core/knowledge/fs.js';
import { createKnowledgeSource } from '../../core/knowledge/source.js';
import { KnowledgeWriteRequestSchema, type KnowledgeSource } from '../../core/knowledge/types.js';
import type { KnowledgeDeclaration } from '../../core/pipeline/model.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../core/errors.js';
import type { ParsedArgs } from '../args.js';

/**
 * `stepcast knowledge index|select|check|write` — тот же контракт источника,
 * что читает сборка контекста, доступный человеку и любому агенту вне
 * пайплайна.
 *
 * Половина ценности памяти лежит именно здесь. `check` встаёт гейтом
 * репозитория в CI или pre-commit и работает без движка-как-оркестратора
 * вовсе; `index` заменяет человеку grep по спекам, отдавая заголовки вместо
 * совпадений.
 *
 * Чего вне прогона нет — надо знать: бюджет контекста не проверяется, состав
 * не фиксируется (`context.json` пишет прогон), а запись не проходит
 * `knowledge_valid`. Поэтому чтение вне пайплайна безопасно, а `write` —
 * работа шага с контрактом либо человека, но не интерактивного агента.
 */

const ACTIONS = ['index', 'select', 'check', 'write'] as const;
type Action = (typeof ACTIONS)[number];

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Перечень через запятую — той же формой, что `backlog pick --lanes a,b`:
 * повторяемых флагов разборщик не заводит, а заводить их ради одной команды
 * значило бы расширить общий язык аргументов ради частного случая.
 */
function listFlag(flags: ParsedArgs['flags'], name: string): readonly string[] | undefined {
  const value = flags[name];
  if (typeof value !== 'string') return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (items.length === 0) {
    throw new StepcastError(`Флаг --${name} не называет ни одного значения`);
  }
  return items;
}

export function runKnowledgeCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): ExitCodeValue {
  const action = args.positional[0] as Action | undefined;
  if (action === undefined || !ACTIONS.includes(action)) {
    throw new StepcastError(`Неизвестная подкоманда knowledge: ${action ?? 'нет'}`, {
      hint: `Допустимы: ${ACTIONS.join(', ')}`,
    });
  }

  const { config } = resolveConfig({ cwd });
  const declaration: KnowledgeDeclaration = {
    provider: config.project.knowledge.provider,
    command: config.project.knowledge.command,
    dir: config.project.knowledge.dir,
    rules: config.project.knowledge.rules,
    indexMaxTokens: config.project.knowledge.indexMaxTokens,
    staleAfterMs: config.project.knowledge.staleAfterMs,
    timeoutMs: config.project.knowledge.timeoutMs,
  };

  const source = createKnowledgeSource({
    knowledge: declaration,
    root: cwd,
    specDir: config.project.spec.dir,
  });

  if (source === undefined) {
    throw new StepcastError('Практика памяти не объявлена', {
      hint: 'Объявите project.knowledge в .stepcast/config.yml или разверните её: stepcast init --knowledge fs',
    });
  }

  const asJson = args.flags.json === true;

  switch (action) {
    case 'index':
      return runIndex(source, asJson, write);
    case 'select':
      return runSelect(source, args, asJson, write, cwd);
    case 'check':
      return runCheck(source, asJson, write);
    case 'write':
      return runWrite(source, args, asJson, write);
  }
}

function runIndex(source: KnowledgeSource, asJson: boolean, write: (line: string) => void): ExitCodeValue {
  const entries = source.index();
  if (asJson) {
    write(JSON.stringify({ entries }, null, 2));
    return ExitCode.ok;
  }
  for (const line of renderIndex(entries).split('\n')) write(line);
  return ExitCode.ok;
}

function runSelect(
  source: KnowledgeSource,
  args: ParsedArgs,
  asJson: boolean,
  write: (line: string) => void,
  cwd: string,
): ExitCodeValue {
  const scope = listFlag(args.flags, 'scope');
  const id = listFlag(args.flags, 'id');

  if ((scope === undefined) === (id === undefined)) {
    throw new StepcastError('Отбор требует ровно одного из --scope и --id', {
      hint: 'stepcast knowledge select --scope "src/**"  ·  stepcast knowledge select --id <id>',
    });
  }

  const entries = source.select(
    scope === undefined ? { kind: 'id', id: id as readonly string[] } : { kind: 'scope', scope },
  );

  if (asJson) {
    write(JSON.stringify({ entries }, null, 2));
    return ExitCode.ok;
  }

  for (const entry of entries) {
    write(`### ${entry.id} — ${entry.title}`);
    write('');
    // Тело читается здесь, а не источником: источник отдаёт ссылку намеренно
    // — её же он отдаёт сборке контекста, чтобы та применила порог вставки, —
    // а человеку у терминала нужно тело. Путь относителен корню репозитория.
    write(entry.text ?? readFileSync(resolvePath(cwd, entry.path as string), 'utf8').trimEnd());
    write('');
  }
  return ExitCode.ok;
}

function runCheck(source: KnowledgeSource, asJson: boolean, write: (line: string) => void): ExitCodeValue {
  const verdict = source.check();

  if (asJson) {
    write(JSON.stringify(verdict, null, 2));
  } else if (verdict.problems.length === 0) {
    write('Память цела.');
  } else {
    for (const problem of verdict.problems) {
      const where = problem.id === undefined ? problem.kind : `${problem.id} (${problem.kind})`;
      write(`${problem.level === 'red' ? 'красное' : 'жёлтое'}  ${where}: ${problem.detail}`);
    }
  }

  // Код возврата отражает исход: команда встаёт гейтом в CI, и гейт, всегда
  // возвращающий ноль, ничем не отличается от отсутствующего.
  return verdict.ok ? ExitCode.ok : ExitCode.jobFailed;
}

function runWrite(
  source: KnowledgeSource,
  args: ParsedArgs,
  asJson: boolean,
  write: (line: string) => void,
): ExitCodeValue {
  const file = stringFlag(args.flags, 'file');
  const fromStdin = args.flags.stdin === true;

  // Отдельный ключ, а не соглашение `--file -`: разборщик аргументов принимает
  // значение, начинающееся с дефиса, только слитной формой (`--file=-`), и
  // командная строка, где `--file -` отказывает, а `--file=-` работает, —
  // ловушка, а не соглашение.
  if (fromStdin === (file !== undefined)) {
    throw new StepcastError('Запись требует ровно одного из --file и --stdin', {
      hint: 'stepcast knowledge write --file unit.json  ·  … --stdin',
    });
  }

  const text = fromStdin ? readFileSync(0, 'utf8') : readFileSync(file as string, 'utf8');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new StepcastError('Описание единицы знания не разбирается как JSON', { cause: error });
  }

  // Список наравне с одиночным описанием: отмена единицы — это две записи
  // разом (новая и та же старая со `status: superseded`), и без списка их
  // пришлось бы звать двумя командами, из которых вторая может не случиться.
  const parsed = z.array(KnowledgeWriteRequestSchema).safeParse(
    Array.isArray(payload) ? payload : [payload],
  );
  if (!parsed.success) {
    throw new StepcastError('Описание единицы знания не соответствует контракту', {
      hint: parsed.error.issues.map((issue) => issue.message).join('; ').slice(0, 400),
    });
  }

  const results = parsed.data.map((request) => ({ request, result: source.write(request) }));
  const ok = results.every((item) => item.result.ok);

  if (asJson) {
    write(JSON.stringify({ ok, entries: results.map((item) => item.result) }, null, 2));
  } else {
    for (const { request, result } of results) {
      if (result.ok) {
        write(`Записано: ${result.path ?? request.id}`);
        continue;
      }
      for (const problem of result.problems) {
        write(`отказ ${request.id}  ${problem.kind}: ${problem.detail}`);
      }
    }
  }

  return ok ? ExitCode.ok : ExitCode.jobFailed;
}
