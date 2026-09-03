import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative as relativePath, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

import { createFakeBackend, initLine, resultLine } from '../src/core/backend/fake.js';
import { resolveConfig, type Config } from '../src/core/config/resolve.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { readStatus } from '../src/core/journal/reader.js';
import { runPipeline } from '../src/core/run/runner.js';
import { asAgent } from './helpers.js';
import { makeProject, type Project } from './helpers.js';

/**
 * Корень репозитория. Тесты компилируются в `dist/test/**`, а файлы петли —
 * `.stepcast/**` — остаются там же, где лежат в исходном дереве: два уровня
 * вверх от `dist/test/` (тот же приём, что в `schema-generated.test.ts`).
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const JOBS_DIR = join(ROOT, '.stepcast', 'jobs');
const PROMPTS_DIR = join(ROOT, '.stepcast', 'prompts');

/**
 * Файлы с одним из перечисленных расширений во всём поддереве каталога.
 *
 * Обход именно рекурсивный: `.stepcast/jobs/**` — это весь поддиректорий работ,
 * и файл, положенный в подкаталог, обязан попадать в те же проверки, а не
 * выпадать из них молча.
 */
function filesUnder(dir: string, suffixes: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, suffixes);
    return suffixes.some((suffix) => entry.name.endsWith(suffix)) ? [full] : [];
  });
}

/** Файлы работ петли. Оба написания расширения YAML — движок принимает и то и другое. */
function jobFiles(): string[] {
  return filesUnder(JOBS_DIR, ['.yml', '.yaml']);
}

/**
 * Задача 4.11 (а): файлы петли (кроме файла правил, объявленного самим
 * названием) не должны нести литералов OpenSpec — иначе смена практики
 * репозитория потребовала бы правки этих файлов, а именно это изменение и
 * снимает.
 */
