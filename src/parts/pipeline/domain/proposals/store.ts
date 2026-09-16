import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { z } from 'zod';

import { StepcastError } from '../../../../kernel/errors.js';
import { atomicWrite } from '../../run/journal/writer.js';
import {
  PROPOSAL_MAX_CONTENT_BYTES,
  ProposalError,
  buildProposalId,
  checkProposalContentSize,
  parseProposalTarget,
  proposalFileName,
  type ProposalAction,
  type ProposalFingerprint,
  type ProposalOrigin,
  type ProposalRecord,
  type ProposalState,
} from './entry.js';

/**
 * Хранилище очереди предложений — модуль с диском: чтение каталога `<проект>/
 * .stepcast/proposals/`, приведение цели к реальному пути, постановка,
 * решение и запись цели (`ui-proposals`, design.md Решение 1, 3, 5, 6).
 * Форма записи и проверка цели как строки — в `./entry.js`, чистом модуле без
 * `node:*`, чей `ProposalError` здесь же переводится в `StepcastError`: у
 * этого модуля есть диск и файл, к которому привязать отказ, у entry.ts — нет.
 */

/** Перевести `ProposalError` чистого модуля в `StepcastError` с местом отказа. */
function callEntry<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ProposalError) throw new StepcastError(error.message);
    throw error;
  }
}

const PROPOSALS_DIR_NAME = 'proposals';
const CABINET_DIR_NAME = '.stepcast';

export function proposalsDirPath(projectPath: string): string {
  return join(projectPath, CABINET_DIR_NAME, PROPOSALS_DIR_NAME);
}

function proposalRecordPath(projectPath: string, id: string): string {
  return join(proposalsDirPath(projectPath), proposalFileName(id));
}

const ProposalFingerprintSchema = z.object({ mtimeMs: z.number(), size: z.number() }).strict();

const ProposalOriginSchema = z
  .object({
    run: z.string().optional(),
    job: z.string().optional(),
    step: z.string().optional(),
  })
  .strict();

/** Форма файла записи на диске (`ui-proposals`, «Единственный писатель очереди»): неразбираемый файл — негодная запись, не отказ чтения каталога целиком. */
export const ProposalRecordSchema = z
  .object({
    id: z.string().min(1),
    target: z.string().min(1),
    action: z.union([z.literal('create'), z.literal('update')]),
    content: z.string(),
    reason: z.string().optional(),
    origin: ProposalOriginSchema,
    baseFingerprint: z.union([ProposalFingerprintSchema, z.null()]),
    state: z.union([z.literal('pending'), z.literal('accepted'), z.literal('rejected')]),
    createdAt: z.string(),
    decidedAt: z.string().optional(),
  })
  .strict();

/** Негодная запись очереди: файл, который не разбирается формой `ProposalRecordSchema` — остаётся на диске, показывается по имени. */
export interface InvalidProposalFile {
  readonly file: string;
  readonly reason: string;
}

export interface ProposalsReadResult {
  readonly records: readonly ProposalRecord[];
  readonly invalid: readonly InvalidProposalFile[];
}

/**
 * Идентификаторы файлов записей верхнего уровня каталога очереди,
 * отсортированные — сортировка имён и есть порядок очереди (`entry.ts`,
 * `buildProposalId`). Отсутствие каталога — обычное состояние проекта, не
 * отказ.
 */
function listProposalFiles(dir: string): readonly string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Прочитать очередь предложений проекта. Файл, не разбираемый как запись
 * (неразбираемый JSON либо форма вне схемы), не отказывает чтению целиком и
 * не стирается — он идёт в `invalid`, названный своим именем (`ui-daemon`,
 * «Наблюдение очереди её не изменяет»).
 */
export function readProposalsDir(projectPath: string): ProposalsReadResult {
  const dir = proposalsDirPath(projectPath);
  const records: ProposalRecord[] = [];
  const invalid: InvalidProposalFile[] = [];

  for (const file of listProposalFiles(dir)) {
    const path = join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      invalid.push({ file, reason: `не разбирается как JSON: ${(error as Error).message}` });
      continue;
    }
    const parsed = ProposalRecordSchema.safeParse(raw);
    if (!parsed.success) {
      invalid.push({ file, reason: `не соответствует формату записи очереди: ${parsed.error.issues[0]?.message ?? 'неизвестная причина'}` });
      continue;
    }
    records.push(parsed.data);
  }

  return { records: records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), invalid };
}

