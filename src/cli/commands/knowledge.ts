import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { z } from 'zod';

import { resolveConfig } from '../../core/config/resolve.js';
import { renderIndex } from '../../core/knowledge/fs.js';
import { createKnowledgeSource } from '../../core/knowledge/source.js';
import { KnowledgeWriteRequestSchema, type KnowledgeSource } from '../../core/knowledge/types.js';
import { mergeJobData } from '../../core/journal/data.js';
import type { KnowledgeDeclaration } from '../../core/pipeline/model.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../core/errors.js';
import { commandRow, PIPELINE_SERVICES } from '../commandRow.js';
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
  env: Readonly<Record<string, string | undefined>> = process.env,
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
    specIndexMaxTokens: config.project.knowledge.specIndexMaxTokens,
    unitMaxTokens: config.project.knowledge.unitMaxTokens,
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
      return runCheck(source, asJson, write, args, env);
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

function runCheck(
  source: KnowledgeSource,
  asJson: boolean,
  write: (line: string) => void,
  args: ParsedArgs,
  env: Readonly<Record<string, string | undefined>>,
): ExitCodeValue {
  // Отказ до вызова check: --publish вне шага прогона не имеет куда писать, и
  // это стоит сказать раньше, чем проверка вообще начнётся.
  const publishKey = stringFlag(args.flags, 'publish');
  const jobDir = env.STEPCAST_JOB_DIR;
  if (publishKey !== undefined && (jobDir === undefined || jobDir.trim() === '')) {
    throw new StepcastError('Флаг --publish работает только внутри шага прогона', {
      hint: 'Целевая работа берётся из переменной STEPCAST_JOB_DIR, которую движок инжектирует в каждый шаг; вне прогона публиковать некуда',
    });
  }

  // Один вызов, а не проверка с записью и проверка следом: для источника `fs`
  // второй вызов заново читал бы историю git по каждому якорю, для `cmd` —
  // заново запускал бы внешнюю команду. Что именно записано, ответ называет
  // сам полем `recorded` — датирование по-прежнему не влияет на исход этого же
  // вызова (design.md, решение 3), и напечатанные нарушения посчитаны на
  // дереве до правки.
  const record = args.flags.record === true;
  const verdict = source.check(record ? { record: true } : undefined);

  if (asJson) {
    write(JSON.stringify(verdict, null, 2));
  } else {
    // Правка рабочего дерева печатается всегда, даже когда её не случилось:
    // молчаливо поправленное дерево — худший сорт вывода, а «датировать было
    // нечего» отличает исправную память от неработающего ключа.
    if (record) {
      for (const item of verdict.recorded?.dated ?? []) {
        write(`датировано  ${item.id}: ${item.path} — известно с ${item.since}`);
      }
      for (const item of verdict.recorded?.cleared ?? []) {
        write(`снято  ${item.id}: ${item.path} — расхождения больше нет`);
      }
      if ((verdict.recorded?.dated.length ?? 0) + (verdict.recorded?.cleared.length ?? 0) === 0) {
        write('Датировать нечего: дерево не изменено.');
      }
    }

    if (verdict.problems.length === 0) {
      write('Память цела.');
    } else {
      for (const problem of verdict.problems) {
        const where = problem.id === undefined ? problem.kind : `${problem.id} (${problem.kind})`;
        write(`${problem.level === 'red' ? 'красное' : 'жёлтое'}  ${where}: ${problem.detail}`);
      }
    }
  }

  if (publishKey !== undefined) {
    const overflowing = verdict.problems.some((problem) => problem.kind === 'index-overflow');
    // Необъявленный ключ отказывает саму команду (`mergeJobData` бросает) — в
    // отличие от `backlog pick`, здесь публикация не сопутствует уже
    // состоявшемуся эффекту: назвать флаг и тихо не сделать названного значило
    // бы оставить переполнение неразрешённым при зелёном заходе.
    mergeJobData(jobDir as string, { [publishKey]: overflowing ? 'true' : 'false' });
  }

  // Код возврата отражает исход: команда встаёт гейтом в CI, и гейт, всегда
  // возвращающий ноль, ничем не отличается от отсутствующего. Публикация на
  // него не влияет.
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

  // Список наравне с одиночным описанием: слияние освобождает место группами,
  // и одной группы хватает не всегда — без списка вторую пришлось бы звать
  // второй командой, из которых вторая может не случиться. Отмена в список не
  // входит: она — поле `supersedes` того же описания, и записывается вместе с
  // ним одной транзакцией. Каждое описание списка — своя транзакция: они
  // независимы, и общий откат по ним склеил бы несвязанные слияния.
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

export const row = commandRow(
  {
    name: 'knowledge',
    spec: {
      description: 'читать и проверять память репозитория: index|select|check|write, см. docs/knowledge.md',
      positional: ['action'],
      flags: {
        scope: { kind: 'string', description: 'select: области через запятую — src/**,test/**' },
        id: { kind: 'string', description: 'select: идентификаторы через запятую' },
        file: { kind: 'string', description: 'write: файл с описанием единицы знания' },
        stdin: { kind: 'boolean', description: 'write: читать описание со стандартного ввода' },
        json: { kind: 'boolean', description: 'вывести ответ источника как есть, машинным JSON' },
        publish: {
          kind: 'string',
          description:
            'check: опубликовать данными работы ключом true/false — есть ли среди нарушений index-overflow; только внутри шага прогона',
        },
        record: {
          kind: 'boolean',
          description:
            'check: датировать обнаруженные расхождения по якорям — без этого ключа check дерева не правит',
        },
      },
    },
    run: (args, io, env) => runKnowledgeCommand(args, io.out, env.cwd),
  },
  { inject: PIPELINE_SERVICES },
);
