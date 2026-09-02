import { execFileSync } from 'node:child_process';
import { globSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { estimateTokens } from '../context/assemble.js';
import { matchesGlob } from '../context/glob.js';
import { StepcastError } from '../errors.js';
import { formatTokens } from '../units.js';
import { KnowledgeIdSchema } from './types.js';
import type {
  KnowledgeCheckResponse,
  KnowledgeEntry,
  KnowledgeIndexEntry,
  KnowledgeProblem,
  KnowledgeSelector,
  KnowledgeSource,
  KnowledgeWriteRequest,
  KnowledgeWriteResponse,
} from './types.js';

/**
 * Встроенный источник знания: каталог файлов Markdown с шапкой YAML.
 *
 * Это эталонная раскладка, а не единственная. Репозиторий, которому она не
 * подходит, объявляет `provider: cmd` и держит знание где угодно — движок
 * различает эти два случая одним ключом конфигурации и больше ничем.
 *
 * Три свойства раскладки, ради которых она такая:
 *
 * 1. **Оглавление производно.** Файла индекса в дереве нет; он собирается из
 *    шапок. Рассогласование оглавления с содержимым каталога поэтому
 *    невозможно — целый класс дрейфа исчезает по построению.
 * 2. **Предел кладётся на оглавление, а не на объём знания.** Стоимость новой
 *    единицы для читателя перестаёт быть нулевой, и упёршееся в предел
 *    оглавление вынуждает единицы сливать. Ровно этого не хватает каталогу
 *    спек, где ничто не мешает восемнадцати документам стать сотней.
 * 3. **Устаревшее инвалидируется, а не удаляется.** `status: superseded`
 *    выпадает из оглавления и отбора по области, оставаясь в дереве и в
 *    истории. Знание не теряется, но и не отравляет контекст.
 */

interface Anchor {
  readonly path: string;
  readonly rev: string | undefined;
}

interface Unit {
  /** Путь файла относительно корня репозитория — для диагностики и записи. */
  readonly file: string;
  readonly id: string;
  readonly title: string;
  readonly scope: readonly string[];
  readonly anchors: readonly Anchor[];
  readonly status: 'active' | 'superseded';
  readonly body: string;
}

export interface FsSourceOptions {
  /** Корень репозитория: все пути источника относительны ему. */
  readonly root: string;
  /** Каталог знания, `project.knowledge.dir`. */
  readonly dir: string;
  /** Каталог документов практики спецификации, если она объявлена. */
  readonly specDir?: string | undefined;
  readonly indexMaxTokens: number;
  readonly staleAfterMs: number;
  /** Момент отсчёта просрочки. Параметром — чтобы проверка была проверяемой. */
  readonly now?: number;
}

/**
 * Похожее на ревизию git: от минимального сокращения, которое git принимает,
 * до полного SHA-1.
 */
const HASH = /^[0-9a-f]{4,40}$/i;

export function createFsKnowledgeSource(options: FsSourceOptions): KnowledgeSource {
  return new FsKnowledgeSource(options);
}

class FsKnowledgeSource implements KnowledgeSource {
  private readonly options: FsSourceOptions;

  constructor(options: FsSourceOptions) {
    this.options = options;
  }

  index(): readonly KnowledgeIndexEntry[] {
    const entries: KnowledgeIndexEntry[] = [];

    for (const unit of this.units()) {
      if (unit.status === 'superseded') continue;
      entries.push({ id: unit.id, title: unit.title, scope: [...unit.scope] });
    }

    entries.push(...this.specEntries());
    // Порядок — по идентификатору, а не по обходу файловой системы: он
    // попадает в промпт, а промпт обязан быть посимвольно воспроизводимым.
    return entries.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  select(selector: KnowledgeSelector): readonly KnowledgeEntry[] {
    if (selector.kind === 'index') {
      const text = renderIndex(this.index());
      return [
        {
          id: 'index',
          title: 'Оглавление знания',
          text,
          tokens: estimateTokens(text),
        },
      ];
    }

    const units = this.units();
    const picked: Unit[] = [];

    if (selector.kind === 'id') {
      for (const id of selector.id) {
        // Поимённый запрос достаёт и инвалидированное: человек и агент,
        // назвавшие идентификатор, знают, чего просят, — а вот отбор по
        // области отдавать отменённое не вправе.
        const unit = units.find((candidate) => candidate.id === id);
        if (unit === undefined) {
          throw new StepcastError(`Единица знания не найдена: ${id}`, {
            hint: 'Проверьте идентификатор по оглавлению: stepcast knowledge index',
          });
        }
        if (!picked.includes(unit)) picked.push(unit);
      }
    } else {
      for (const unit of units) {
        if (unit.status === 'superseded') continue;
        if (unit.scope.some((own) => selector.scope.some((asked) => globsIntersect(own, asked)))) {
          picked.push(unit);
        }
      }
      picked.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    }

    const entries: KnowledgeEntry[] = [];
    let spent = 0;
    for (const unit of picked) {
      const tokens = estimateTokens(unit.body);
      // Предел записи режет по границе единицы, а не по середине текста:
      // усечённое знание выглядит целым и потому хуже отсутствующего.
      if (selector.budget !== undefined && spent + tokens > selector.budget && entries.length > 0) {
        continue;
      }
      spent += tokens;
      entries.push({ id: unit.id, title: unit.title, path: unit.file, tokens });
    }
    return entries;
  }

  check(): KnowledgeCheckResponse {
    const problems: KnowledgeProblem[] = [];
    const units = this.units();
    const now = this.options.now ?? Date.now();
    const seen = new Map<string, Unit>();

    for (const unit of units) {
      const twin = seen.get(unit.id);
      if (twin !== undefined) {
        problems.push({
          id: unit.id,
          kind: 'duplicate-id',
          level: 'red',
          detail: `Идентификатор занят: ${twin.file} и ${unit.file}`,
        });
      }
      seen.set(unit.id, unit);

      // Отменённое по якорям не проверяется. Проверять его — значит требовать
      // от инвалидированного утверждения оставаться верным: файл, к которому
      // оно относилось, рано или поздно переименуют или удалят, и архив станет
      // вечно красным. Человека это выталкивает ровно к удалению, которое
      // инвалидация и заводилась заменить. Занятый идентификатор выше
      // проверяется у обоих статусов — по нему отменённое всё ещё достаётся
      // поимённым отбором, и двусмысленность там настоящая.
      if (unit.status === 'superseded') continue;

      for (const anchor of unit.anchors) {
        const absolute = resolvePath(this.options.root, anchor.path);
        if (!exists(absolute)) {
          problems.push({
            id: unit.id,
            kind: 'missing-anchor',
            level: 'red',
            detail: `Якорь указывает в пустоту: ${anchor.path}`,
          });
          continue;
        }

        if (anchor.rev === undefined) continue;

        // Форма ревизии проверяется до чтения истории. Сравнивать с историей
        // непригодное значение нельзя: `startsWith` на мусоре даёт либо
        // ложное «совпало», либо «устарело» с неверной причиной, и опечатка в
        // ревизии становится неотличима от настоящего дрейфа. Жёлтым, а не
        // отказом разбора: похожесть на хеш — догадка, значение может быть
        // тегом или именем ветки, а отказывать по догадке значит учить
        // обходить проверку.
        if (!HASH.test(anchor.rev)) {
          problems.push({
            id: unit.id,
            kind: 'anchor-bad-rev',
            level: 'yellow',
            detail: `Ревизия не похожа на хеш git, устаревание не проверено: ${anchor.path}@${anchor.rev}`,
          });
          continue;
        }

        const last = lastCommit(this.options.root, anchor.path);
        if (last === 'unavailable') {
          // Жёлтым, а не молчанием: устаревание по этому якорю не проверено, и
          // выдавать непроверенное за целое — единственный способ, которым эта
          // проверка может соврать незаметно. Не красным: в репозитории без
          // git это состояние нормы, а не поломка.
          problems.push({
            id: unit.id,
            kind: 'anchor-unknown',
            level: 'yellow',
            detail: `Историю пути прочитать не удалось, устаревание не проверено: ${anchor.path}`,
          });
          continue;
        }
        if (last === 'none') continue;
        if (last.rev.startsWith(anchor.rev) || anchor.rev.startsWith(last.rev)) continue;

        const overdue = now - last.timeMs > this.options.staleAfterMs;
        problems.push({
          id: unit.id,
          kind: 'stale-anchor',
          level: overdue ? 'red' : 'yellow',
          detail: overdue
            ? `Устарело дольше объявленного срока: ${anchor.path} изменён коммитом ${short(last.rev)}`
            : `Задето позже зафиксированного: ${anchor.path} изменён коммитом ${short(last.rev)}`,
        });
      }
    }

    // Одинаковый заголовок при пересекающейся области — почти всегда вторая
    // запись того же утверждения. Предупреждением, а не отказом: похожесть —
    // догадка, и отказывать по догадке значит учить обходить проверку.
    const active = units.filter((unit) => unit.status === 'active');
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const left = active[i] as Unit;
        const right = active[j] as Unit;
        if (left.title !== right.title) continue;
        if (!left.scope.some((own) => right.scope.some((other) => globsIntersect(own, other)))) {
          continue;
        }
        problems.push({
          id: left.id,
          kind: 'duplicate-title',
          level: 'yellow',
          detail: `Тот же заголовок при пересекающейся области: ${right.id}`,
        });
      }
    }

    const indexTokens = estimateTokens(renderIndex(this.index()));
    if (indexTokens > this.options.indexMaxTokens) {
      problems.push({
        kind: 'index-overflow',
        level: 'red',
        detail: `Оглавление ${formatTokens(indexTokens)} против предела ${formatTokens(this.options.indexMaxTokens)} — слейте единицы знания`,
      });
    }

    return { ok: !problems.some((problem) => problem.level === 'red'), problems };
  }

  write(request: KnowledgeWriteRequest): KnowledgeWriteResponse {
    // Второй раз после схемы, и намеренно: здесь идентификатор превращается в
    // путь, и проверка обязана стоять там, где происходит опасное, а не
    // только там, где разбирается запрос. Источник зовут и мимо CLI.
    const validId = KnowledgeIdSchema.safeParse(request.id);
    if (!validId.success) {
      throw new StepcastError(`Недопустимый идентификатор единицы знания: ${request.id}`, {
        at: 'id',
        hint: 'Допустимы буквы, цифры, точка, дефис и подчёркивание; путь не является идентификатором',
      });
    }

    const file = join(this.options.dir, `${request.id}.md`);
    const absolute = resolvePath(this.options.root, file);
    const existed = exists(absolute);

    const anchors = request.anchors.map((path) => {
      const last = lastCommit(this.options.root, path);
      // Ревизия подставляется движком, а не пишущим: она и есть точка, от
      // которой считается устаревание, и доверять её тому, кто пишет
      // утверждение, значит позволить объявить себя вечно свежим. Истории у
      // пути может не быть вовсе — тогда якорь остаётся без ревизии, и
      // устаревание по нему не считается.
      return typeof last === 'string' ? { path } : { path, rev: short(last.rev) };
    });

    const head = {
      id: request.id,
      title: request.title,
      scope: request.scope,
      ...(anchors.length === 0 ? {} : { anchors }),
      status: request.status ?? 'active',
      ...(request.supersedes === undefined ? {} : { supersedes: request.supersedes }),
    };

    const previous = existed ? readFileSync(absolute, 'utf8') : undefined;
    const text = `---\n${stringifyYaml(head)}---\n\n${request.body.trimEnd()}\n`;

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, 'utf8');

    const verdict = this.check();
    if (!verdict.ok) {
      // Откат до состояния «как было»: отказ, оставивший файл, сделал бы
      // следующий вызов check красным по чужой вине, и петля встала бы на
      // мусоре, который сама и создала.
      if (previous === undefined) rmSync(absolute, { force: true });
      else writeFileSync(absolute, previous, 'utf8');
      return { ok: false, problems: verdict.problems.filter((problem) => problem.level === 'red') };
    }

    return { ok: true, path: file, problems: verdict.problems };
  }

  /** Единицы знания в порядке пути: обход файловой системы сам по себе не упорядочен. */
  private units(): readonly Unit[] {
    const root = resolvePath(this.options.root, this.options.dir);
    if (!exists(root)) return [];

    const files = globSync('**/*.md', { cwd: root }) as string[];
    const units: Unit[] = [];

    for (const relativeFile of [...files].sort()) {
      const absolute = join(root, relativeFile);
      const file = toPosix(relative(this.options.root, absolute));
      units.push(parseUnit(readFileSync(absolute, 'utf8'), file));
    }

    return units;
  }

  /**
   * Документы практики спецификации — одной записью на каталог изменения, а
   * не на файл: каталог и есть единица, о существовании которой агент должен
   * узнать, а перечисление его четырёх документов заняло бы вчетверо больше
   * оглавления, не сказав вчетверо больше.
   */
  private specEntries(): readonly KnowledgeIndexEntry[] {
    const specDir = this.options.specDir;
    if (specDir === undefined) return [];

    const root = resolvePath(this.options.root, specDir);
    if (!exists(root)) return [];

    const dirs = (globSync('*/', { cwd: root }) as string[])
      .map((entry) => entry.replace(/\/+$/, ''))
      .sort();

    const entries: KnowledgeIndexEntry[] = [];
    for (const slug of dirs) {
      const title = describeSpecDir(join(root, slug));
      // Каталог без единого документа документом не является. Практика
      // спецификации вольна держать внутри своего каталога что угодно ещё
      // (архив, шаблоны, вложенные каталоги), и перечислять это оглавлению
      // нечем: заголовка у такого каталога нет, а имя каталога заголовком не
      // является — строка `archive — archive` не говорит ничего и место в
      // конечном оглавлении занимает.
      if (title === undefined) continue;
      entries.push({
        id: `spec:${slug}`,
        title,
        scope: [`${toPosix(join(specDir, slug))}/**`],
      });
    }
    return entries;
  }
}

