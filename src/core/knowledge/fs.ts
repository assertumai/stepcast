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
  KnowledgeCheckOptions,
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
 * 2. **Три независимых предела, а не один.** `index_max_tokens` кладётся на
 *    записи единиц знания в оглавлении: стоимость новой единицы для читателя
 *    перестаёт быть нулевой, и упёршееся в предел оглавление вынуждает
 *    единицы сливать — работой слияния петли, жёлтым нарушением, а не
 *    отказом записи. `spec_index_max_tokens` — на производную часть
 *    оглавления (каталоги практики спецификации), число которых память не
 *    контролирует. `unit_max_tokens` — на тело одной единицы, которое
 *    оплачивает каждый отбор по области. Подробности — `docs/knowledge.md`.
 * 3. **Устаревшее инвалидируется, а не удаляется.** `status: superseded`
 *    выпадает из оглавления и отбора по области, оставаясь в дереве и в
 *    истории. Знание не теряется, но и не отравляет контекст.
 */

interface Anchor {
  readonly path: string;
  readonly rev: string | undefined;
  /** Момент, когда расхождение по этому якорю впервые обнаружено. */
  readonly staleSince: number | undefined;
  /** `stale_since` объявлен, но моментом времени не читается (design.md, решение 7). */
  readonly staleSinceInvalid: boolean;
  /**
   * Поддаётся ли отображение этого якоря точечной правке `stale_since`.
   *
   * Считается при разборе, а не в момент записи: иначе якорь, датировать
   * который нельзя, молчал бы у всякого вызова без `record` — а `check` без
   * `record` и есть тот вызов, которым проверку зовут в CI. Признак нужен
   * проверке, а не только записи, и потому живёт рядом с самим якорем.
   */
  readonly datable: boolean;
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

/**
 * Файл, задетый одной записью: что в нём было и что станет. Прежнее состояние
 * `undefined` — файла не было вовсе, и откат его удаляет.
 */
interface TouchedFile {
  readonly absolute: string;
  readonly previous: string | undefined;
  readonly next: string;
}

export interface FsSourceOptions {
  /** Корень репозитория: все пути источника относительны ему. */
  readonly root: string;
  /** Каталог знания, `project.knowledge.dir`. */
  readonly dir: string;
  /** Каталог документов практики спецификации, если она объявлена. */
  readonly specDir?: string | undefined;
  /** Предел на записи единиц знания в оглавлении — дисциплина памяти. */
  readonly indexMaxTokens: number;
  /** Предел на производную часть оглавления — записи каталогов практики спецификации. */
  readonly specIndexMaxTokens: number;
  /** Предел на тело одной единицы знания. */
  readonly unitMaxTokens: number;
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
    const entries = [...this.unitEntries(), ...this.specEntries()];
    // Порядок — по идентификатору, а не по обходу файловой системы: он
    // попадает в промпт, а промпт обязан быть посимвольно воспроизводимым.
    return entries.sort(compareById);
  }

