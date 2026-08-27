#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Завершение захода петли: проставить `failed` каждому взятому пункту, чей
 * исход ещё не проставлен.
 *
 * Слаги берутся из файлов `item-<дорожка>.json`, записанных `stepcast backlog
 * pick --lanes` в каталог прогона, — по одному на занятую дорожку; дорожка без
 * пункта файла не оставляет и здесь не упоминается. Коммит сведения дорожки
 * — забота `merge-lanes.mjs`: он же и переводит пункт в `done` до коммита.
 * `finalize` эту работу не дублирует и коммитов не создаёт: дерево, отменённое
 * по сигналу или упёршееся в бюджет, коммитить нечем и незачем.
 *
 *   node scripts/finalize.mjs [--file backlog.md] [--run-dir путь]
 */

const DEFAULT_FILE = 'backlog.md';

class FinalizeError extends Error {}

function option(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new FinalizeError(`ключ --${name} требует значения`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Причина отказа пункта дорожки — из итога сведения, если он есть
 * (`merge-<дорожка>.json`, пишет `merge-lanes.mjs`), иначе — из того, что
 * сведение до дорожки, судя по всему, не дошло вовсе (файла нет: `merge`
 * не запускалась, отменена по сигналу или упёрлась в бюджет раньше этой
 * дорожки).
 */
function failureReason(runDir, lane) {
  const path = join(runDir, `merge-${lane}.json`);
  if (!existsSync(path)) {
    return 'сведение до дорожки не дошло: заход остановился раньше или не запускал merge';
  }

  const outcome = readJson(path);
  switch (outcome.status) {
    case 'skipped_verify':
      return `дорожка не сведена: ${outcome.reason ?? 'работа verify не прошла'}`;
    case 'conflict':
      return `дорожка не сведена: наложение не сошлось — ${outcome.reason ?? 'конфликт'}`;
    case 'check_failed':
      return `дорожка не сведена: проверка после сведения красная — ${outcome.reason ?? 'npm run check'}`;
    case 'not_reached':
      return 'сведение до дорожки не дошло: остановилось на более ранней дорожке';
    case 'merged':
      // Дорожка сведена и уже помечена done самим merge-lanes — сюда дойти
      // не должны: см. main().
      return 'дорожка сведена — исход уже проставлен';
    default:
      return `сведение дорожки завершилось неизвестным исходом ${String(outcome.status)}`;
  }
}

function laneOf(itemFile) {
  const match = /^item-(.+)\.json$/.exec(itemFile);
  return match?.[1];
}

function main(argv) {
  const runDir = option(argv, 'run-dir', process.env.STEPCAST_RUN_DIR);
  if (runDir === undefined) {
    throw new FinalizeError('не задан ни --run-dir, ни переменная STEPCAST_RUN_DIR');
  }

  const file = option(argv, 'file', DEFAULT_FILE);
  const stepcastBin = process.env.STEPCAST_BIN ?? 'stepcast';

  const itemFiles = existsSync(runDir)
    ? readdirSync(runDir).filter((name) => /^item-.+\.json$/.test(name))
    : [];

  if (itemFiles.length === 0) {
    process.stdout.write('пункты очереди не брались — проставлять нечего\n');
    return;
  }

  let finalized = 0;

  for (const itemFile of itemFiles) {
    const lane = laneOf(itemFile);
    const { slug } = readJson(join(runDir, itemFile));
    if (typeof slug !== 'string' || slug === '') {
      throw new FinalizeError(`файл ${itemFile} не содержит слага пункта`);
    }

    const mergeOutcomePath = join(runDir, `merge-${lane}.json`);
    if (existsSync(mergeOutcomePath) && readJson(mergeOutcomePath).status === 'merged') {
      // Сведена и уже done — заходить сюда не за чем: finish это же и
      // защищает, но повторный вызов есть повторная работа без надобности.
      continue;
    }

    const reason = failureReason(runDir, lane);
    const result = spawnSync(
      stepcastBin,
      ['backlog', 'finish', slug, '--file', file, '--status', 'failed', '--reason', reason],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.status !== 0) {
      // Отказ бухгалтерии обязан быть виден в логе шага целой фразой — код
      // возврата и stderr, — а не проглочен: молчащая бухгалтерия хуже громкой.
      throw new FinalizeError(
        `backlog finish ${slug} завершилась кодом ${result.status}: ${result.stderr.trim()}`,
      );
    }
    finalized += 1;
    process.stdout.write(`пункт «${slug}» (дорожка ${lane}) помечен failed: ${reason}\n`);
  }

  if (finalized === 0) {
    process.stdout.write('все взятые пункты уже свели свой исход — проставлять нечего\n');
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof FinalizeError) {
    process.stderr.write(`finalize: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