/** Оглавление в том виде, в каком оно уезжает в промпт. */
export function renderIndex(entries: readonly KnowledgeIndexEntry[]): string {
  if (entries.length === 0) return 'Знание репозитория пусто.';

  const lines = entries.map((entry) => {
    const scope = entry.scope.length === 0 ? '' : `  ·  ${entry.scope.join(', ')}`;
    return `${entry.id} — ${entry.title}${scope}`;
  });

  return [
    'Известное по проекту. Тела здесь нет — запрашивайте по идентификатору.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Пересечение двух шаблонов. Сравниваются их дословные приставки — то, что
 * стоит до первого символа шаблона: `src/judge/**` даёт `src/judge`,
 * `src/**` — `src`. Шаблоны пересекаются, когда одна приставка является
 * началом другой по границе сегмента.
 *
 * Правило нарочно грубее точного пересечения языков шаблонов. Точное требует
 * сопоставления с откатом и на практике отвечает на те же вопросы теми же
 * ответами, а объяснить автору пайплайна, почему его область не совпала,
 * можно только правилом, которое он способен применить в уме.
 */
export function globsIntersect(left: string, right: string): boolean {
  if (matchesGlob(left, right) || matchesGlob(right, left)) return true;

  const a = literalPrefix(left);
  const b = literalPrefix(right);
  if (a === '' || b === '') return true;
  return isPrefixPath(a, b) || isPrefixPath(b, a);
}

function literalPrefix(pattern: string): string {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const stop = normalized.search(/[*?[]/);
  const head = stop === -1 ? normalized : normalized.slice(0, stop);
  return head.replace(/\/+$/, '');
}

function isPrefixPath(head: string, path: string): boolean {
  return path === head || path.startsWith(`${head}/`);
}

/** Разбор единицы знания. Неполная шапка — отказ, а не молчаливый пропуск. */
export function parseUnit(text: string, file: string): Unit {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) {
    throw new StepcastError(`Единица знания без шапки: ${file}`, {
      file,
      hint: 'Шапка YAML между строками --- обязательна: id, title, scope, status',
    });
  }

  let head: unknown;
  try {
    head = parseYaml(match[1] as string);
  } catch (error) {
    throw new StepcastError(`Шапка единицы знания не разбирается как YAML: ${file}`, {
      file,
      cause: error,
    });
  }

  if (head === null || typeof head !== 'object') {
    throw new StepcastError(`Шапка единицы знания пуста: ${file}`, { file });
  }

  const raw = head as Record<string, unknown>;
  const id = requireField(raw.id, 'id', file);
  const title = requireField(raw.title, 'title', file);
  const status = raw.status === 'superseded' ? 'superseded' : 'active';
  if (raw.status !== undefined && raw.status !== 'active' && raw.status !== 'superseded') {
    throw new StepcastError(`Неизвестный status единицы знания: ${file}`, {
      file,
      hint: 'Допустимы active и superseded',
    });
  }

  const scope = toStringList(raw.scope, 'scope', file);
  const anchors = toAnchors(raw.anchors, file);

  return { file, id, title, scope, anchors, status, body: (match[2] as string).trim() };
}

/**
 * Название типа значения для отказа разбора.
 *
 * Шапку типизирует YAML, и «поля нет» с «поле есть, но не строка» — разные
 * поломки, требующие разных правок. Сообщать «шапка без id» о единице, где
 * `id: 1234567` объявлен, значит отправить человека искать то, что на месте.
 */
function describeType(value: unknown): string {
  if (value === null) return 'пусто';
  if (Array.isArray(value)) return 'список';
  if (typeof value === 'object') return 'отображение';
  if (typeof value === 'number' || typeof value === 'bigint') return 'число';
  if (typeof value === 'boolean') return 'логическое значение';
  return typeof value;
}

function requireField(value: unknown, name: string, file: string): string {
  if (value === undefined) {
    throw new StepcastError(`Шапка единицы знания без ${name}: ${file}`, { file, at: name });
  }
  if (typeof value !== 'string') {
    throw new StepcastError(`Поле ${name} единицы знания — строка: ${file}`, {
      file,
      at: name,
      hint: `Значение поля ${name} — ${describeType(value)}`,
    });
  }
  if (value.trim() === '') {
    throw new StepcastError(`Шапка единицы знания без ${name}: ${file}`, { file, at: name });
  }
  return value;
}

function toStringList(value: unknown, name: string, file: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new StepcastError(`Поле ${name} единицы знания — список строк: ${file}`, {
      file,
      at: name,
      hint: `Значение поля ${name} — ${describeType(value)}`,
    });
  }
  const wrong = value.findIndex((item) => typeof item !== 'string');
  if (wrong !== -1) {
    throw new StepcastError(`Поле ${name} единицы знания — список строк: ${file}`, {
      file,
      at: name,
      hint: `Элемент списка ${name} — ${describeType(value[wrong])}`,
    });
  }
  return value as string[];
}

function toAnchors(value: unknown, file: string): readonly Anchor[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new StepcastError(`Поле anchors единицы знания — список: ${file}`, {
      file,
      at: 'anchors',
    });
  }

  return value.map((item) => {
    // Строковая форма — якорь без ревизии: путь обязан существовать, но
    // устаревание по нему не считается. Форма законная: не всякое
    // утверждение стареет вместе с файлом, к которому относится.
    if (typeof item === 'string') return { path: item, rev: undefined };
    if (item !== null && typeof item === 'object') {
      const raw = item as Record<string, unknown>;
      if (typeof raw.path === 'string') {
        return { path: raw.path, rev: toRev(raw.rev, file) };
      }
    }
    throw new StepcastError(`Якорь единицы знания без пути: ${file}`, { file, at: 'anchors' });
  });
}