  select(selector: KnowledgeSelector): readonly KnowledgeEntry[] {
    if (selector.kind === 'index') {
      // Глагол `index` (выше) отдаёт список целиком: он обслуживает
      // `stepcast knowledge index`, и человеку в терминале токенов не платят.
      // Здесь же текст уезжает в контекст агентского шага, и производная
      // часть укладывается в свой предел (design.md, решение 3).
      const text = this.renderContextIndex();
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

  check(options?: KnowledgeCheckOptions): KnowledgeCheckResponse {
    const record = options?.record === true;
    const problems: KnowledgeProblem[] = [];
    const units = this.units();
    const now = this.options.now ?? Date.now();
    const seen = new Map<string, Unit>();
    // Собранные по ходу разбора правки дат — по файлу, чтобы применить все
    // правки одной единицы за одно чтение-запись (design.md, решение 2).
    const edits = new Map<string, StaleSinceEdit[]>();
    const scheduleEdit = (file: string, edit: StaleSinceEdit): void => {
      const list = edits.get(file);
      if (list === undefined) edits.set(file, [edit]);
      else list.push(edit);
    };
    // Якорь, отображение которого точечной правке не поддаётся, датировать
    // нечем. Нарушение отдаётся независимо от `record`: иначе `check`,
    // стоящий гейтом без записи, молчал бы о памяти, которую никакой заход
    // петли уже не датирует.
    const undatable = (unit: Unit, anchor: Anchor): void => {
      problems.push({
        id: unit.id,
        kind: 'anchor-not-datable',
        level: 'yellow',
        detail: `Отображение якоря не поддаётся точечной правке, момент обнаружения не датируется: ${unit.file}#${anchor.path}`,
      });
    };

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

      // Тело инвалидированной единицы не проверяется по той же причине, что
      // её якоря: отменённое не попадает ни в оглавление, ни в отбор по
      // области, и потому никем не оплачивается.
      const bodyTokens = estimateTokens(unit.body);
      if (bodyTokens > this.options.unitMaxTokens) {
        problems.push({
          id: unit.id,
          kind: 'unit-too-large',
          level: 'red',
          detail: `Тело единицы ${unit.id}: ${formatTokens(bodyTokens)} против предела ${formatTokens(this.options.unitMaxTokens)} (unit_max_tokens)`,
        });
      }

      for (const anchor of unit.anchors) {
        // Испорченная дата — свойство самой шапки, а не исхода сравнения с
        // историей: она видна и на якоре, ревизия которого совпала, и на
        // якоре с непригодной ревизией, и там, где историю прочитать не
        // удалось. Отдавать её только внутри подтверждённого расхождения
        // значило бы прятать порчу ровно в тех случаях, где её никто и не
        // исправит.
        if (anchor.staleSinceInvalid) {
          problems.push({
            id: unit.id,
            kind: 'anchor-bad-since',
            level: 'yellow',
            detail: `Момент обнаружения не читается как ISO-8601, расхождение считается недатированным: ${unit.file}#${anchor.path}`,
          });
        }

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
        if (last.rev.startsWith(anchor.rev) || anchor.rev.startsWith(last.rev)) {
          // Расхождение, по которому якорь мог быть датирован раньше, больше
          // не существует: оставленная дата сделала бы следующее — новое —
          // расхождение красным в момент возникновения (design.md, решение 6).
          if (anchor.staleSince !== undefined || anchor.staleSinceInvalid) {
            if (!anchor.datable) undatable(unit, anchor);
            else if (record) {
              scheduleEdit(unit.file, { id: unit.id, anchorPath: anchor.path, staleSince: undefined });
            }
          }
          continue;
        }

        // Расхождение подтверждено. Уровень считается не от возраста коммита
        // `last`, а от момента, когда это расхождение впервые увидели
        // (design.md, решение 1): без даты — всегда жёлтое, с датой — жёлтое
        // в пределах `stale_after` и красное за ним.
        const staleSince = anchor.staleSinceInvalid ? undefined : anchor.staleSince;
        const overdue = staleSince !== undefined && now - staleSince > this.options.staleAfterMs;
        problems.push({
          id: unit.id,
          kind: 'stale-anchor',
          level: overdue ? 'red' : 'yellow',
          detail:
            staleSince === undefined
              ? `Задето позже зафиксированного: ${anchor.path} изменён коммитом ${short(last.rev)}`
              : overdue
                ? `Устарело дольше объявленного срока (известно с ${isoSeconds(staleSince)}): ${anchor.path} изменён коммитом ${short(last.rev)}`
                : `Задето позже зафиксированного (известно с ${isoSeconds(staleSince)}): ${anchor.path} изменён коммитом ${short(last.rev)}`,
        });

        // Ставит первый акт датирования, увидевший расхождение без даты;
        // уже поставленную дату повторная правка того же пути не сдвигает
        // (design.md, решение 6) — иначе чужая активность держала бы память
        // вечно жёлтой.
        if (staleSince === undefined) {
          if (!anchor.datable) undatable(unit, anchor);
          else if (record) {
            scheduleEdit(unit.file, { id: unit.id, anchorPath: anchor.path, staleSince: isoSeconds(now) });
          }
        }
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

    // Единицы знания и производная часть меряются раздельно — это и есть суть
    // изменения (design.md, решение 1): дисциплина памяти не должна зависеть
    // от числа открытых изменений, которым пишущий память не управляет.
    // Шапка `renderIndex` (первые две строки) отнесена к единицам знания:
    // слитый текст несёт её один раз, а не дважды, и приписывать её
    // производной части завышало бы её вес без причины.
    const unitEntries = this.unitEntries();
    const unitsTokens = estimateTokens(renderIndex(unitEntries));
    if (unitsTokens > this.options.indexMaxTokens) {
      // Жёлтым, а не красным: переполненное оглавление не сломано, оно полно
      // — отбор работает, тела читаются, единицы на месте. Красным здесь
      // останавливало бы гейт того захода, который переполнения не создавал и
      // снять его не вправе; снимается оно слиянием, работой отдельной от
      // записи (design.md, решение 1).
      problems.push({
        kind: 'index-overflow',
        level: 'yellow',
        detail: `Единицы знания в оглавлении: ${formatTokens(unitsTokens)} против предела ${formatTokens(this.options.indexMaxTokens)} (index_max_tokens) — слейте единицы знания`,
      });
    }

    const specEntriesList = this.specEntries();
    const specTokens = estimateTokens(renderSpecSection(specEntriesList));
    if (specTokens > this.options.specIndexMaxTokens) {
      // Жёлтым, а не красным: закрыть или заархивировать каталоги изменений
      // пишущий память не может, и красное здесь означало бы гейт,
      // невыполнимый иначе как поднятием предела (design.md, решение 2).
      problems.push({
        kind: 'spec-index-overflow',
        level: 'yellow',
        detail: `Каталоги практики спецификации в оглавлении: ${specEntriesList.length} записей, ${formatTokens(specTokens)} против предела ${formatTokens(this.options.specIndexMaxTokens)} (spec_index_max_tokens)`,
      });
    }

    // Запись — после того, как нарушения посчитаны на прочитанном дереве:
    // датирование не должно влиять на исход этого же вызова (design.md,
    // решение 3). Каждый файл читается и пишется ровно раз, всеми своими
    // правками сразу.
    const dated: { id: string; path: string; since: string }[] = [];
    const cleared: { id: string; path: string }[] = [];
    if (record) {
      for (const [file, fileEdits] of edits) {
        const absolute = resolvePath(this.options.root, file);
        const before = readFileSync(absolute, 'utf8');
        const { text: after, failed } = applyStaleSinceEdits(before, fileEdits);
        if (after !== before) writeFileSync(absolute, after, 'utf8');
        // Правка, не удавшаяся вопреки разбору (шапка изменилась между чтением
        // дерева и записью), названа тем же жёлтым нарушением, что и якорь,
        // размеченный недатируемым при разборе: тихо потерянная правка — то
        // самое молчание, ради устранения которого признак и заведён.
        const lost = new Set(failed);
        for (const edit of fileEdits) {
          if (lost.has(edit.anchorPath)) {
            problems.push({
              id: edit.id,
              kind: 'anchor-not-datable',
              level: 'yellow',
              detail: `Отображение якоря не поддаётся точечной правке, момент обнаружения не датируется: ${file}#${edit.anchorPath}`,
            });
          } else if (edit.staleSince === undefined) {
            cleared.push({ id: edit.id, path: edit.anchorPath });
          } else {
            dated.push({ id: edit.id, path: edit.anchorPath, since: edit.staleSince });
          }
        }
      }
    }

    return {
      ok: !problems.some((problem) => problem.level === 'red'),
      problems,
      // Отчёт о правке — только на запрос с `record`: ответ обычной проверки
      // остаётся ровно тем же, каким был до этого изменения.
      ...(record ? { recorded: { dated, cleared } } : {}),
    };
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

    const supersedes = request.supersedes ?? [];
    const file = join(this.options.dir, `${request.id}.md`);
    const absolute = resolvePath(this.options.root, file);

    // Самоотмена, ссылка в пустоту и совпадение путей проверяются раньше, чем
    // тронут первый файл: ни при чтении дерева, ни при `check` этого не видно,
    // а откатывать без единой правки не от чего (design.md, решение 2).
    const problems: KnowledgeProblem[] = [];
    if (supersedes.includes(request.id)) {
      problems.push({
        id: request.id,
        kind: 'supersedes-self',
        level: 'red',
        detail: `Единица не может отменять сама себя полем supersedes: ${request.id}`,
      });
    }
    const unitsById = new Map(this.units().map((unit) => [unit.id, unit]));
    for (const id of supersedes) {
      if (id === request.id) continue;
      const target = unitsById.get(id);
      if (target === undefined) {
        problems.push({
          id,
          kind: 'supersedes-missing',
          level: 'red',
          detail: `supersedes называет единицу, которой в каталоге знания нет: ${id}`,
        });
        continue;
      }
      // Имя файла единицы не обязано совпадать с её идентификатором: `check`
      // этого не требует, и `knowledge/b.md` с `id: a` — законное дерево.
      // Тогда запись единицы `b`, отменяющей `a`, метит в тот же файл двумя
      // разными содержимыми, и любой порядок записи теряет одно из них молча:
      // либо отменённая единица исчезает вместо пометки, либо записанной
      // единицы не оказывается в дереве при зелёном ответе. Отказ, а не выбор
      // порядка: противоречие здесь настоящее, и разрешить его вправе только
      // тот, кто пишет, — переименованием файла или другим идентификатором.
      if (resolvePath(this.options.root, target.file) === absolute) {
        problems.push({
          id,
          kind: 'supersedes-same-file',
          level: 'red',
          detail: `supersedes называет единицу, лежащую в файле записываемой: ${id} в ${target.file}`,
        });
      }
    }
    if (problems.length > 0) return { ok: false, problems };

    // Уже отменённые не трогаются: отмена идемпотентна, а запись их файла
    // ради статуса, который у них и так стоит, была бы лишней правкой дерева.
    const targets = new Map<string, Unit>();
    for (const id of supersedes) {
      const target = unitsById.get(id) as Unit;
      if (target.status === 'active') targets.set(id, target);
    }

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

    const text = `---\n${stringifyYaml(head)}---\n\n${request.body.trimEnd()}\n`;

    // Задетые файлы — одним списком, а не записываемый файл отдельно и
    // отменяемые отдельно: по этому списку идут и запись, и откат, поэтому ни
    // один задетый файл не может быть забыт при откате, а совпадение путей
    // видно по построению — оно отказано выше (design.md, решение 3).
    // Прежнее состояние снимается целиком до первой правки: `undefined`
    // значит «файла не было», и откат такой файл удаляет.
    const touched: TouchedFile[] = [
      {
        absolute,
        previous: exists(absolute) ? readFileSync(absolute, 'utf8') : undefined,
        next: text,
      },
    ];
    for (const target of targets.values()) {
      const targetAbsolute = resolvePath(this.options.root, target.file);
      const previous = readFileSync(targetAbsolute, 'utf8');
      touched.push({
        absolute: targetAbsolute,
        previous,
        next: withSupersededStatus(previous, target.file),
      });
    }

    for (const item of touched) {
      mkdirSync(dirname(item.absolute), { recursive: true });
      writeFileSync(item.absolute, item.next, 'utf8');
    }

    const verdict = this.check();
    if (!verdict.ok) {
      // Откат до состояния «как было» — по каждому задетому файлу: отказ,
      // оставивший половину отменённых единиц без слитой, потерял бы знание
      // тем же способом, против которого инвалидация и заведена (design.md,
      // решение 3).
      for (const item of touched) {
        if (item.previous === undefined) rmSync(item.absolute, { force: true });
        else writeFileSync(item.absolute, item.previous, 'utf8');
      }
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

  /** Записи оглавления по единицам знания — часть, которую держит дисциплина памяти. */
  private unitEntries(): readonly KnowledgeIndexEntry[] {
    const entries: KnowledgeIndexEntry[] = [];
    for (const unit of this.units()) {
      if (unit.status === 'superseded') continue;
      entries.push({ id: unit.id, title: unit.title, scope: [...unit.scope] });
    }
    return entries;
  }

  /**
   * Оглавление для контекста агентского шага: записи единиц знания полностью,
   * записи каталогов практики спецификации — в пределах `specIndexMaxTokens`.
   *
   * Порядок укладки — тот же порядок по идентификатору, каким собрано
   * оглавление: усечение обязано быть посимвольно воспроизводимым, потому что
   * текст уезжает в промпт. Единицы знания в укладке не участвуют вовсе — они
   * показаны все и всегда (design.md, решение 4): усечение спрятало бы
   * нарушение дисциплины, ради которого нарушение и заведено. Уложенные
   * записи каталогов и записи единиц сливаются тем же порядком, каким их
   * сливает глагол `index`.
   */
  private renderContextIndex(): string {
    const unitEntries = this.unitEntries();
    const specEntriesList = this.specEntries();
    if (unitEntries.length === 0 && specEntriesList.length === 0) {
      return 'Знание репозитория пусто.';
    }

    // Укладываются только записи каталогов, и берётся их начало — не
    // «пропустить одну и попробовать следующую»: хвост обязан быть связным,
    // чтобы одна строка могла честно назвать всё, чего в списке нет.
    const shown = this.fitSpecEntries(specEntriesList);
    const hidden = specEntriesList.length - shown;

    const lines = [...unitEntries, ...specEntriesList.slice(0, shown)]
      .sort(compareById)
      .map(renderEntryLine);
    if (hidden > 0) lines.push(this.specTailLine(hidden));

    return [
      'Известное по проекту. Тела здесь нет — запрашивайте по идентификатору.',
      '',
      ...lines,
    ].join('\n');
  }

  /**
   * Сколько записей каталогов помещается в `spec_index_max_tokens`.
   *
   * Мера здесь — та же, что у нарушения `spec-index-overflow`: токены целого
   * текста секции, а не сумма построчных замеров. Меры обязаны совпадать:
   * каждый построчный `estimateTokens` округляет вверх, сумма округлений
   * систематически больше цельного замера, и между двумя порогами открылась бы
   * полоса, где отбор уже усекает, а `check` молчит, — предел срабатывал бы
   * молча для того, кто его настраивает.
   */
  private fitSpecEntries(entries: readonly KnowledgeIndexEntry[]): number {
    const limit = this.options.specIndexMaxTokens;
    if (estimateTokens(renderSpecSection(entries)) <= limit) return entries.length;

    // Хвостовая строка — часть той же секции, и место под неё резервируется до
    // укладки: иначе текст выходил бы за предел ровно на её размер. Резерв
    // считается по наибольшему возможному числу скрытых записей: точное число
    // известно только после укладки, а укладка не вправе зависеть от того, чем
    // сама кончится. Разница — единицы символов в записи числа.
    //
    // Предел меньше самой хвостовой строки оставляет отрицательный остаток, и
    // тогда не показывается ни одна запись каталога, а строка всё равно
    // выводится: она — единственное, что отличает усечение от молчаливой
    // пропажи, и выбрасывать её ради соблюдения предела значит менять его
    // соблюдение на ложь о полноте списка.
    const budget = limit - estimateTokens(`\n${this.specTailLine(entries.length)}`);

    let shown = 0;
    for (let count = 1; count <= entries.length; count += 1) {
      if (estimateTokens(renderSpecSection(entries.slice(0, count))) > budget) break;
      shown = count;
    }
    return shown;
  }

  /** Хвост усечённой производной части: чего в списке нет и где лежит полный. */
  private specTailLine(hidden: number): string {
    return `… не показано ещё ${hidden} записей каталогов практики спецификации в ${this.options.specDir ?? ''} — полный список: stepcast knowledge index`;
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

/**
 * Текст производной части оглавления — то, чем её меряют и нарушение
 * `spec-index-overflow`, и укладка отбора. Функция общая нарочно: два разных
 * замера одной величины разошлись бы округлением (см. `fitSpecEntries`).
 */
function renderSpecSection(entries: readonly KnowledgeIndexEntry[]): string {
  return entries.map(renderEntryLine).join('\n');
}

/** Строка одной записи оглавления — общая для полного и усечённого текста. */
function renderEntryLine(entry: KnowledgeIndexEntry): string {
  const scope = entry.scope.length === 0 ? '' : `  ·  ${entry.scope.join(', ')}`;
  return `${entry.id} — ${entry.title}${scope}`;
}

/** Порядок по идентификатору — не по обходу файловой системы: он попадает в промпт. */
function compareById(left: KnowledgeIndexEntry, right: KnowledgeIndexEntry): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Оглавление в том виде, в каком его отдаёт глагол `index`: список целиком,
 * без усечения. Отбор `select({ kind: 'index' })`, чей текст уезжает в
 * контекст агентского шага, использует другой путь построения — приватный
 * `renderContextIndex` источника `fs` — потому что производная часть там
 * укладывается в свой предел (design.md, решение 3).
 */
export function renderIndex(entries: readonly KnowledgeIndexEntry[]): string {
  if (entries.length === 0) return 'Знание репозитория пусто.';

  return [
    'Известное по проекту. Тела здесь нет — запрашивайте по идентификатору.',
    '',
    ...entries.map(renderEntryLine),
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

const HEAD_BOUNDARY = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?[\s\S]*)$/;

/**
 * Отмена единицы точечной правкой шапки: строка `status` меняется на
 * `superseded`, а тело, заголовок, область и якоря (включая их ревизии)
 * остаются байт в байт прежними. YAML не пересериализуется — знание не
 * зависит от того, дословно ли движок воспроизводит чужой текст (design.md,
 * решение 2).
 */
function withSupersededStatus(text: string, file: string): string {
  const match = HEAD_BOUNDARY.exec(text);
  if (match === null) {
    throw new StepcastError(`Единица знания без шапки: ${file}`, { file });
  }
  const [open, header, rest] = [match[1], match[2], match[3]] as [string, string, string];
  const statusLine = /^status:.*$/m;
  const nextHeader = statusLine.test(header)
    ? header.replace(statusLine, 'status: superseded')
    : `${header}\nstatus: superseded`;
  return `${open}${nextHeader}${rest}`;
}

/** Требуемая правка одного якоря: `undefined` значит «удалить строку». */
interface StaleSinceEdit {
  /** Единица, которой принадлежит якорь, — для отчёта о правке. */
  readonly id: string;
  readonly anchorPath: string;
  readonly staleSince: string | undefined;
}

/** Один элемент списка `anchors:`, найденный построчным разбором шапки. */
interface AnchorItem {
  readonly pathValue: string | undefined;
  /** Индекс первой строки элемента (с дефисом) в массиве строк шапки. */
  readonly start: number;
  /** Индекс строки, следующей за последней строкой элемента. */
  readonly end: number;
  /** Годится ли элемент для точечной правки: блочное отображение, не поток. */
  readonly editable: boolean;
  /** Отступ вложенных полей — колонка, с которой пишется новая строка `stale_since`. */
  readonly fieldIndent: number;
  /** Индекс существующей строки `stale_since`, если она уже есть. */
  readonly staleSinceLine: number | undefined;
}

function indentOf(line: string): number {
  return (/^ */.exec(line)?.[0] ?? '').length;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Разбор списка `anchors:` на отдельные элементы, построчно.
 *
 * Понимает ровно ту раскладку, которую пишет `write` и явно называет
 * design.md: блочное отображение вида `- path: …` с полями на той же или
 * последующих строках, тем же отступом. Всё, что этой раскладке не
 * соответствует — потоковое `{path: …}`, голый скаляр без ревизии, поле не
 * первым, — размечается `editable: false`, а не додумывается: лучше не
 * датировать, чем угадать не туда и испортить чужую шапку.
 */
function parseAnchorItems(lines: readonly string[], anchorsIndex: number): readonly AnchorItem[] {
  const anchorsIndent = indentOf(lines[anchorsIndex] as string);

  let cursor = anchorsIndex + 1;
  while (cursor < lines.length && (lines[cursor] as string).trim() === '') cursor += 1;
  if (cursor >= lines.length) return [];

  const listIndent = indentOf(lines[cursor] as string);
  if (listIndent <= anchorsIndent || !/^\s*-(\s|$)/.test(lines[cursor] as string)) return [];

  const items: AnchorItem[] = [];
  let i = cursor;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent <= anchorsIndent) break;
    if (lineIndent !== listIndent || !/^\s*-(\s|$)/.test(line)) break;

    const dashMatch = /^( *)-\s?(.*)$/.exec(line);
    if (dashMatch === null) break;
    const dashIndent = (dashMatch[1] as string).length;
    const rest = (dashMatch[2] as string).trim();

    let end = i + 1;
    while (end < lines.length && (lines[end] as string).trim() !== '' && indentOf(lines[end] as string) > listIndent) {
      end += 1;
    }

    let pathValue: string | undefined;
    let editable = false;
    let fieldIndent = dashIndent + 2;

    if (rest.startsWith('{') || rest.startsWith('[')) {
      // Поток — не редактируется точечно; путь достаётся только для того,
      // чтобы уметь назвать этот якорь неудавшейся правкой, а не потерять его.
      const flowPath = /path:\s*([^,}\s]+)/.exec(rest);
      pathValue = flowPath === null ? undefined : unquote(flowPath[1] as string);
    } else if (rest === '') {
      const fieldLine = lines[i + 1];
      if (fieldLine !== undefined && indentOf(fieldLine) > listIndent) {
        fieldIndent = indentOf(fieldLine);
        const pathField = /^path:\s*(.*)$/.exec(fieldLine.slice(fieldIndent));
        if (pathField !== null) {
          pathValue = unquote(pathField[1] as string);
          editable = true;
        }
      }
    } else {
      const pathField = /^path:\s*(.*)$/.exec(rest);
      if (pathField !== null) {
        pathValue = unquote(pathField[1] as string);
        editable = true;
      } else if (!rest.includes(':')) {
        // Голый скаляр — якорь без ревизии; отображением он не является, и
        // добавить поле в него значило бы переформатировать чужую строку.
        pathValue = unquote(rest);
      }
    }

    let staleSinceLine: number | undefined;
    if (editable) {
      for (let j = i + 1; j < end; j += 1) {
        if (indentOf(lines[j] as string) !== fieldIndent) {
          // Не плоское отображение (вложенный блок, многострочный скаляр) —
          // безопаснее промолчать, чем гадать, куда вписывать поле.
          editable = false;
          break;
        }
        if (/^\s*stale_since:/.test(lines[j] as string)) staleSinceLine = j;
      }
    }

    items.push({ pathValue, start: i, end, editable, fieldIndent, staleSinceLine });
    i = end;
  }

  return items;
}

/**
 * Точечная правка `stale_since` во всех задетых якорях одной единицы за одно
 * чтение текста: строка вписывается, заменяется или удаляется с отступом её
 * якоря, а тело, заголовок, область, статус и прочие поля остаются байт в
 * байт прежними — тот же приём, что у `withSupersededStatus`, — YAML не
 * пересериализуется.
 *
 * Якорь, чьё отображение не поддаётся такой правке (поток, необычная
 * раскладка), попадает в `failed`, и вызывающий его не датирует: расхождение
 * остаётся жёлтым сколь угодно долго (design.md, решение 7) — это честнее,
 * чем переписать набранную человеком шапку.
 */
function applyStaleSinceEdits(
  text: string,
  edits: readonly StaleSinceEdit[],
): { readonly text: string; readonly failed: readonly string[] } {
  const match = HEAD_BOUNDARY.exec(text);
  if (match === null) return { text, failed: edits.map((edit) => edit.anchorPath) };
  const [open, header, rest] = [match[1], match[2], match[3]] as [string, string, string];
  const lineEnding = header.includes('\r\n') ? '\r\n' : '\n';
  const lines = header.split(/\r?\n/);

  const anchorsIndex = lines.findIndex((line) => /^anchors:\s*$/.test(line));
  const items = anchorsIndex === -1 ? [] : parseAnchorItems(lines, anchorsIndex);

  // Снизу вверх: правка более раннего элемента списка не сдвигает индексы
  // элементов, идущих ниже него, которые уже обработаны.
  const order = [...edits].sort((a, b) => {
    const ai = items.find((item) => item.pathValue === a.anchorPath)?.start ?? -1;
    const bi = items.find((item) => item.pathValue === b.anchorPath)?.start ?? -1;
    return bi - ai;
  });

  const failed: string[] = [];
  for (const edit of order) {
    const item = items.find((candidate) => candidate.pathValue === edit.anchorPath);
    if (item === undefined || !item.editable) {
      failed.push(edit.anchorPath);
      continue;
    }
    const indent = ' '.repeat(item.fieldIndent);
    if (edit.staleSince === undefined) {
      if (item.staleSinceLine !== undefined) lines.splice(item.staleSinceLine, 1);
    } else if (item.staleSinceLine !== undefined) {
      lines[item.staleSinceLine] = `${indent}stale_since: ${edit.staleSince}`;
    } else {
      lines.splice(item.end, 0, `${indent}stale_since: ${edit.staleSince}`);
    }
  }

  return { text: `${open}${lines.join(lineEnding)}${rest}`, failed };
}

/** ISO-8601 в UTC с точностью до секунды — форма, в которой пишется `stale_since`. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
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
  const anchors = toAnchors(raw.anchors, file, datableAnchorPaths(match[1] as string));

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

function toAnchors(value: unknown, file: string, datable: ReadonlySet<string>): readonly Anchor[] {
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
    if (typeof item === 'string') {
      return {
        path: item,
        rev: undefined,
        staleSince: undefined,
        staleSinceInvalid: false,
        datable: datable.has(item),
      };
    }
    if (item !== null && typeof item === 'object') {
      const raw = item as Record<string, unknown>;
      if (typeof raw.path === 'string') {
        const { staleSince, invalid } = toStaleSince(raw.stale_since);
        return {
          path: raw.path,
          rev: toRev(raw.rev, file),
          staleSince,
          staleSinceInvalid: invalid,
          datable: datable.has(raw.path),
        };
      }
    }
    throw new StepcastError(`Якорь единицы знания без пути: ${file}`, { file, at: 'anchors' });
  });
}

/**
 * Пути тех якорей шапки, чьё отображение поддаётся точечной правке
 * `stale_since`, — построчным разбором того же текста, который потом правит
 * `applyStaleSinceEdits`, и ровно теми же правилами.
 *
 * Разбирается при чтении единицы, а не при записи: якорь, датировать который
 * нельзя, обязан быть виден жёлтым нарушением и у `check` без `record` —
 * именно им проверка стоит гейтом, и молчать перед ним значило бы прятать
 * тихую деградацию памяти.
 */
function datableAnchorPaths(header: string): ReadonlySet<string> {
  const lines = header.split(/\r?\n/);
  const anchorsIndex = lines.findIndex((line) => /^anchors:\s*$/.test(line));
  if (anchorsIndex === -1) return new Set();
  const paths = new Set<string>();
  for (const item of parseAnchorItems(lines, anchorsIndex)) {
    if (item.editable && item.pathValue !== undefined) paths.add(item.pathValue);
  }
  return paths;
}

/**
 * Момент обнаружения расхождения из шапки YAML.
 *
 * В отличие от `toRev`, непригодное значение здесь не отказ разбора, а
 * пометка порчи (design.md, решение 7): у `stale_since` есть безопасное
 * прочтение — «не датировано», оставляющее нарушение жёлтым и видимым, — а
 * `parseUnit` зовётся из всех четырёх глаголов источника, и отказ здесь
 * обрушил бы вместе с проверкой ещё и отбор, и оглавление.
 *
 * `yaml` не резолвит ISO-подобные строки во `Date` (в отличие от `js-yaml`),
 * так что обычная запись `stale_since: 2026-09-06T09:12:33Z` приходит сюда
 * строкой; типы, строкой не являющиеся (число, логическое значение,
 * отображение), считаются порчей наравне с нечитаемой строкой.
 */
function toStaleSince(value: unknown): { readonly staleSince: number | undefined; readonly invalid: boolean } {
  if (value === undefined) return { staleSince: undefined, invalid: false };
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return { staleSince: parsed, invalid: false };
  }
  return { staleSince: undefined, invalid: true };
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
