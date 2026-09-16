import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CliIo } from '../src/kernel/cli/args.js';
import { run as runCli } from '../src/parts/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/kernel/errors.js';
import { makeProject, withHome, type Project } from './helpers.js';

/**
 * Эталон дословного текста справки и кодов возврата, снятый с нынешнего
 * вывода до переезда команд в строки дерева (`cli-commands-as-rows`). Этот
 * тест после переезда не правится — его совпадение и есть приёмка задач 6 и
 * 8 (`openspec/changes/cli-commands-as-rows/tasks.md`).
 */

interface Outcome {
  readonly code: ExitCodeValue;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(project: Project, argv: readonly string[]): Promise<Outcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    cwd: project.root,
  };
  const code = await withHome(project.home, () => runCli(argv, io));
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

const HELP_TEXT = `ошибка: Не указана команда
    stepcast run <pipeline> — выполнить пайплайн
      --input — значение входа пайплайна: --input имя=значение
      --dry-run — только проверить, не запуская работы
      --quiet — не печатать ход прогона
  stepcast resume <run> — возобновить прогон, переиспользовав шаги с совпавшим ключом
      --from — начать заново с работы или шага: --from job[/step]
      --set — переопределить вход: --set имя=значение
      --dry-run — показать план, ничего не исполняя
  stepcast diff <run-a> <run-b> — сравнить два прогона по ключам шагов, промптам, контексту и деревьям
  stepcast decide <run> <outcome> — принять решение по ожиданию прогона: stepcast decide <run> <исход>
      --step — адрес ожидающего шага (job или job/step) — обязателен при нескольких ожиданиях
      --reason — причина отклонения — обязательна для исхода с эффектом reject
      --from — точка перезапуска job[/step] — обязательна для исхода с эффектом restart
  stepcast propose <target> — предложить правку файла кабинета проекта: stepcast propose <цель> --from <файл> — единственный писатель очереди
      --from — файл с содержимым предложения — без него читается стандартный ввод
      --reason — причина предложения, необязательна
  stepcast widgets — печатать состав виджетов проекта: имя, файл, голые импорты и неразрешимые по действующей таблице
      --json — печатать тот же состав машинным JSON
  stepcast apply <run> — наложить результат изолированного прогона на текущее дерево
      --job — наложить только результат этой работы
      --lane — наложить только результат этой дорожки, одним диффом
      --force — снять отказ в повторном наложении дорожки, чей записанный исход — «сведена»
  stepcast lint <pipeline> — статически проверить пайплайн, ничего не запуская
      --input — значение входа пайплайна: --input имя=значение
  stepcast status — показать состояние прогона
      --run — идентификатор прогона, по умолчанию последний
      --explain — объяснить по каждому шагу, будет ли он переиспользован при возобновлении
  stepcast logs <run> <job/step> — показать логи прогона или шага
      --follow — продолжать показывать вывод по мере записи
  stepcast config — показать действующую конфигурацию и происхождение каждого значения
      --model — переопределить модель по умолчанию
      --agent — переопределить бэкенд по умолчанию
  stepcast schema — записать в .stepcast/schema/ JSON Schema документов проекта, знающую предикаты загруженных плагинов
      --out — каталог вывода вместо .stepcast/schema/
  stepcast plugins — печатать осмотр дерева плагинов: место, id, слой, модуль, состояние, сервисы и вклады
      --dump — то же самое — флаг ради совместимости, поведение команды от него не зависит
      --json — печатать ту же модель осмотра машинным JSON, без единой строки сверх
  stepcast gc — уборка: две отдельные цели — файлы прогонов (умолчание) и записи хранилища расхода (--stats); без ключей только отчёт
      --older-than — удалить прогоны (или, вместе с --stats, записи) старше этой длительности, например 30d
      --stats — снять записи хранилища расхода вместо файлов прогонов; --failed и --project действуют только с ним
      --failed — отбирать отказавшие прогоны — только вместе с --stats
      --project — ограничить отбор ключом проекта — только вместе с --stats
  stepcast init — создать stepcast.yml и пример работы в текущем каталоге
      --force — перезаписать существующий stepcast.yml
      --knowledge — развернуть практику памяти вместо пайплайна: fs — встроенный источник
  stepcast context <pipeline> — показать состав и размер контекста шага без запуска пайплайна
      --job — работа, для которой считается контекст
      --step — шаг, для которого считается контекст
      --input — значение входа пайплайна: --input имя=значение
  stepcast up — поднять витрину: наблюдение за всеми прогонами в браузере
      --foreground — держать сервер в текущем терминале, не отсоединяя его
  stepcast down — остановить витрину
  stepcast usage <run> — показать расход прогона по работам, шагам и попыткам
  stepcast backlog <action> <slug> — вести очередь улучшений backlog.md: list|pick|finish|settle, см. docs/backlog.md
      --file — путь к файлу очереди, по умолчанию backlog.md в рабочем каталоге
      --slots — pick: сколько пунктов взять за раз, по умолчанию 1
      --lanes — pick: раздать по дорожкам, имена через запятую — a,b
      --only — pick: взять именно этот пункт по слагу, а не первый свободный по очерёдности
      --stale-hours — pick: порог давности зависшего in_progress в часах, по умолчанию 6
      --run-dir — pick --lanes: каталог для файлов item-<дорожка>.json на каждую заполненную дорожку; settle: тот же каталог, обязателен
      --status — finish: исход done либо failed
      --reason — finish --status failed: причина отказа
  stepcast knowledge <action> — читать и проверять память репозитория: index|select|check|write, см. docs/knowledge.md
      --scope — select: области через запятую — src/**,test/**
      --id — select: идентификаторы через запятую
      --file — write: файл с описанием единицы знания
      --stdin — write: читать описание со стандартного ввода
      --json — вывести ответ источника как есть, машинным JSON
      --publish — check: опубликовать данными работы ключом true/false — есть ли среди нарушений index-overflow; только внутри шага прогона
      --record — check: датировать обнаруженные расхождения по якорям — без этого ключа check дерева не правит
  stepcast data <action> <key> <value> — опубликовать данные работы, видимые в витрине и подстановкой \${jobs.<работа>.data.<ключ>}: set|merge|get
      --json — merge: объект вида {"ключ": "значение"}, дописываемый поверх опубликованного
  stepcast merge-lanes <run> — свести названные дорожки прогона в дерево запуска: наложить, проверить, закоммитить зелёную
      --lanes — перечень дорожек через запятую, обязателен
      --check — команда проверки объединённого дерева, обязателен
      --file — путь к файлу очереди, по умолчанию backlog.md в рабочем каталоге
  stepcast assert-clean — проверить чистоту каталога запуска и объявленных вложенных репозиториев (project.nested_repos), ничего не правя
      --allow — пути, правки которых чистоту не нарушают, через запятую
  stepcast project <action> — repos: дополнить документ дорожек (backlog pick --lanes) объявлениями репозиториев конфигурации
      --file — repos: файл с документом дорожек вместо стандартного ввода`;