/**
 * Ревизия якоря из шапки YAML.
 *
 * Тип скаляра выбирает YAML, а не автор. Короткий хеш git — семь
 * шестнадцатеричных символов, и из одних цифр он состоит примерно в 3.7 %
 * случаев: `d5f15e2` придёт строкой, `9517869` — числом. Разбор, бравший
 * только строку, превращал второе в `undefined`, а `undefined` в контракте
 * якоря значит ровно обратное — «устаревание по нему не считается». Автор
 * объявлял ревизию, движок её выбрасывал и молчал, и примерно каждый двадцать
 * седьмой якорь не проверялся вовсе. Приведение стоит здесь, а не в
 * загрузчике YAML: строковая схема на всю шапку задела бы и `status`, и любое
 * будущее числовое поле.
 *
 * Приводится только число, а не всё подряд через `String`: `String(true)` дал
 * бы `'true'`, `String(['a'])` — `'a'`, и молчание сменилось бы бессмыслицей.
 * Непригодный тип — отказ, называющий файл и поле. Отсутствие `rev` остаётся
 * законной формой: не всякое утверждение стареет вместе с файлом, и отличать
 * её от испорченной обязано устройство, а не удача.
 */
function toRev(value: unknown, file: string): string | undefined {
  // Пустое значение (`rev:` без ничего) — отказ, а не «якоря без ревизии»:
  // поле объявлено, и молча читать объявленное как необъявленное значит
  // повторять ту же ошибку в мелком.
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new StepcastError(`Ревизия якоря единицы знания — строка: ${file}`, {
    file,
    at: 'anchors.rev',
    hint: `Значение поля rev — ${describeType(value)}`,
  });
}