export function findProposal(projectPath: string, id: string): ProposalRecord | undefined {
  return readProposalsDir(projectPath).records.find((record) => record.id === id);
}

/**
 * Ближайший существующий предок пути, приведённый к реальному, плюс хвост,
 * которого ещё нет на диске (тот же приём, что `resolveWidgetFile`,
 * `src/parts/ui/widgets.ts`, только терпимый к цели, которая ещё не создана —
 * действие `create`). Символическая ссылка среди уже существующих предков
 * так и остаётся пойманной: реальный путь у неё — путь цели ссылки, а не
 * записанное имя.
 */
function realWithMissingTail(path: string): string {
  const tail: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    tail.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const real = realpathSync(current);
  return tail.length === 0 ? real : join(real, ...tail);
}

interface ResolvedTarget {
  readonly absolutePath: string;
  readonly action: ProposalAction;
  readonly fingerprint: ProposalFingerprint | null;
}

/**
 * Проверить цель и привести к пути на диске: разбор строки (`parseProposalTarget`)
 * плюс приведение к реальному пути с проверкой вложенности в каталог кабинета
 * — шаг вверх по дереву ловит уже `isSafeSegment`, а выход по символической
 * ссылке ловит сравнение реальных путей здесь (`ui-proposals`, «Выход по
 * символической ссылке»).
 */
export function resolveProposalTarget(projectPath: string, target: string): ResolvedTarget {
  const parsed = callEntry(() => parseProposalTarget(target));
  const cabinetDir = join(projectPath, CABINET_DIR_NAME);
  const cabinetReal = realWithMissingTail(cabinetDir);
  const absolutePath = join(cabinetDir, ...parsed.segments);
  const real = realWithMissingTail(absolutePath);

  if (real !== cabinetReal && !real.startsWith(cabinetReal + sep)) {
    throw new StepcastError(`Цель ${target} ведёт за пределы кабинета проекта (символическая ссылка?)`);
  }

  const exists = existsSync(absolutePath);
  const fingerprint = exists ? fingerprintOf(absolutePath) : null;
  return { absolutePath, action: exists ? 'update' : 'create', fingerprint };
}

