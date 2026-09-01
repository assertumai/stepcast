import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { StepcastError, ExitCode, type ExitCodeValue } from '../../core/errors.js';
import type { ParsedArgs } from '../args.js';

/**
 * Шаблон нарочно без агентского бэкенда: `stepcast init && stepcast run
 * stepcast.yml` должен работать сразу после установки, без Claude Code и без
 * сетевого доступа.
 */
const PIPELINE_TEMPLATE = `version: 1
kind: pipeline
name: example

jobs:
  build:
    description: Командный шаг, показывающий структуру файла
    steps:
      - id: check
        run: [echo, ok]
        expect:
          - exit_code: 0

  example:
    description: Работа, вынесенная в отдельный файл через uses
    needs: [build]
    uses: .stepcast/jobs/example.yml
`;

const EXAMPLE_JOB_TEMPLATE = `version: 1
kind: job

steps:
  - id: hello
    run: [echo, "привет из отдельного файла работы"]
    expect:
      - exit_code: 0
`;

/** Каталог знания и файл правил встроенного источника — умолчания разворачивания. */
const KNOWLEDGE_DIR = 'knowledge';
const KNOWLEDGE_RULES = join('.stepcast', 'prompts', 'knowledge-rules.md');

const KNOWLEDGE_CONFIG_TEMPLATE = `version: 1
kind: config

project:
  knowledge:
    provider: fs
    dir: ${KNOWLEDGE_DIR}
    rules: ${KNOWLEDGE_RULES.split('\\').join('/')}
`;

const KNOWLEDGE_RULES_TEMPLATE = `Единица знания заводится тогда, и только тогда, когда утверждение
**невыводимо из кода**: ограничение платформы, причина отвергнутого решения,
поведение, которое выглядит ошибкой и ею не является, замеренная цифра.
Всё, что читается из самого кода, из его тестов или из спеки, единицей знания
не становится — оно уже есть, и второй его экземпляр будет стареть отдельно.

Шапка обязательна и состоит из \`id\`, \`title\`, \`scope\`, \`status\` и — почти
всегда — \`anchors\`.

- \`scope\` — пути, при правке которых единица понадобится. По ним её находит
  отбор.
- \`anchors\` — пути, по которым обнаружится её устаревание. Ревизию в якорь
  подставляет движок: объявлять себя вечно свежим пишущий не вправе.
- \`status: superseded\` — отменённое. Оно выпадает из оглавления и отбора, но
  остаётся в дереве и в истории. Удалять вместо этого не надо.

Оглавление ограничено \`project.knowledge.index_max_tokens\`, и место в нём —
единственное, что удерживает память от разрастания. Прежде чем заводить
новую единицу, посмотрите, нет ли уже утверждающей то же: обновить
существующую лучше, чем завести вторую.
`;

const KNOWLEDGE_SAMPLE_TEMPLATE = `---
id: knowledge-index-is-derived
title: Оглавление памяти собирается из шапок и файлом не хранится
scope:
  - ${KNOWLEDGE_DIR}/**
status: active
---

Файла оглавления в дереве нет: \`stepcast knowledge index\` собирает его из
шапок единиц знания при каждом вызове. Поэтому оглавление не может разойтись
с содержимым каталога, и следить за их согласием не нужно.

Предел \`index_max_tokens\` кладётся именно на оглавление, а не на объём
знания: он и есть механизм против разрастания — новая единица обязана
отвоевать строку в конечном оглавлении.

Эту единицу можно удалить: она оставлена образцом формы.
`;

export function runInitCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): ExitCodeValue {
  const force = args.flags.force === true;
  const knowledge = args.flags.knowledge;

  if (knowledge !== undefined) {
    if (knowledge !== 'fs') {
      throw new StepcastError(`Неизвестный источник знания: ${String(knowledge)}`, {
        hint: 'Разворачивается только встроенный источник: --knowledge fs. Свой объявляется вручную — provider: cmd',
      });
    }
    return initKnowledge(cwd, force, write);
  }

  const pipelinePath = join(cwd, 'stepcast.yml');

  if (existsSync(pipelinePath) && !force) {
    throw new StepcastError(`${pipelinePath} уже существует`, {
      file: pipelinePath,
      hint: 'Передайте --force, чтобы перезаписать',
    });
  }

  const examplePath = join(cwd, '.stepcast', 'jobs', 'example.yml');
  mkdirSync(dirname(examplePath), { recursive: true });
  writeFileSync(pipelinePath, PIPELINE_TEMPLATE);
  writeFileSync(examplePath, EXAMPLE_JOB_TEMPLATE);

  write(`создан ${pipelinePath}`);
  write(`создан ${examplePath}`);
  return ExitCode.ok;
}

/**
 * Разворачивание практики памяти. Отдельным флагом, а не частью обычной
 * инициализации: практика памяти — выбор репозитория, и создавать её за
 * автора, который о ней не просил, значило бы заводить каталог, за которым
 * никто не следит.
 *
 * Конфигурация не перезаписывается целиком, если уже существует: в ней лежит
 * `project.check`, границы правок и прочее, чего разворачивание не знает.
 */
function initKnowledge(cwd: string, force: boolean, write: (line: string) => void): ExitCodeValue {
  const configPath = join(cwd, '.stepcast', 'config.yml');
  const dirPath = join(cwd, KNOWLEDGE_DIR);
  const rulesPath = join(cwd, KNOWLEDGE_RULES);

  const occupied = [dirPath, rulesPath].filter((path) => existsSync(path));
  if (occupied.length > 0 && !force) {
    throw new StepcastError(`Практика памяти уже развёрнута: ${occupied.join(', ')}`, {
      file: occupied[0] as string,
      hint: 'Передайте --force, чтобы перезаписать',
    });
  }

  // Существующая конфигурация не переписывается **никогда**, в том числе под
  // `--force`. Флаг здесь означает «перезаписать развёрнутое разворачиванием»
  // — каталог знания и файл правил, — а не «заменить конфигурацию проекта
  // тремя строками шаблона»: в ней лежат команда проверки, границы правок и
  // бюджеты, о которых разворачивание не знает, и подсказка про `--force`,
  // адресованная занятому каталогу, стоила бы их все.
  //
  // Дописывать в чужой YAML движок тоже не берётся: правка, вставленная не в
  // ту секцию, ломает конфигурацию молча. Автору называется, что именно
  // дописать, — это дешевле неверной автоматической вставки.
  if (existsSync(configPath)) {
    const text = readFileSync(configPath, 'utf8');
    if (/^\s*knowledge:/m.test(text) && !force) {
      throw new StepcastError(`Секция project.knowledge уже объявлена: ${configPath}`, {
        file: configPath,
        hint: 'Передайте --force, чтобы перезаписать каталог знания; конфигурацию правьте руками',
      });
    }
    write(`конфигурация ${configPath} уже есть — допишите в неё:`);
    for (const line of KNOWLEDGE_CONFIG_TEMPLATE.split('\n').slice(2)) write(`  ${line}`);
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, KNOWLEDGE_CONFIG_TEMPLATE);
    write(`создан ${configPath}`);
  }

  mkdirSync(dirPath, { recursive: true });
  mkdirSync(dirname(rulesPath), { recursive: true });
  writeFileSync(rulesPath, KNOWLEDGE_RULES_TEMPLATE);
  const samplePath = join(dirPath, 'knowledge-index-is-derived.md');
  writeFileSync(samplePath, KNOWLEDGE_SAMPLE_TEMPLATE);

  write(`создан ${rulesPath}`);
  write(`создан ${samplePath}`);
  return ExitCode.ok;
}
