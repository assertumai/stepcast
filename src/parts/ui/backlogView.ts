import { withCurrentOption, type FilterOption } from './filters.js';

/**
 * Тот же закрытый перечень, что `BACKLOG_STATUSES`
 * (`src/parts/pipeline/domain/backlog/schema.ts:19`), не импортированный оттуда: та схема тянет
 * `node:path` для проверки других полей, а этот модуль обязан собираться в
 * браузер (`vite.config.ts`) без модулей рантайма Node.
 *
 * Копия сторожится тестом: `test/ui-backlog-view.test.ts` идёт в Node, схему
 * импортировать может и сверяет оба перечня. Без этой сверки новый статус
 * формата выпал бы из меню фильтра и из подсчёта молча — пункты с ним остались
 * бы видны в умолчании, а фильтр работал бы наполовину вместо внятного отказа.
 */
export const BACKLOG_STATUSES = ['todo', 'in_progress', 'done', 'failed'] as const;

/**
 * Отбор, нумерация и порядок списка очереди улучшений на экране «Бэклог».
 *
 * Живёт рядом с `runsView.ts` и по той же причине: `.tsx` в этом репозитории
 * не тестируется вовсе, а что показано и в каком порядке — смысл экрана, а не
 * оформление, и должно проверяться обычным тестом. Модуль чист: ни React, ни
 * `window`, ни чтения диска — серверный `src/parts/ui/backlog.ts` (он читает диск)
 * сюда не входит и браузеру не отдаётся.
 *
 * Типы описаны здесь структурно, в объёме, нужном отбору: между витриной и
 * демоном лежит JSON (`ui/src/api.ts`), и модулю не нужны поля, по которым он
 * не фильтрует и не сортирует.
 */

export interface BacklogItemLike {
  readonly slug: string;
  readonly status: string;
}

/** Отбор не смотрит внутрь отказа — ему важно только, есть ли он у файла. */
export interface BacklogFailureLike {
  readonly error: string;
}

export interface BacklogSectionLike<I extends BacklogItemLike, F extends BacklogFailureLike = BacklogFailureLike> {
  readonly projectKey: string;
  readonly projectPath: string;
  /** Пункты в порядке файла — тот же порядок, из которого выводится плановый номер. */
  readonly items: readonly I[];
  /**
   * Отказ разбора — по одному на не разобравшийся файл очереди проекта.
   * Раздел с непустым списком не то же самое, что раздел с пустым файлом, и
   * может нести пункты одного файла наравне с отказом другого.
   */
  readonly failures?: readonly F[];
}

/** Пункт с плановым номером — местом в файле своего проекта, считая с единицы. */
export interface NumberedItem<I extends BacklogItemLike> {
  readonly planNumber: number;
  readonly item: I;
}

export interface BacklogSectionView<I extends BacklogItemLike, F extends BacklogFailureLike = BacklogFailureLike> {
  readonly projectKey: string;
  readonly projectPath: string;
  readonly failures: readonly F[];
  readonly items: readonly NumberedItem<I>[];
}

/** Фильтры объединяются по «и»; отсутствующее поле означает «все». */
export interface BacklogFilters {
  readonly status?: string;
  readonly project?: string;
}

export const EMPTY_BACKLOG_FILTERS: BacklogFilters = {};

export type BacklogOrderDirection = 'asc' | 'desc';

/** Умолчание — порядок файла (design.md, Решение 2): `asc` по плановому номеру. */
export const DEFAULT_ORDER: BacklogOrderDirection = 'asc';

export interface StatusCount {
  readonly status: string;
  readonly count: number;
}

export interface BacklogView<I extends BacklogItemLike, F extends BacklogFailureLike = BacklogFailureLike> {
  readonly sections: readonly BacklogSectionView<I, F>[];
  /** Все четыре статуса формата очереди — всегда, с числом пунктов, посчитанным по остальным действующим фильтрам. */
  readonly statusCounts: readonly StatusCount[];
  readonly projectOptions: readonly FilterOption[];
  readonly shown: number;
  readonly total: number;
}

/**
 * Плановый номер присваивается по всем пунктам раздела, до всякого отбора и
 * порядка: пропуск в номерах при суженном списке — не изъян показа, а само
 * сообщение о том, что между показанными пунктами в плане стоят другие
 * (design.md, Решение 1).
 */
function numberSection<I extends BacklogItemLike>(items: readonly I[]): NumberedItem<I>[] {
  return items.map((item, index) => ({ planNumber: index + 1, item }));
}