describe('cli-help-baseline: эталон справки и кодов возврата до переезда команд в строки', () => {
  it('stepcast без аргументов печатает справку дословно и отказывает кодом ошибки конфигурации', async () => {
    const outcome = await cli(makeProject({}), []);
    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
    assert.equal(outcome.stderr, HELP_TEXT);
  });

  it('stepcast --help печатает ту же справку дословно, тем же кодом возврата', async () => {
    const outcome = await cli(makeProject({}), ['--help']);
    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
    assert.equal(outcome.stderr, HELP_TEXT);
  });

  it('неизвестная команда: код возврата — ошибка конфигурации, справка приложена', async () => {
    const outcome = await cli(makeProject({}), ['frobnicate']);
    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
    assert.equal(outcome.stderr, HELP_TEXT.replace('Не указана команда', 'Неизвестная команда: frobnicate'));
  });

  it('неизвестный флаг команды: код возврата — ошибка конфигурации, справка сужена до одной команды', async () => {
    const outcome = await cli(makeProject({}), ['run', '--bogus', 'x']);
    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
    assert.equal(
      outcome.stderr,
      'ошибка: Неизвестный флаг --bogus у команды run\n' +
        '    stepcast run <pipeline> — выполнить пайплайн\n' +
        '      --input — значение входа пайплайна: --input имя=значение\n' +
        '      --dry-run — только проверить, не запуская работы\n' +
        '      --quiet — не печатать ход прогона',
    );
  });

  it('лишний позиционный аргумент: код возврата — ошибка конфигурации, названо ожидаемое число аргументов', async () => {
    const outcome = await cli(makeProject({}), ['down', 'extra']);
    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
    assert.equal(
      outcome.stderr,
      'ошибка: Команда down принимает не больше 0 позиционных аргументов, получено 1\n' +
        '    stepcast down — остановить витрину',
    );
  });

  it('отказ команды (файл пайплайна не найден): код возврата — ошибка конфигурации, названо место', async () => {
    const project = makeProject({});
    const outcome = await cli(project, ['run', 'nonexistent.yml']);
    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
    assert.match(outcome.stderr, /^ошибка: Файл не найден: /);
    assert.match(outcome.stderr, /nonexistent\.yml/);
  });
});
