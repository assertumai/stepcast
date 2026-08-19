#!/usr/bin/env node
// Проверка приёмочного прогона `examples/acceptance/stepcast.yml`.
//
//   node examples/acceptance/verify.mjs <каталог-прогона>
//
// Каталог печатает сам `stepcast run` строкой «журнал: …». Скрипт читает журнал и
// сверяет то, что заявлено спекой `job-iteration`: число итераций, их предел,
// сброс сессий и попыток, раскладку с уровнем `iter-N` и её отсутствие у
// работы без цикла. Проверка объективна: глазами такое не сверяют.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (dir === undefined) {
  console.error('нужен каталог прогона: node examples/acceptance/verify.mjs <каталог>');
  process.exit(2);
}

const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
const events = readFileSync(join(dir, 'events.ndjson'), 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line));

const failures = [];
const check = (ok, what, detail = '') => {
  if (ok) console.log(`  ✔ ${what}`);
  else {
    console.log(`  ✖ ${what}${detail === '' ? '' : ` — ${detail}`}`);
    failures.push(what);
  }
};

const jobOf = (id) => status.jobs.find((job) => job.id === id);
const stepsDir = (id) => join(dir, 'jobs', id, 'steps');
const stepJson = (job, iteration, name) =>
  JSON.parse(
    readFileSync(
      join(stepsDir(job), iteration === undefined ? '' : `iter-${iteration}`, name, 'step.json'),
      'utf8',
    ),
  );

console.log('прогон целиком');
check(status.status === 'success', 'завершился успехом', status.status);

console.log('итерации');
const loop = jobOf('цикл');
check(loop?.iterations === 2, 'выполнено ровно две итерации', `получено ${loop?.iterations}`);
check(
  existsSync(join(stepsDir('цикл'), 'iter-1')) && existsSync(join(stepsDir('цикл'), 'iter-2')),
  'каталоги iter-1 и iter-2 созданы',
);
check(
  !existsSync(join(stepsDir('цикл'), 'iter-3')),
  'третья итерация не начиналась: условие выполнилось на второй',
);

console.log('раскладка работы без цикла');
check(
  existsSync(join(stepsDir('без-цикла'), '01-один-раз')),
  'шаги лежат без уровня итерации',
);
check(
  !readdirSync(stepsDir('без-цикла')).some((name) => name.startsWith('iter-')),
  'уровень iter-N не появился',
);

console.log('сессии и попытки');
const first = stepJson('цикл', 1, '01-отмечается');
const second = stepJson('цикл', 2, '01-отмечается');
check(
  first.session !== undefined && first.session !== second.session,
  'на новой итерации сессия начата заново',
  `${first.session} и ${second.session}`,
);
check(
  second.attempts[0]?.attempt === 1,
  'счёт попыток на второй итерации начат с первой',
);

console.log('якорь состояния дерева');
check(first.tree_id !== undefined && second.tree_id !== undefined, 'tree_id записан у обеих итераций');
check(first.tree_id !== second.tree_id, 'итерации оставили дерево в разных состояниях');

console.log('события');
const started = events.filter((event) => event.kind === 'iteration.started');
const finished = events.filter((event) => event.kind === 'iteration.finished');
check(started.length === 2, 'два события начала итерации', `получено ${started.length}`);
check(
  JSON.stringify(finished.map((event) => event.passed)) === JSON.stringify([false, true]),
  'первая проверка не прошла, вторая прошла',
  JSON.stringify(finished.map((event) => event.passed)),
);

console.log('');
if (failures.length === 0) {
  console.log('приёмка пройдена');
  process.exit(0);
}
console.log(`приёмка не пройдена: ${failures.length} проверок`);
process.exit(1);