function matchesStatus<I extends BacklogItemLike>(numbered: NumberedItem<I>, filters: BacklogFilters): boolean {
  return filters.status === undefined || numbered.item.status === filters.status;
}

/** Значения фильтра проектов — из пришедших разделов, с текущим выбором внутри (Решение 6). */
function projectOptionsOf<I extends BacklogItemLike, F extends BacklogFailureLike>(
  sections: readonly BacklogSectionLike<I, F>[],
  filters: BacklogFilters,
): readonly FilterOption[] {
  const base = sections.map((section) => ({ value: section.projectKey, label: section.projectPath }));
  return withCurrentOption(base, filters.project, (value) => value);
}

/**
 * Пункты очереди, отобранные, пронумерованные и упорядоченные разделами по
 * проекту, — вид, который рисует экран «Бэклог».
 */
export function viewBacklog<I extends BacklogItemLike, F extends BacklogFailureLike>(
  allSections: readonly BacklogSectionLike<I, F>[],
  filters: BacklogFilters,
  order: BacklogOrderDirection = DEFAULT_ORDER,
): BacklogView<I, F> {
  const projectOptions = projectOptionsOf(allSections, filters);

  // Отбор по проекту сужает набор разделов; порядок разделов между собой —
  // прежний, тот, в каком проекты идут в обзоре (design.md, Решение 3).
  const inScope = allSections.filter(
    (section) => filters.project === undefined || section.projectKey === filters.project,
  );

  // Числа по статусам считаются по пунктам, прошедшим остальные действующие
  // фильтры, чтобы совпадать с тем, что даст выбор (design.md, Решение 4):
  // отбор по проекту уже сузил `inScope`, а сам статус здесь не применяется —
  // иначе каждое значение меню называло бы число только себе самому. Пункты
  // берутся как есть: раздел с отказом одного файла несёт пункты другого, и
  // они считаются наравне с прочими.
  const countsByStatus = new Map<string, number>(BACKLOG_STATUSES.map((status) => [status, 0]));
  for (const section of inScope) {
    for (const item of section.items) {
      const count = countsByStatus.get(item.status);
      if (count !== undefined) countsByStatus.set(item.status, count + 1);
    }
  }
  const statusCounts: StatusCount[] = BACKLOG_STATUSES.map((status) => ({
    status,
    count: countsByStatus.get(status) ?? 0,
  }));

  // Знаменатель «показано N из M» — все пункты всех пришедших очередей, до
  // всякого отбора, в том числе отсечённых фильтром по проекту: эта пара чисел
  // отвечает на вопрос «сколько очереди сейчас не видно», а фильтр по проекту
  // прячет пункты ровно так же, как фильтр по статусу. Числа у значений
  // статуса считаются иначе и по делу — они отвечают на другой вопрос,
  // «сколько строк даст это нажатие» (design.md, Решение 4).
  let total = 0;
  for (const section of allSections) total += section.items.length;

  let shown = 0;
  const sections: BacklogSectionView<I, F>[] = [];
  for (const section of inScope) {
    const failures = section.failures ?? [];
    const hasFailures = failures.length > 0;

    if (section.items.length === 0) {
      // Файл пуст либо не читается вовсе — в обоих случаях пунктов нет.
      // Отказ переживает любой выбранный статус: скрытие выдало бы сломанную
      // очередь за очередь без пунктов этого статуса (design.md, Решение 7).
      // Раздел без отказов суженный статус прячет вместе с прочими непопавшими.
      if (!hasFailures && filters.status !== undefined) continue;
      sections.push({ projectKey: section.projectKey, projectPath: section.projectPath, failures, items: [] });
      continue;
    }

    const numbered = numberSection(section.items).filter((entry) => matchesStatus(entry, filters));
    // Суженный статус, не оставивший в разделе ни одного пункта, прячет его
    // тем же правилом, что и пустой файл: сообщение «пусто» верно про файл, а
    // не про отбор, и повторённое в каждом непопавшем разделе — шум
    // (design.md, Решение 7; требование «Сломанная очередь не скрывается
    // фильтром по статусу»). Раздел с отказом хотя бы одного файла остаётся
    // видимым и без пунктов, подошедших фильтру, — отказ сам по себе причина
    // не прятать раздел.
    if (numbered.length === 0 && !hasFailures) continue;
    const ordered = order === 'asc' ? numbered : [...numbered].reverse();
    shown += ordered.length;
    sections.push({ projectKey: section.projectKey, projectPath: section.projectPath, failures, items: ordered });
  }

  return { sections, statusCounts, projectOptions, shown, total };
}