describe('self-improvement-loop: переносимость файлов петли', () => {
  const FORBIDDEN: readonly RegExp[] = [
    /openspec/i,
    /proposal\.md/,
    /design\.md/,
    /tasks\.md/,
    /specs\/\*\*/,
    // job-tools-declaration: инструментарий этого репозитория называется
    // объявлением project.tools, а не правом файла работы напрямую. Образец —
    // само право (`Bash(npm`), а не всякое вхождение слова: комментарий,
    // поясняющий пример подстановкой, литералом права не является.
    /Bash\(npm\b/,
    /Bash\(npx\b/,
    /Bash\(node\b/,
    // changed-only-boundaries-declaration: раскладка этого репозитория
    // называется объявлением project.edit_paths, а не шаблонами changed_only
    // в файле работы напрямую. Шаблон с `**` — это как раз запись границы
    // (`docs/config.md` в обычном тексте комментария границей не является).
    /src\/\*\*/,
    /test\/\*\*/,
    /docs\/\*\*/,
    /schema\/\*\*/,
    /scripts\/\*\*/,
    /ui\/\*\*/,
    /package\.json/,
    /package-lock\.json/,
    /vite\.config/,
    /eslint\.config/,
    /README\.md/,
    /\.gitattributes/,
    /examples\/\*\*/,
    // Та же раскладка, пересказанная промптом словами, а не шаблоном
    // changed_only: каталог, названный в обратных кавычках со слешем, — это
    // объявление границы промптом, а не случайное упоминание пути в тексте.
    /`src\//,
    /`test\//,
    /`docs\//,
  ];

  it('файлы работ петли не называют OpenSpec и его документы', () => {
    for (const file of jobFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        assert.doesNotMatch(text, pattern, `${file} содержит ${pattern}`);
      }
    }
  });

  it('промпты петли, кроме файла правил, не называют OpenSpec и его документы', () => {
    for (const file of filesUnder(PROMPTS_DIR, ['.md'])) {
      if (file.endsWith('spec-rules.md')) continue;
      const text = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        assert.doesNotMatch(text, pattern, `${file} содержит ${pattern}`);
      }
    }
  });

  it('файл правил остаётся местом, где OpenSpec назван', () => {
    const text = readFileSync(join(PROMPTS_DIR, 'spec-rules.md'), 'utf8');
    assert.match(text, /openspec/i);
  });

  /**
   * Файл, названный объявлением, обязан существовать. Линт этого не увидит:
   * путь с подстановкой чистого пространства `${project.*}` раскрывается при
   * разборе, и проверка существования его ловит (`checkDeclaredPath`) — но
   * `project.spec.rules` этого репозитория объявлен в `.stepcast/config.yml`
   * (backlog-item-names-repo, «Объявления этого репозитория живут в его
   * конфигурации»), а не в документе пайплайна, который секции `project`
   * больше не несёт. Здесь — та же проверка на самом объявлении, чтобы промах
   * был виден и без прогона линта на петле.
   */
  it('файл, названный project.spec.rules, лежит на диске', () => {
    const document = parseYaml(readFileSync(join(ROOT, '.stepcast', 'config.yml'), 'utf8')) as {
      project?: { spec?: { rules?: string } };
    };
    const rules = document.project?.spec?.rules;

    assert.equal(typeof rules, 'string');
    assert.ok(existsSync(join(ROOT, rules as string)), `файла ${rules} нет в дереве`);
  });

  /**
   * Обратная сторона переноса: документ пайплайна больше не объявляет секцию
   * `project` вовсе (self-improvement-loop, «Единственный слой объявления») —
   * два слоя объявления одного и того же значения разошлись бы молча, если
   * бы этот факт не проверялся отдельно от того, что подстановка раскрывается
   * в прежнее значение (см. describe ниже).
   */
  it('документ пайплайна секции project не содержит', () => {
    const document = parseYaml(
      readFileSync(join(ROOT, '.stepcast', 'pipelines', 'self-improve.yml'), 'utf8'),
    ) as { project?: unknown };
    assert.equal(document.project, undefined);
  });

  /**
   * backlog-item-names-repo: контекст уровня пайплайна наследует каждая работа
   * обеих дорожек, а проверка и практика спецификации у дорожки свои — те, что
   * объявил репозиторий её пункта. Текст, называющий здесь `${project.check}`
   * (команду корня), доезжал бы до дорожки, взявшей вложенный репозиторий, и
   * противоречил бы её собственному гейту: параметров на этом уровне нет, и
   * назвать команду правильно текст не может — её называет работа.
   */
  it('текст контекста пайплайна не называет ${project.check} и ${project.spec.*}', () => {
    const document = parseYaml(
      readFileSync(join(ROOT, '.stepcast', 'pipelines', 'self-improve.yml'), 'utf8'),
    ) as { context?: readonly { text?: string }[] };

    for (const entry of document.context ?? []) {
      if (typeof entry.text !== 'string') continue;
      assert.doesNotMatch(entry.text, /\$\{project\.check\}/);
      assert.doesNotMatch(entry.text, /\$\{project\.spec/);
    }
  });

  /**
   * Обратная сторона: команду проверки агент всё же обязан узнать — из промпта
   * той работы, которая гоняет ею гейт, где параметр дорожки доступен. Иначе
   * запрет выше просто оставил бы агента без указания, чем проверять.
   */
  it('промпты implement и fix-review называют ${params.check} и каталог репозитория', () => {
    for (const name of ['implement.md', 'fix-review.md']) {
      const text = readFileSync(join(PROMPTS_DIR, name), 'utf8');
      assert.match(text, /\$\{params\.check\}/, name);
      assert.match(text, /\$\{params\.repo_dir\}/, name);
    }
  });

  /**
   * guard-clean-nested: свой `git status` в шаге видит один каталог и не
   * заглядывает в объявленные вложенные репозитории — проверка чистоты обязана
   * идти командой бинаря, которая читает `project.nested_repos` из
   * конфигурации сама. Состав вдобавок не публикуется подстановкой
   * `${project.*}`, и файлу работы прочитать его неоткуда.
   */
  it('шаг проверки чистоты в slots.yml зовёт $STEPCAST_BIN assert-clean, а не git status', () => {
    const text = readFileSync(join(JOBS_DIR, 'slots.yml'), 'utf8');
    assert.match(text, /"\$STEPCAST_BIN"\s+assert-clean/);
    assert.doesNotMatch(text, /git status/);
  });
});

/**
 * Конфигурация настоящего репозитория, читаемая так же, как её читала бы
 * команда движка: домашний каталог фальшивый (иначе гоняющая машина подмешала
 * бы свой `~/.stepcast/config.yml`), проектный — настоящий `.stepcast/config.yml`
 * этого репозитория, куда переехала секция `project`. `makeProject()` для
 * этих тестов не годится: с тех пор как пайплайн секцию `project` не несёт,
 * пустая конфигурация оставила бы `project.check`/`tools`/`spec` неопределёнными
 * — expandPipeline отказал бы раньше самих проверок.
 */
function realProjectConfig(): Config {
  const home = mkdtempSync(join(tmpdir(), 'stepcast-loop-portability-home-'));
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  return resolveConfig({ cwd: ROOT, home }).config;
}

/**
 * job-tools-declaration: настоящий пайплайн петли, раскрытый целиком, обязан
 * давать `implement` и `fix-review` тот же набор прав, что они несли
 * литералами до изменения, — в том же порядке и с теми же соседями.
 *
 * Проверка идёт по настоящему `.stepcast/pipelines/self-improve.yml`, а не по
 * его копии: перенос объявления `tools` в `.stepcast/config.yml` или правка
 * прав в файле работы обязаны быть видны здесь, а копия пайплайна отставала бы
 * от оригинала молча. Ожидаемый список выписан целиком, а не проверен на
 * вхождение: смысл требования — тождество прежнему набору, и лишнее право в
 * нём такой же промах, как недостающее.
 */
describe('self-improvement-loop: настоящий пайплайн петли даёт прежний набор прав', () => {
  const EXPECTED_ALLOW = [
    'Read',
    'Grep',
    'Glob',
    'Edit',
    'Write',
    'Bash(npm *)',
    'Bash(npx *)',
    'Bash(node *)',
    'Bash(git status*)',
    'Bash(git diff*)',
    'Bash(git log*)',
  ];

  /**
   * changed-only-boundaries-declaration: тот же набор шаблонов, что нёс
   * предикат до переноса раскладки в `project.edit_paths`, — сравнивается как
   * множество, а не по порядку.
   *
   * Каталог документов изменения и файл правил здесь — не разрешённые пути
   * (`openspec/changes/**`, `.stepcast/prompts/spec-rules.md`), а буквальный
   * текст отложенной подстановки `${jobs.slots.output.lanes.<lane>.repo.spec.*}`
   * (backlog-item-names-repo, риск «Путь, объявленный через params, выпадает
   * из статической проверки линта»): значение приходит параметром с места
   * подключения работы, ссылающимся на выход work slots, а он раскрывается не
   * при разборе документа, а перед исполнением работы (`resolveLate`) — на
   * структурном разборе, которым здесь проверяется набор границ, работа slots
   * ещё не запускалась. Дорожки a и b поэтому несут разный текст (свой lane в
   * пути), хотя раскроются в одно и то же значение у пункта без repos.
   */
  function expectedChangedOnly(lane: 'a' | 'b'): ReadonlySet<string> {
    return new Set([
      'src/**',
      'test/**',
      'docs/**',
      // Память репозитория: работа remember правит только её, и без границы
      // её правка выглядела бы выходом за объявленное.
      'knowledge/**',
      `\${jobs.slots.output.lanes.${lane}.repo.spec.dir}/**`,
      'schema/**',
      'scripts/**',
      'package.json',
      'package-lock.json',
      '.gitattributes',
      '.stepcast/config.yml',
      '.stepcast/prompts/**',
      `\${jobs.slots.output.lanes.${lane}.repo.spec.rules}`,
      '.stepcast/jobs/**',
      '.stepcast/pipelines/**',
      '.stepcast/schemas/**',
      'ui/**',
      'vite.config.ts',
      'README.md',
      'eslint.config.js',
      'examples/**',
    ]);
  }

  it('implement и fix-review обеих дорожек несут прежние права в прежнем порядке', () => {
    const { pipeline } = expandPipeline({
      pipelinePath: join(ROOT, '.stepcast', 'pipelines', 'self-improve.yml'),
      config: realProjectConfig(),
    });

    for (const id of ['implement-a', 'implement-b', 'fix-review-a', 'fix-review-b']) {
      const job = pipeline.jobs.find((item) => item.id === id);
      assert.ok(job !== undefined, `работы ${id} нет в пайплайне петли`);
      assert.deepEqual(asAgent(job.steps[0]!).permissions?.allow, EXPECTED_ALLOW, id);
    }
  });

  it('implement и fix-review обеих дорожек несут прежний набор границ changed_only (для своей дорожки)', () => {
    const { pipeline } = expandPipeline({
      pipelinePath: join(ROOT, '.stepcast', 'pipelines', 'self-improve.yml'),
      config: realProjectConfig(),
    });

    for (const id of ['implement-a', 'fix-review-a', 'implement-b', 'fix-review-b']) {
      const lane = id.endsWith('-a') ? 'a' : 'b';
      const job = pipeline.jobs.find((item) => item.id === id);
      assert.ok(job !== undefined, `работы ${id} нет в пайплайне петли`);
      const predicate = job.steps[0]!.expect.find((item) => item.kind === 'changed_only') as
        | { readonly globs: readonly string[] }
        | undefined;
      assert.ok(predicate !== undefined, `${id}: нет предиката changed_only`);
      assert.deepEqual(new Set(predicate.globs), expectedChangedOnly(lane), id);
    }
  });

  /**
   * backlog-item-names-repo: проверка того, что path объявления практики
   * действительно переехал с `${project.spec.*}` на параметр дорожки —
   * обратное этому регрессировало бы в старое поведение (гейт всегда корня)
   * молча, потому что структурная проверка выше сравнивает текст, а не
   * пространство подстановки, из которого он взят.
   */
  it('границы implement/fix-review не содержат ${project.spec.*} и ${project.check}', () => {
    const { pipeline } = expandPipeline({
      pipelinePath: join(ROOT, '.stepcast', 'pipelines', 'self-improve.yml'),
      config: realProjectConfig(),
    });

    for (const id of ['implement-a', 'implement-b', 'fix-review-a', 'fix-review-b']) {
      const job = pipeline.jobs.find((item) => item.id === id)!;
      const predicate = job.steps[0]!.expect.find((item) => item.kind === 'changed_only') as
        | { readonly globs: readonly string[] }
        | undefined;
      const globs = predicate?.globs ?? [];
      assert.ok(
        globs.every((glob) => !glob.includes('${project.spec')),
        `${id}: changed_only несёт ${'${project.spec'}...`,
      );

      for (const entry of job.until?.check ?? []) {
        const cmd = entry.kind === 'cmd' ? entry.command : undefined;
        if (cmd === undefined) continue;
        assert.doesNotMatch(cmd, /\$\{project\.check\}/, `${id}: until.check несёт \${project.check}`);
        assert.doesNotMatch(cmd, /\$\{project\.spec/, `${id}: until.check несёт \${project.spec...}`);
      }
    }
  });
});

/**
 * Задача 4.11 (б): настоящие файлы работ петли, раскрытые против чужого
 * объявления `project.spec`, обязаны нести чужие пути и чужое имя
 * инструмента — а не сегодняшние `openspec/changes` и `openspec`, которые
 * дают только потому, что это объявление этого репозитория.
 */
describe('self-improvement-loop: настоящие файлы петли против чужого объявления', () => {
  function foreignPipeline(
    tools: readonly string[] = ['make'],
    editPaths: readonly string[] = ['cmd/**', 'internal/**', 'go.mod'],
  ): string {
    return `
kind: pipeline
name: foreign
project:
  check: "true"
  tools: [${tools.join(', ')}]
  spec:
    dir: docs/changes
    rules: docs/spec-rules.md
    tool: make
  edit_paths: [${editPaths.join(', ')}]
jobs:
  propose-a:
    uses: ${JOBS_DIR}/propose.yml
    with:
      lane: a
      spec_dir: "\${project.spec.dir}"
      spec_rules: "\${project.spec.rules}"
      spec_tool: "\${project.spec.tool}"
  plan-a:
    uses: ${JOBS_DIR}/plan.yml
    with: { change: demo-change, spec_dir: "\${project.spec.dir}" }
    needs: [propose-a]
  implement-a:
    uses: ${JOBS_DIR}/implement.yml
    with:
      change: demo-change
      lane: a
      repo_dir: "."
      check: "\${project.check}"
      spec_dir: "\${project.spec.dir}"
      spec_rules: "\${project.spec.rules}"
      spec_tool: "\${project.spec.tool}"
    needs: [plan-a]
  review-a:
    uses: ${JOBS_DIR}/review.yml
    with: { change: demo-change, spec_dir: "\${project.spec.dir}" }
    needs: [implement-a]
  fix-review-a:
    uses: ${JOBS_DIR}/fix-review.yml
    with:
      change: demo-change
      repo_dir: "."
      check: "\${project.check}"
      spec_dir: "\${project.spec.dir}"
      spec_rules: "\${project.spec.rules}"
      spec_tool: "\${project.spec.tool}"
    needs: [review-a]
`;
  }

  function expandForeign(project: Project, tools?: readonly string[]) {
    project.write('stepcast.yml', foreignPipeline(tools));
    return expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }).pipeline;
  }

  it('propose-a: границы и право на инструмент называют чужие значения', () => {
    const pipeline = expandForeign(makeProject());
    const job = pipeline.jobs.find((item) => item.id === 'propose-a')!;
    const step = asAgent(job.steps[0]!);

    assert.deepEqual(
      job.steps[0]!.expect.find((item) => item.kind === 'changed_only'),
      { kind: 'changed_only', globs: ['docs/changes/**'] },
    );
    assert.ok(step.permissions?.allow?.includes('Bash(make *)'));
    assert.deepEqual(
      step.context.find((entry) => entry.kind === 'path' && entry.path === 'docs/spec-rules.md'),
      { kind: 'path', path: 'docs/spec-rules.md', mode: 'inline' },
    );
  });

  it('plan-a: путь контекста ведёт в чужой каталог документов', () => {
    const pipeline = expandForeign(makeProject());
    const job = pipeline.jobs.find((item) => item.id === 'plan-a')!;

    assert.deepEqual(job.context, [
      { kind: 'path', path: 'docs/changes/demo-change/**/*.md', mode: 'auto', required: true },
    ]);
  });

  it('implement-a: контекст, границы и правила ведут в чужой каталог', () => {
    const pipeline = expandForeign(makeProject());
    const job = pipeline.jobs.find((item) => item.id === 'implement-a')!;

    assert.deepEqual(job.context, [
      {
        kind: 'path',
        path: 'docs/changes/demo-change/**/*.md',
        mode: 'reference',
        required: true,
      },
      { kind: 'path', path: 'docs/spec-rules.md', mode: 'inline' },
    ]);
    const globs = (
      job.steps[0]!.expect.find((item) => item.kind === 'changed_only') as { globs: readonly string[] }
    ).globs;
    assert.ok(globs.includes('docs/changes/**'));
    assert.ok(globs.includes('docs/spec-rules.md'));
  });

  it('review-a: путь контекста ведёт в чужой каталог документов', () => {
    const pipeline = expandForeign(makeProject());
    const job = pipeline.jobs.find((item) => item.id === 'review-a')!;

    assert.deepEqual(job.context, [
      { kind: 'path', path: 'docs/changes/demo-change/**/*.md', mode: 'auto', required: true },
    ]);
  });

  it('fix-review-a: границы включают чужой каталог и чужие правила', () => {
    const pipeline = expandForeign(makeProject());
    const job = pipeline.jobs.find((item) => item.id === 'fix-review-a')!;

    assert.deepEqual(job.context, [
      { kind: 'path', path: 'docs/spec-rules.md', mode: 'inline' },
    ]);
    const globs = (
      job.steps[0]!.expect.find((item) => item.kind === 'changed_only') as { globs: readonly string[] }
    ).globs;
    assert.ok(globs.includes('docs/changes/**'));
    assert.ok(globs.includes('docs/spec-rules.md'));
  });

  // job-tools-declaration: implement и fix-review читают инструменты чужим
  // объявлением (project.tools: [make]), а не тремя литералами этого
  // репозитория — право называет чужой инструмент, и ни одного из старых
  // трёх среди прав нет.
  it('implement-a и fix-review-a несут право Bash(make *) и ни одного из npm/npx/node', () => {
    const pipeline = expandForeign(makeProject());
    for (const id of ['implement-a', 'fix-review-a']) {
      const job = pipeline.jobs.find((item) => item.id === id)!;
      const allow = asAgent(job.steps[0]!).permissions?.allow ?? [];
      assert.ok(allow.includes('Bash(make *)'), `${id}: нет Bash(make *)`);
      assert.ok(!allow.includes('Bash(npm *)'), `${id}: остался Bash(npm *)`);
      assert.ok(!allow.includes('Bash(npx *)'), `${id}: остался Bash(npx *)`);
      assert.ok(!allow.includes('Bash(node *)'), `${id}: остался Bash(node *)`);
    }
  });

  it('объявление нескольких инструментов даёт записи в объявленном порядке', () => {
    const pipeline = expandForeign(makeProject(), ['./gradlew', 'java']);
    for (const id of ['implement-a', 'fix-review-a']) {
      const job = pipeline.jobs.find((item) => item.id === id)!;
      const allow = asAgent(job.steps[0]!).permissions?.allow ?? [];
      const gradlewIndex = allow.indexOf('Bash(./gradlew *)');
      const javaIndex = allow.indexOf('Bash(java *)');
      assert.ok(gradlewIndex !== -1 && javaIndex !== -1, `${id}: не нашлись оба права`);
      assert.ok(gradlewIndex < javaIndex, `${id}: порядок не совпадает с объявленным`);
    }
  });

  // changed-only-boundaries-declaration: implement и fix-review читают
  // раскладку чужим объявлением (project.edit_paths: [cmd/**, internal/**,
  // go.mod]), а не двенадцатью литералами этого репозитория — границы называют
  // чужой стек, ни одного из старых npm-шаблонов среди них нет, а каталог
  // документов изменения и файл правил остаются, потому что их объявляет
  // отдельный ключ (project.spec), не задетый этим объявлением.
  it('implement-a и fix-review-a несут границы cmd/**, internal/**, go.mod и ни одной раскладки этого репозитория', () => {
    const REPO_LAYOUT = [
      'src/**',
      'test/**',
      'docs/**',
      'schema/**',
      'scripts/**',
      'ui/**',
      'package.json',
      'package-lock.json',
      'vite.config.ts',
      'eslint.config.js',
      'README.md',
      '.gitattributes',
      'examples/**',
    ];

    const pipeline = expandForeign(makeProject());
    for (const id of ['implement-a', 'fix-review-a']) {
      const job = pipeline.jobs.find((item) => item.id === id)!;
      const globs = (
        job.steps[0]!.expect.find((item) => item.kind === 'changed_only') as { globs: readonly string[] }
      ).globs;

      assert.ok(globs.includes('cmd/**'), `${id}: нет cmd/**`);
      assert.ok(globs.includes('internal/**'), `${id}: нет internal/**`);
      assert.ok(globs.includes('go.mod'), `${id}: нет go.mod`);
      for (const pattern of REPO_LAYOUT) {
        assert.ok(!globs.includes(pattern), `${id}: остался шаблон этого репозитория ${pattern}`);
      }
      assert.ok(globs.includes('docs/changes/**'), `${id}: пропал каталог документов изменения`);
      assert.ok(globs.includes('docs/spec-rules.md'), `${id}: пропал файл правил`);
    }
  });

  // Устройство петли задаёт движок, а не репозиторий, поэтому записи
  // `.stepcast/**` остались в файлах работ литералами и в `project.edit_paths`
  // не переносятся: чужое объявление границ их не заменяет и не отменяет.
  // Косвенно это же сторожит сравнение с прежним набором на настоящем
  // пайплайне, но там свойство видно только через отсутствие записей в
  // `edit_paths` — здесь оно утверждается прямо.
  it('записи .stepcast/** остаются в границах и против чужого объявления', () => {
    const ENGINE_FILES = [
      '.stepcast/config.yml',
      '.stepcast/jobs/**',
      '.stepcast/pipelines/**',
      '.stepcast/prompts/**',
      '.stepcast/schemas/**',
    ];

    const pipeline = expandForeign(makeProject());
    for (const id of ['implement-a', 'fix-review-a']) {
      const job = pipeline.jobs.find((item) => item.id === id)!;
      const globs = (
        job.steps[0]!.expect.find((item) => item.kind === 'changed_only') as { globs: readonly string[] }
      ).globs;

      for (const pattern of ENGINE_FILES) {
        assert.ok(globs.includes(pattern), `${id}: пропала запись ${pattern}`);
      }
    }
  });
});

/**
 * Задача 4.11 (в): сквозной прогон петли на поддельном бэкенде в дереве без
 * каталога `openspec/` доходит до последней работы.
 *
 * Цепочка сокращена до `plan → implement → review → fix-review` — работы
 * `propose`, `slots`, `merge` и `finalize` заняты выбором пункта очереди и
 * сведением дорожек, устройством, не связанным с этим изменением (у `propose`
 * есть свой файл `${run.dir}/item-<дорожка>.json`, который в настоящей петле
 * пишет `slots`). Четырёх оставшихся работ достаточно, чтобы доказать: чужое
 * объявление `project.spec` доезжает подстановкой через контекст, цикл
 * `until` (командами `${project.check}` и инструмента практики), границы
 * `changed_only` и права — до самого конца, ни разу не споткнувшись о литерал
 * OpenSpec.
 */
describe('self-improvement-loop: сквозной прогон против чужого объявления', () => {
  const RUN_PIPELINE = `
kind: pipeline
name: foreign-run
project:
  check: "true"
  tools: [make]
  spec:
    dir: docs/changes
    rules: docs/spec-rules.md
    # "true", а не make: инструмент практики попал в предикат цикла until и
    # теперь исполняется, а не только раскрывается, — а make в дереве проверок
    # звать нечем. Статические проверки выше берут make и стерегут именно
    # раскрытие.
    tool: "true"
  edit_paths: [cmd/**, internal/**, go.mod]
jobs:
  plan-a:
    uses: ${JOBS_DIR}/plan.yml
    with: { change: demo-change, spec_dir: "\${project.spec.dir}" }
  implement-a:
    uses: ${JOBS_DIR}/implement.yml
    with:
      change: demo-change
      lane: a
      repo_dir: "."
      check: "\${project.check}"
      spec_dir: "\${project.spec.dir}"
      spec_rules: "\${project.spec.rules}"
      spec_tool: "\${project.spec.tool}"
    needs: [plan-a]
  review-a:
    uses: ${JOBS_DIR}/review.yml
    with: { change: demo-change, spec_dir: "\${project.spec.dir}" }
    needs: [implement-a]
  fix-review-a:
    uses: ${JOBS_DIR}/fix-review.yml
    with:
      change: demo-change
      repo_dir: "."
      check: "\${project.check}"
      spec_dir: "\${project.spec.dir}"
      spec_rules: "\${project.spec.rules}"
      spec_tool: "\${project.spec.tool}"
    needs: [review-a]
`;

  /**
   * Чужое дерево: свой файл правил и каталог изменения из одного документа —
   * состав нарочно неполный, потому что практика допускает не заводить часть
   * документов, и работы петли обязаны это пережить.
   */
  function foreignTree(): Project {
    const project = makeProject({
      'stepcast.yml': RUN_PIPELINE,
      'docs/spec-rules.md': 'Документы изменения пишутся руками, проверяются `make spec`.\n',
      'docs/changes/demo-change/README.md': '# demo-change\n\nОписание изменения.\n',
    });
    return project;
  }

  it('доходит до последней работы в дереве без каталога openspec/', async () => {
    const project = foreignTree();

    const structuredByInvocation = [
      { tasks: [{ id: 't1', title: 'demo', files: ['src/x.ts'], done_when: 'tests pass' }] },
      { changed_files: [], completed: ['t1'], remaining: [] },
      { findings: [] },
      { changed_files: [], completed: [], remaining: [] },
    ];
    const backend = createFakeBackend({
      lines: (index) => [initLine(), resultLine({ text: 'ок', structured: structuredByInvocation[index] })],
    });

    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: () => backend.adapter,
    });

    assert.equal(result.status, 'success');
    const status = readStatus(result.journal.paths);
    assert.equal(status.jobs.find((job) => job.id === 'fix-review-a')?.status, 'success');
    assert.equal(backend.invocations.length, 4);

    // Документы изменения дошли до агента: глоб раскрылся в чужом каталоге, а
    // не остался пустым, — иначе успех цепочки ничего бы не доказывал.
    assert.match(backend.invocations[0]?.prompt ?? '', /docs\/changes\/demo-change\/README\.md/);
  });

  /**
   * Обратная сторона того же: пустой каталог изменения — это не «часть
   * документов не заведена», а несобранный контекст, и работа обязана
   * отказать, а не планировать по пустому месту. До `required: true` цепочка
   * из четырёх работ проходила в дереве, где каталога `docs/changes/` нет
   * вовсе.
   */
  it('пустой каталог изменения роняет первую же работу, а не проходит молча', async () => {
    const project = makeProject({
      'stepcast.yml': RUN_PIPELINE,
      'docs/spec-rules.md': 'правила\n',
    });

    const backend = createFakeBackend({
      lines: () => [initLine(), resultLine({ text: 'ок', structured: { tasks: [] } })],
    });

    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: () => backend.adapter,
    });

    assert.notEqual(result.status, 'success');
    const status = readStatus(result.journal.paths);
    const plan = status.jobs.find((job) => job.id === 'plan-a');
    assert.equal(plan?.status, 'failed');
    // Отказ именно на записи контекста, а не на чём-то попутном.
    assert.match(plan?.reason ?? '', /docs\/changes\/demo-change/);
    assert.equal(backend.invocations.length, 0);
  });

  // job-tools-declaration: implement и fix-review ссылаются на ${project.tools}
  // — объявление обязательно там, где на него ссылаются, и его отсутствие
  // роняет разбор раньше первого исполнения, а не проезжает мимо молча.
  it('пайплайн без объявления project.tools роняет разбор', () => {
    const project = makeProject({
      'stepcast.yml': RUN_PIPELINE.replace('  tools: [make]\n', ''),
      'docs/spec-rules.md': 'правила\n',
      'docs/changes/demo-change/README.md': '# demo-change\n',
    });

    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      (error: unknown) => {
        assert.match((error as Error).message ?? '', /project\.tools/);
        return true;
      },
    );
  });

  // changed-only-boundaries-declaration: implement и fix-review ссылаются на
  // ${project.edit_paths} — то же правило, что у project.tools: отсутствие
  // объявления роняет разбор до первого агентского вызова, а не запускает
  // петлю с границами наугад.
  it('пайплайн без объявления project.edit_paths роняет разбор до первого агентского вызова', () => {
    const project = makeProject({
      'stepcast.yml': RUN_PIPELINE.replace('  edit_paths: [cmd/**, internal/**, go.mod]\n', ''),
      'docs/spec-rules.md': 'правила\n',
      'docs/changes/demo-change/README.md': '# demo-change\n',
    });

    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      (error: unknown) => {
        assert.match((error as Error).message ?? '', /project\.edit_paths/);
        return true;
      },
    );
  });
});

