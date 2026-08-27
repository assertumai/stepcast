#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Сведение дорожек петли: наложить каждую дорожку на дерево проекта,
 * проверить объединённое дерево и закоммитить её, только если проверка
 * зелёная.
 *
 * Дорожки обходятся в объявленном порядке. Дорожка с неуспешной `verify`
 * пропускается — не сведена, но и не мешает следующей. Конфликт наложения
 * или красная проверка после наложения останавливают сведение целиком:
 * дальнейшие дорожки не трогаются, а причина называет дорожку и путь к её
 * рабочему дереву — их разбор идёт по status.json того же прогона, что и
 * `stepcast backlog pick --lanes`.
 *
 *   node scripts/merge-lanes.mjs --lanes a,b [--file backlog.md] [--run <run-id>]
 */

class MergeError extends Error {}

function option(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new MergeError(`ключ --${name} требует значения`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runOrThrow(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.code !== 0) {
    throw new MergeError(`${command} ${args.join(' ')} завершилась кодом ${result.code}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function readStatus(runDir) {
  const path = join(runDir, 'status.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Работа verify дорожки. Имя работы в пайплайне несёт суффикс дорожки
 * (`verify-a`, `verify-b`) — поля `lane` для поиска мало: сравнение с голым
 * `verify` не совпадает ни с одной работой и молча теряет зелёную дорожку.
 */
function verifyJobOf(status, lane) {
  return status.jobs.find((job) => job.lane === lane && job.id === `verify-${lane}`);
}

function readItem(runDir, lane) {
  const path = join(runDir, `item-${lane}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Итог сведения одной дорожки — читает `scripts/finalize.mjs`, чтобы
 * различить причины отказа, не передоказывая их заново по git-логу и
 * status.json. Пишется на каждую дорожку из перечня, включая те, до которых
 * сведение не дошло из-за остановки на более ранней.
 */
function writeMergeOutcome(runDir, lane, status, reason) {
  writeFileSync(join(runDir, `merge-${lane}.json`), `${JSON.stringify({ status, reason }, null, 2)}\n`);
}

function main(argv) {
  const lanesOption = option(argv, 'lanes', undefined);
  if (lanesOption === undefined) throw new MergeError('ключ --lanes обязателен');
  const lanes = lanesOption.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (lanes.length === 0) throw new MergeError('ключ --lanes требует непустого перечня имён через запятую');

  const runId = option(argv, 'run', process.env.STEPCAST_RUN_ID);
  if (runId === undefined) throw new MergeError('не задан ни --run, ни переменная STEPCAST_RUN_ID');

  const runDir = process.env.STEPCAST_RUN_DIR;
  if (runDir === undefined) throw new MergeError('переменная STEPCAST_RUN_DIR не задана');

  const stepcastBin = process.env.STEPCAST_BIN;
  if (stepcastBin === undefined) throw new MergeError('переменная STEPCAST_BIN не задана');

  const file = option(argv, 'file', 'backlog.md');

  const merged = [];
  const skipped = [];

  for (const [index, lane] of lanes.entries()) {
    const status = readStatus(runDir);
    const verify = verifyJobOf(status, lane);

    if (verify === undefined || verify.status !== 'success') {
      const reason =
        verify === undefined
          ? `у дорожки ${lane} нет работы verify`
          : `у дорожки ${lane} работа verify завершилась статусом ${verify.status}`;
      skipped.push({ lane, reason });
      writeMergeOutcome(runDir, lane, 'skipped_verify', reason);
      process.stdout.write(`дорожка ${lane}: пропущена — ${reason}\n`);
      continue;
    }

    const applied = run(stepcastBin, ['apply', '--lane', lane, runId]);
    if (applied.code !== 0) {
      const reason = `наложение не сошлось с текущим деревом (рабочее дерево: ${verify.workspace?.path ?? 'неизвестно'}): ${applied.stderr.trim()}`;
      writeMergeOutcome(runDir, lane, 'conflict', reason);
      markUnreached(runDir, lanes.slice(index + 1));
      throw new MergeError(`дорожка ${lane}: ${reason}`);
    }

    const checked = run('npm', ['run', 'check']);
    if (checked.code !== 0) {
      // Проверка красная на уже наложенном дереве: откат к последнему
      // коммиту — иначе следующий заход унаследует сломанное дерево, а
      // history получит дорожку, которую никто не подтвердил зелёной.
      // `clean -fd` снимает и файлы, которых до наложения не было вовсе:
      // `reset --hard` их не трогает — они не отслежены git.
      run('git', ['reset', '--hard', 'HEAD']);
      run('git', ['clean', '-fd']);
      const reason = `проверка после наложения не прошла (рабочее дерево: ${verify.workspace?.path ?? 'неизвестно'}): ${checked.stderr.trim() || checked.stdout.trim()}`;
      writeMergeOutcome(runDir, lane, 'check_failed', reason);
      markUnreached(runDir, lanes.slice(index + 1));
      throw new MergeError(`дорожка ${lane}: ${reason}`);
    }

    const item = readItem(runDir, lane);
    if (item === undefined || typeof item.slug !== 'string' || item.slug === '') {
      throw new MergeError(`дорожка ${lane}: файл item-${lane}.json не содержит слага пункта`);
    }

    // Отметка исхода идёт до коммита — улучшение и его бухгалтерия остаются
    // одним событием, которое `git revert` снимает вместе.
    runOrThrow(stepcastBin, ['backlog', 'finish', item.slug, '--file', file, '--status', 'done']);
    runOrThrow('git', ['add', '-A']);
    runOrThrow('git', ['commit', '-m', `${item.slug}: ${item.title ?? 'улучшение из очереди'}`]);

    writeMergeOutcome(runDir, lane, 'merged', undefined);
    merged.push(lane);
    process.stdout.write(`дорожка ${lane}: сведена, пункт «${item.slug}» помечен done\n`);
  }

  process.stdout.write(
    `итог: сведено ${merged.length}, пропущено ${skipped.length}${skipped.length === 0 ? '' : ` (${skipped.map((entry) => entry.lane).join(', ')})`}\n`,
  );
}

/** Дорожки, до которых сведение не дошло из-за остановки на более ранней. */
function markUnreached(runDir, lanes) {
  for (const lane of lanes) {
    writeMergeOutcome(runDir, lane, 'not_reached', 'сведение остановилось на более ранней дорожке');
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof MergeError) {
    process.stderr.write(`merge-lanes: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
