import { isSafeSegment } from '../../ui/routes.js';

/**
 * Модель записи очереди предложений и разбор её цели — чистый модуль без
 * `node:*`, общий команде (`stepcast propose`), демону (`src/ui/screens/
 * proposals/server.ts`) и браузеру (`ui/src/screens/proposals.tsx`)
 * (`ui-proposals`, design.md Решение 1, 3).
 *
 * Чтение каталога, приведение цели к реальному пути и запись — забота
 * `src/core/proposals/store.ts` (модуля с диском); этот модуль знает только
 * форму записи и то, какая строка вправе быть целью.
 */

export type ProposalAction = 'create' | 'update';
export type ProposalState = 'pending' | 'accepted' | 'rejected';

/** Отпечаток файла цели на момент постановки — `null`, если файла ещё не было (действие `create`). */
export interface ProposalFingerprint {
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * Происхождение предложения — прогон, работа и шаг; пусто, если команда
 * вызвана вне прогона. Необязательные поля несут явный `| undefined` — та же
 * форма, что выводит `z.string().optional()` в `store.ts`: запись читается из
 * диска зодом, и второй, слегка другой контур того же типа расходился бы с
 * ним при `exactOptionalPropertyTypes`.
 */
export interface ProposalOrigin {
  readonly run?: string | undefined;
  readonly job?: string | undefined;
  readonly step?: string | undefined;
}

/** Запись очереди предложений (`ui-proposals`, Решение 1, 5, 6). */
export interface ProposalRecord {
  readonly id: string;
  readonly target: string;
  readonly action: ProposalAction;
  readonly content: string;
  readonly reason?: string | undefined;
  readonly origin: ProposalOrigin;
  readonly baseFingerprint: ProposalFingerprint | null;
  readonly state: ProposalState;
  /** Момент постановки — не входит в `<id>` буквально, но совпадает с его временной частью. */
  readonly createdAt: string;
  /** Момент решения — определён тогда и только тогда, когда `state` не `pending`. */
  readonly decidedAt?: string | undefined;
}

/** Отказ разбора или проверки цели/содержимого — вызывающий (`store.ts`, CLI) заворачивает его в свою форму отказа. */
export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalError';
  }
}

/** Предел содержимого записи (`ui-proposals`, «Слишком большое содержимое не встаёт в очередь»). */
export const PROPOSAL_MAX_CONTENT_BYTES = 256 * 1024;

/** Размер строки в байтах UTF-8 — тем же счётом, каким его увидит файл на диске. */
export function contentByteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

/** Отказ, если содержимое превышает предел записи, с названным пределом в тексте. */
export function checkProposalContentSize(content: string): void {
  const size = contentByteLength(content);
  if (size > PROPOSAL_MAX_CONTENT_BYTES) {
    throw new ProposalError(
      `Содержимое предложения весит ${size} байт — больше предела записи очереди (${PROPOSAL_MAX_CONTENT_BYTES} байт, 256 КиБ)`,
    );
  }
}

export type ProposalTargetKind = 'widget' | 'dashboard' | 'plugin';

/** Цель, разобранная на вид кабинета и сегменты пути внутри `.stepcast/` (`ui-proposals`, Решение 3). */
export interface ParsedProposalTarget {
  readonly kind: ProposalTargetKind;
  /** Сегменты пути внутри `.stepcast/`, например `['widgets', 'clock.tsx']`. */
  readonly segments: readonly string[];
  /** Идентификатор виджета, дашборда или плагина — второй сегмент без расширения. */
  readonly id: string;
}

const STEPCAST_PREFIX = '.stepcast/';
const WIDGETS_DIR = 'widgets';
const DASHBOARDS_DIR = 'dashboards';
const PLUGINS_DIR = 'plugins';
const WIDGET_EXTENSION = '.tsx';
const DASHBOARD_EXTENSION = '.yml';

function stripExtension(name: string, extension: string): string | undefined {
  if (!name.endsWith(extension) || name.length === extension.length) return undefined;
  return name.slice(0, -extension.length);
}

/**
 * Разобрать и проверить цель предложения: ровно один из трёх видов кабинета,
 * каждый сегмент — безопасный сегмент пути (`isSafeSegment`, тот же предикат,
 * что и у адресов витрины), итоговая форма — расширение и глубина по правилам
 * читателя (`ui-proposals`, «Целью предложения вправе быть только файл
 * кабинета проекта»). Приведение к реальному пути и проверка символической
 * ссылки — не здесь: цель проверяется как строка, диск смотрит `store.ts`.
 */
export function parseProposalTarget(target: string): ParsedProposalTarget {
  if (!target.startsWith(STEPCAST_PREFIX)) {
    throw new ProposalError(
      `Цель ${target} вне кабинета проекта: допустимы только .stepcast/widgets/<id>.tsx, .stepcast/dashboards/<id>.yml и файл внутри .stepcast/plugins/<id>/`,
    );
  }

  const segments = target.slice(STEPCAST_PREFIX.length).split('/');
  if (segments.some((segment) => !isSafeSegment(segment))) {
    throw new ProposalError(`Цель ${target} несёт недопустимый сегмент пути`);
  }

  if (segments.length === 2 && segments[0] === WIDGETS_DIR) {
    const id = stripExtension(segments[1] as string, WIDGET_EXTENSION);
    if (id !== undefined) return { kind: 'widget', segments, id };
  }

  if (segments.length === 2 && segments[0] === DASHBOARDS_DIR) {
    const id = stripExtension(segments[1] as string, DASHBOARD_EXTENSION);
    if (id !== undefined) return { kind: 'dashboard', segments, id };
  }

  if (segments.length >= 3 && segments[0] === PLUGINS_DIR) {
    return { kind: 'plugin', segments, id: segments[1] as string };
  }

  throw new ProposalError(
    `Цель ${target} не считается ни виджетом (.stepcast/widgets/<id>.tsx, непосредственно в каталоге), ` +
      `ни дашбордом (.stepcast/dashboards/<id>.yml, непосредственно в каталоге), ни файлом плагина ` +
      `(.stepcast/plugins/<id>/…, на любой глубине)`,
  );
}

/** Момент постановки, свёрнутый в сегмент имени файла — тем же форматом, что и штамп идентификатора прогона. */
function timestampSegment(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}

/** Цель, свёрнутая в сегмент имени файла: путь внутри `.stepcast/` без расширения последнего сегмента, через дефис. */
function targetSegment(parsed: ParsedProposalTarget): string {
  const parts = [...parsed.segments];
  const last = parts[parts.length - 1] as string;
  const dot = last.lastIndexOf('.');
  parts[parts.length - 1] = dot <= 0 ? last : last.slice(0, dot);
  return parts.join('-');
}

/**
 * `<id>` записи — момент постановки первым, чтобы сортировка имён файлов была
 * порядком очереди, и цель вторым, чтобы каталог читался `ls` (`ui-proposals`,
 * Решение 1).
 *
 * Штамп — до секунды, поэтому два предложения одной цели в пределах одной
 * секунды дают одинаковое имя. Разводит их хранилище (`freeProposalId`,
 * `store.ts`) суффиксом `-2`: уникальность требует взгляда на каталог, а у
 * чистого модуля диска нет.
 */
export function buildProposalId(now: Date, target: string): string {
  const parsed = parseProposalTarget(target);
  return `${timestampSegment(now)}-${targetSegment(parsed)}`;
}

export function proposalFileName(id: string): string {
  return `${id}.json`;
}