/**
 * Задача 5.6: прогон настоящего `verify.yml` на подставном бэкенде — а точнее
 * вовсе без него, поскольку у работы нет агентских шагов, — доказывает, что
 * `cd "${params.repo_dir}" && ${params.check}` действительно меняет рабочий
 * каталог исполнения, а не только текст команды. Структурные проверки выше
 * (`expandPipeline`) доказывают форму предиката; здесь — что она отрабатывает
 * при настоящем исполнении шага оболочкой.
 *
 * Пункт без `repos` (repo_dir: ".") и пункт, назвавший вложенный репозиторий
 * (repo_dir: "backend"), различаются ровно тем маркерным файлом, который
 * видит `test -f` из своего рабочего каталога — так дублируется не два
 * похожих сценария, а два взаимно исключающих: `repo_dir` из другого сценария
 * не прошёл бы проверку этого.
 */
describe('self-improvement-loop: гейт исполняется в каталоге выбранного репозитория', () => {
  function verifyPipeline(repoDir: string, check: string): string {
    return `
kind: pipeline
name: verify-repo-dir
jobs:
  verify-a:
    uses: ${JOBS_DIR}/verify.yml
    with:
      change: demo-change
      repo_dir: ${JSON.stringify(repoDir)}
      check: ${JSON.stringify(check)}
      spec_tool: "true"
`;
  }

  async function runVerify(project: Project) {
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    return runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
    });
  }

  it('пункт без repos: проверка идёт в корне, как и до изменения', async () => {
    const project = makeProject({
      'stepcast.yml': verifyPipeline('.', 'test -f marker-root.txt'),
      'marker-root.txt': 'корень\n',
    });

    const result = await runVerify(project);
    assert.equal(result.status, 'success');
    const status = readStatus(result.journal.paths);
    assert.equal(status.jobs.find((job) => job.id === 'verify-a')?.status, 'success');
  });

  it('пункт с объявленным вложенным репозиторием: проверка идёт в его каталоге, не в корне', async () => {
    const project = makeProject({
      'stepcast.yml': verifyPipeline('backend', 'test -f marker-backend.txt && test ! -f marker-root.txt'),
      'marker-root.txt': 'корень\n',
      'backend/marker-backend.txt': 'бэкенд\n',
    });

    const result = await runVerify(project);
    assert.equal(result.status, 'success');
    const status = readStatus(result.journal.paths);
    assert.equal(status.jobs.find((job) => job.id === 'verify-a')?.status, 'success');
  });

  it('репозиторий другой дорожки не проходит проверку чужого repo_dir', async () => {
    // Обратная сторона предыдущего теста: команда корневого сценария,
    // исполненная в backend/, обязана провалиться — иначе assert выше
    // доказывал бы только то, что check вообще что-то пропускает, а не то,
    // что cd ведёт именно туда, куда назвал params.repo_dir.
    const project = makeProject({
      'stepcast.yml': verifyPipeline('backend', 'test -f marker-root.txt'),
      'marker-root.txt': 'корень\n',
      'backend/marker-backend.txt': 'бэкенд\n',
    });

    const result = await runVerify(project);
    assert.notEqual(result.status, 'success');
    const status = readStatus(result.journal.paths);
    assert.equal(status.jobs.find((job) => job.id === 'verify-a')?.status, 'failed');
  });
});