function fingerprintOf(path: string): ProposalFingerprint | null {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function fingerprintsEqual(a: ProposalFingerprint | null, b: ProposalFingerprint | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface ProposeInput {
  readonly target: string;
  readonly content: string;
  readonly reason?: string;
  readonly origin?: ProposalOrigin;
  readonly now?: Date;
}

/**
 * Правило повтора (`ui-proposals`, Решение 6, «Решённая запись остаётся
 * следом, а отклонённое не предлагается заново»): постановка, совпавшая по
 * цели и хешу содержимого с уже отклонённой записью, отказывает с названием
 * этой записи. Сравнение — по содержимому, а не по причине: причина у агента
 * каждый раз своя.
 */
function rejectIfRepeatsRejected(projectPath: string, target: string, content: string): void {
  const hash = contentHash(content);
  const repeated = readProposalsDir(projectPath).records.find(
    (record) => record.state === 'rejected' && record.target === target && contentHash(record.content) === hash,
  );
  if (repeated !== undefined) {
    throw new StepcastError(
      `Это предложение повторяет уже отклонённую запись ${repeated.id} — цель и содержимое совпадают`,
    );
  }
}

/**
 * Поставить предложение в очередь: единственный писатель — `stepcast propose`
 * (через эту функцию), запись атомарна (`ui-proposals`, «Единственный
 * писатель очереди»). Отказ (недопустимая цель, предел содержимого, повтор
 * отклонённого) не создаёт ни одного файла в каталоге очереди.
 */
export function proposeEntry(projectPath: string, input: ProposeInput): ProposalRecord {
  callEntry(() => checkProposalContentSize(input.content));
  const resolved = resolveProposalTarget(projectPath, input.target);
  rejectIfRepeatsRejected(projectPath, input.target, input.content);

  const now = input.now ?? new Date();
  mkdirSync(proposalsDirPath(projectPath), { recursive: true });
  const id = freeProposalId(projectPath, buildProposalId(now, input.target));
  const record: ProposalRecord = {
    id,
    target: input.target,
    action: resolved.action,
    content: input.content,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    origin: input.origin ?? {},
    baseFingerprint: resolved.fingerprint,
    state: 'pending',
    createdAt: now.toISOString(),
  };

  atomicWrite(proposalRecordPath(projectPath, id), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Свободный `<id>`: штамп момента в имени — до секунды (`entry.ts`,
 * `buildProposalId`), и два предложения одной цели, поставленные в пределах
 * одной секунды, иначе получили бы одно имя, а второе молча переписало бы
 * первое. Правило повтора (`rejectIfRepeatsRejected`) закрывает только
 * совпадение с **отклонённой** записью, так что потеря открытой записи ничем
 * не была бы замечена. Отсюда суффикс `-2`, `-3`: порядок сортировки имён он
 * не ломает — суффикс идёт внутри той же секунды, после базового имени.
 */
function freeProposalId(projectPath: string, base: string): string {
  if (!existsSync(proposalRecordPath(projectPath, base))) return base;
  for (let next = 2; ; next += 1) {
    const candidate = `${base}-${next}`;
    if (!existsSync(proposalRecordPath(projectPath, candidate))) return candidate;
  }
}

function requirePending(record: ProposalRecord): void {
  if (record.state !== 'pending') {
    throw new StepcastError(`Запись ${record.id} уже решена (${record.state}) — решить её повторно нельзя`);
  }
}

function writeRecord(projectPath: string, record: ProposalRecord): void {
  atomicWrite(proposalRecordPath(projectPath, record.id), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Отклонить запись: перевести в `rejected` с моментом решения, цель не
 * трогать (`ui-proposals`, «Отклонение ничего не пишет»).
 */
export function rejectProposal(projectPath: string, id: string, now: Date = new Date()): ProposalRecord {
  const record = findProposal(projectPath, id);
  if (record === undefined) {
    throw new StepcastError(`Запись очереди ${id} не найдена`);
  }
  requirePending(record);
  const decided: ProposalRecord = { ...record, state: 'rejected' as ProposalState, decidedAt: now.toISOString() };
  writeRecord(projectPath, decided);
  return decided;
}

/**
 * Принять запись: сверить отпечаток цели с диском, и при совпадении — записать
 * цель атомарной заменой, создав недостающие каталоги внутри кабинета
 * (`ui-proposals`, «Принятие записывает файл кабинета…»). Расхождение
 * отпечатка — отказ с названной причиной, запись остаётся `pending`, файл не
 * тронут (`ui-proposals`, «Расхождение отпечатка цели отменяет принятие»).
 */
export function acceptProposal(projectPath: string, id: string, now: Date = new Date()): ProposalRecord {
  const record = findProposal(projectPath, id);
  if (record === undefined) {
    throw new StepcastError(`Запись очереди ${id} не найдена`);
  }
  requirePending(record);

  const resolved = resolveProposalTarget(projectPath, record.target);
  if (!fingerprintsEqual(record.baseFingerprint, resolved.fingerprint)) {
    throw new StepcastError(
      `Файл цели ${record.target} изменился с момента предложения — принятие отменено, запись осталась открытой`,
    );
  }

  mkdirSync(dirname(resolved.absolutePath), { recursive: true });
  atomicWrite(resolved.absolutePath, record.content);

  const decided: ProposalRecord = { ...record, state: 'accepted' as ProposalState, decidedAt: now.toISOString() };
  writeRecord(projectPath, decided);
  return decided;
}

/**
 * Режим `direct` (`ui-proposals`, Решение 7, «Прямая запись»): записать цель
 * немедленно теми же проверками пути и той же атомарной заменой, не создавая
 * записи очереди вовсе.
 */
export function writeProposalTargetDirect(projectPath: string, target: string, content: string): string {
  callEntry(() => checkProposalContentSize(content));
  const resolved = resolveProposalTarget(projectPath, target);
  mkdirSync(dirname(resolved.absolutePath), { recursive: true });
  atomicWrite(resolved.absolutePath, content);
  return resolved.absolutePath;
}

export { PROPOSAL_MAX_CONTENT_BYTES };