interface Commit {
  readonly rev: string;
  readonly timeMs: number;
}

/**
 * Последний коммит, тронувший путь.
 *
 * Три исхода, и различать их обязательно. `none` — git ответил пустотой:
 * файл не отслеживается или репозиторий свеж без единого коммита, устаревание
 * по такому якорю просто не считается, и это законно. `unavailable` — git не
 * ответил вовсе: не установлен, каталог не репозиторий, вызов сорвался. Второе
 * молчаливо выдавать за первое нельзя: тогда сорвавшийся вызов превращает
 * настоящее нарушение в «память цела», и проверка врёт ровно тем способом,
 * который никто не заметит.
 */
type CommitLookup = Commit | 'none' | 'unavailable';

function lastCommit(root: string, path: string): CommitLookup {
  let out: string;
  try {
    out = execFileSync('git', ['log', '-1', '--format=%H %ct', '--', path], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unavailable';
  }

  if (out === '') return 'none';
  const [rev, seconds] = out.split(' ');
  if (rev === undefined || seconds === undefined) return 'unavailable';
  return { rev, timeMs: Number(seconds) * 1000 };
}

function short(rev: string): string {
  return rev.slice(0, 7);
}

/** Заголовок каталога изменения: первая содержательная строка его документов. */
function describeSpecDir(dir: string): string | undefined {
  for (const name of ['proposal.md', 'README.md', 'spec.md', 'design.md']) {
    const path = join(dir, name);
    if (!exists(path)) continue;
    const head = readFileSync(path, 'utf8').slice(0, 2000);
    for (const line of head.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
      return clip(trimmed, 80);
    }
  }
  return undefined;
}

/**
 * Обрезка по границе слова. Строка оглавления — заголовок, а не начало
 * абзаца: обрыв посреди слова («но убрать за») не сообщает ничего и занимает
 * место в конечном оглавлении наравне с осмысленным.
 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const lastSpace = head.lastIndexOf(' ');
  return `${(lastSpace > limit / 2 ? head.slice(0, lastSpace) : head).replace(/[,;:—-]+$/, '')}…`;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}