/**
 * job-schema-path-portable: ни одна ссылка файла работы петли, разрешаемая от
 * файла объявления, не должна вести за пределы `.stepcast/` — иначе перенос
 * `.stepcast/jobs/` в чужой репозиторий требует правки внутри скопированных
 * файлов. `slots.yml` был последней ссылкой наружу (`../../schema/...`);
 * форма `stepcast:<имя>` резолвится от расположения движка, а не от файла
 * объявления, и на границу репозитория не выходит.
 *
 * `changed_only` и `context` в обход не входят: это не ссылки на файл рядом с
 * документом работы, а описание дерева репозитория, который петля правит
 * (границы правок и контекст, разрешаемый от корня рабочей директории) —
 * включение их запретило бы петле знать что-либо о правимом репозитории, а
 * не сузило бы проверку до настоящих ссылок.
 */
describe('self-improvement-loop: ссылки файлов работ петли не покидают .stepcast/', () => {
  const STEPCAST_DIR = join(ROOT, '.stepcast');

  interface DeclaredRef {
    readonly key: string;
    readonly value: string;
  }

  /** Записи предиката (`expect` либо `until.check`), несущие `schema`. */
  function collectPredicateSchemas(predicates: unknown, prefix: string, refs: DeclaredRef[]): void {
    for (const [index, predicate] of ((predicates as readonly { schema?: string }[]) ?? []).entries()) {
      if (typeof predicate?.schema === 'string') {
        refs.push({ key: `${prefix}.${index}.schema`, value: predicate.schema });
      }
    }
  }

  /** Значение промпта, если это ссылка на файл (`prompt: ok` — текст, а не путь). */
  function promptRef(prompt: unknown, key: string, refs: DeclaredRef[]): void {
    if (typeof prompt === 'string' && prompt.startsWith('file:')) {
      refs.push({ key, value: prompt.slice('file:'.length) });
    }
  }

  /** Все ссылки файла работы, разрешаемые от него самого: uses, оба prompt: file: и все три места схемы. */
  function collectRefs(document: unknown): DeclaredRef[] {
    const doc = document as {
      uses?: string;
      output?: { schema?: string };
      until?: { check?: unknown };
      steps?: readonly {
        output_schema?: string;
        prompt?: string;
        expect?: unknown;
        on_fail?: { prompt?: string };
      }[];
    };
    const refs: DeclaredRef[] = [];

    if (typeof doc.uses === 'string') refs.push({ key: 'uses', value: doc.uses });
    if (typeof doc.output?.schema === 'string') {
      refs.push({ key: 'output.schema', value: doc.output.schema });
    }
    if (doc.until?.check !== undefined) collectPredicateSchemas(doc.until.check, 'until.check', refs);

    for (const [index, step] of (doc.steps ?? []).entries()) {
      if (typeof step.output_schema === 'string') {
        refs.push({ key: `steps.${index}.output_schema`, value: step.output_schema });
      }
      promptRef(step.prompt, `steps.${index}.prompt`, refs);
      // Промпт разбора неудачи — такая же ссылка `file:`, разрешаемая от файла
      // объявления (`readPrompt` в expand.ts), что и промпт самого шага: работ
      // с `on_fail` в петле пока нет, но появившаяся ссылка наружу обязана
      // ронять проверку, а не проезжать мимо сторожа.
      promptRef(step.on_fail?.prompt, `steps.${index}.on_fail.prompt`, refs);
      if (step.expect !== undefined) collectPredicateSchemas(step.expect, `steps.${index}.expect`, refs);
    }

    return refs;
  }

  /** Ссылки документа работы, ведущие за пределы `.stepcast/`, — с местом объявления. */
  function outsideRefs(document: unknown, file: string): string[] {
    return collectRefs(document)
      .filter((ref) => {
        // Ссылка на схему пакета не выходит за пределы .stepcast/ по построению:
        // движок разрешает её от собственного расположения, а не от файла
        // работы, и файловую систему работы вовсе не затрагивает.
        if (ref.value.startsWith('stepcast:')) return false;

        const resolved = isAbsolute(ref.value) ? ref.value : resolvePath(dirname(file), ref.value);
        const rel = relativePath(STEPCAST_DIR, resolved);
        return rel === '' || rel.startsWith('..') || isAbsolute(rel);
      })
      .map((ref) => `${file}: ${ref.key} = ${ref.value}`);
  }

  it('каждая ссылка uses, prompt: file: и объявленная схема разрешается внутрь .stepcast/', () => {
    const files = jobFiles();
    assert.ok(files.length > 0, `в ${JOBS_DIR} не найдено ни одного файла работы`);

    for (const file of files) {
      assert.deepEqual(outsideRefs(parseYaml(readFileSync(file, 'utf8')), file), []);
    }
  });

  /**
   * Сам сторож: работ с `on_fail` в петле сегодня нет, и обход настоящих файлов
   * о его ссылке ничего не сказал бы — ни когда она внутри, ни когда наружу.
   * Здесь проверяется, что ссылка каждого из четырёх видов, выведенная наружу,
   * обходом ловится и называется ключом объявления.
   */
  it('ссылку наружу ловит и называет — в uses, в обоих prompt: file: и в схеме', () => {
    const file = join(JOBS_DIR, 'probe.yml');
    const document = parseYaml(`
kind: job
name: probe
uses: ../../other/base.yml
output:
  schema: ../../schema/backlog-slots.schema.json
steps:
  - id: think
    agent: claude
    prompt: file:../../prompts/think.md
    on_fail:
      analyze: почему
      prompt: file:../../prompts/analyze.md
    expect:
      - schema: ../../schema/backlog-slots.schema.json
`);

    assert.deepEqual(outsideRefs(document, file), [
      `${file}: uses = ../../other/base.yml`,
      `${file}: output.schema = ../../schema/backlog-slots.schema.json`,
      `${file}: steps.0.prompt = ../../prompts/think.md`,
      `${file}: steps.0.on_fail.prompt = ../../prompts/analyze.md`,
      `${file}: steps.0.expect.0.schema = ../../schema/backlog-slots.schema.json`,
    ]);
  });

  it('те же ссылки внутри .stepcast/ и форма stepcast: наружу не считаются', () => {
    const file = join(JOBS_DIR, 'probe.yml');
    const document = parseYaml(`
kind: job
name: probe
output:
  schema: stepcast:backlog-slots
steps:
  - id: think
    agent: claude
    prompt: file:../prompts/think.md
    on_fail:
      analyze: почему
      prompt: file:../prompts/analyze.md
    expect:
      - schema: stepcast:backlog-slots
`);

    assert.deepEqual(outsideRefs(document, file), []);
  });
});

/**
 * job-schema-path-portable: обход выше доказывает, что ссылка не выходит за
 * `.stepcast/`; он не доказывает, что `stepcast:backlog-slots` в чужом дереве
 * во что-то разрешается. Здесь — настоящий `slots.yml`, скопированный (не
 * подключённый по абсолютному пути — тот всегда лежит рядом с настоящим
 * `schema/` этого репозитория и ничего бы не доказал) в проект, где каталога
 * `schema/` нет вовсе, и подключённый оттуда пайплайном.
 */
describe('self-improvement-loop: работа slots раскрывается в дереве без schema/', () => {
  it('output.schema ведёт в схему пакета, существующую и читаемую как JSON', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: probe
jobs:
  slots:
    uses: ./.stepcast/jobs/slots.yml
`,
      '.stepcast/jobs/slots.yml': readFileSync(join(JOBS_DIR, 'slots.yml'), 'utf8'),
    });

    const { pipeline } = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });

    const schemaPath = pipeline.jobs.find((job) => job.id === 'slots')?.output?.schemaPath;
    assert.ok(schemaPath !== undefined, 'output.schema не разрешился');
    assert.ok(existsSync(schemaPath), `схема не найдена: ${schemaPath}`);
    assert.doesNotThrow(() => JSON.parse(readFileSync(schemaPath, 'utf8')));
  });
});
