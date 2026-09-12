import { existsSync, readFileSync } from 'node:fs';

import { StepcastError } from '../errors.js';
import { decisionRecordPath, type RunPaths } from '../journal/paths.js';
import { DecisionRequestFileSchema, type AwaitingDecision, type DecisionRequestFile } from '../journal/schema.js';
import { validateDecision, type ProposedDecision, type ValidatedDecision } from './decision.js';

/**
 * Ожидание решения в процессе прогона (`user-decision-steps`, design.md
 * решение 5, решение 9).
 *
 * Ждущий процесс опрашивает каталог `decisions/` с интервалом, а не
 * подписывается на него (design.md, решение 9): `fs.watch` расходится по
 * платформам, а пропущенное событие означало бы ожидание, зависшее навсегда
 * при лежащем на диске решении. Тот же опрос закрывает и случай решения,
 * записанного до начала ожидания, — первый же такт видит файл.
 */

/** Интервал опроса — константа, подменяемая изнутри ради проверок. */
export const DEFAULT_DECISION_POLL_MS = 1000;

export type DecisionWaitOutcome =
  | { readonly kind: 'decided'; readonly decision: ValidatedDecision; readonly by: 'user' | 'deadline' }
  /** Отмена прогона прервала ожидание сигналом, не дожидаясь такта опроса. */
  | { readonly kind: 'canceled' };

export interface WaitForDecisionOptions {
  readonly paths: RunPaths;
  readonly waitId: string;
  readonly awaiting: AwaitingDecision;
  /** Адреса `job`/`job/step`, допустимые как точка перезапуска. */
  readonly knownSteps: ReadonlySet<string>;
  readonly signal?: AbortSignal;
  /** Негодная запись на диске: ожидание её отвергает и продолжает ждать. */
  readonly onRefused: (detail: string) => void;
  readonly pollIntervalMs?: number;
  /**
   * Решение, перенесённое возобновлением из прогона, чей процесс умер до того,
   * как успел его применить (дельта `run-resume`, требование о решении
   * мёртвому прогону). Адресовано ожиданию того же шага прошлого прогона, а не
   * этому: идентификатор ожидания несёт момент его начала и совпасть не может.
   * Пробуется первым же тактом и ровно один раз — `onApplied` снимает его,
   * чтобы следующая итерация цикла `until` спросила человека заново.
   */
  readonly carried?: {
    readonly record: DecisionRequestFile;
    readonly source: string;
    readonly onApplied: () => void;
  };
}

/**
 * Дождаться решения: опрос каталога с применением истёкшего срока и
 * немедленным прерыванием по `AbortSignal`.
 */
export function waitForDecision(options: WaitForDecisionOptions): Promise<DecisionWaitOutcome> {
  const interval = options.pollIntervalMs ?? DEFAULT_DECISION_POLL_MS;
  const path = decisionRecordPath(options.paths, options.waitId);

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * Текст записи, уже отвергнутой этим ожиданием. Негодная запись лежит на
     * диске и перечитывается каждым тактом: без этой памяти одна такая запись
     * давала бы событие в секунду до конца ожидания — часы событий об одном и
     * том же. Сравнивается именно текст: исправленную запись ожидание обязано
     * рассмотреть заново.
     */
    let refusedRaw: string | undefined;
    /** Срок, уже отвергнутый по своему объявлению: второй раз его не проверяют. */
    let expiryRefused = false;
    let carried = options.carried;

    const refuseOnce = (raw: string, detail: string): void => {
      if (refusedRaw === raw) return;
      refusedRaw = raw;
      options.onRefused(detail);
    };

    const finish = (outcome: DecisionWaitOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    const onAbort = (): void => finish({ kind: 'canceled' });

    const applyExpiry = (): boolean => {
      if (expiryRefused) return false;
      if (options.awaiting.deadline === undefined) return false;
      if (Date.now() < Date.parse(options.awaiting.deadline)) return false;
      const outcomeName = options.awaiting.on_expire;
      // Срок без объявленного исхода — нарушение инварианта, который держит
      // линт (решение 7): ожидание в этом случае продолжается, а не отказывает
      // прогон по дефекту, до которого линт не должен был допустить.
      if (outcomeName === undefined) return false;

      // Исход по истечении проходит ту же проверку, что и решение человека:
      // отдельная сборка записи проносила бы мимо неё `reject` без причины —
      // и прогон останавливался бы текстом с висящим тире вместо причины.
      // Причину в этом случае называет сам срок: человека, который её назвал
      // бы, тут нет.
      const proposed: ProposedDecision = {
        outcome: outcomeName,
        ...(options.awaiting.outcomes[outcomeName]?.effect === 'reject'
          ? { reason: `срок ожидания истёк (${options.awaiting.deadline})` }
          : {}),
      };
      let validated: ValidatedDecision;
      try {
        validated = validateDecision(options.awaiting, proposed, options.knownSteps);
      } catch (error) {
        // Негодное объявление срока не отказывает прогон и не повторяется
        // каждым тактом: ожидание продолжается, ждать решения снаружи ему
        // ничто не мешает.
        expiryRefused = true;
        options.onRefused(
          `исход по истечении срока ${outcomeName} не применён: ${error instanceof StepcastError ? error.message : String(error)}`,
        );
        return false;
      }
      finish({ kind: 'decided', decision: validated, by: 'deadline' });
      return true;
    };

    /**
     * Решение, перенесённое из прогона, чей процесс умер, — первым же тактом и
     * один раз: негодное отвергается событием, и ожидание продолжается, как и
     * с негодной записью на диске.
     */
    const applyCarried = (): boolean => {
      const pending = carried;
      if (pending === undefined) return false;
      carried = undefined;
      pending.onApplied();
      try {
        const validated = validateDecision(options.awaiting, toProposed(pending.record), options.knownSteps);
        finish({ kind: 'decided', decision: validated, by: 'user' });
        return true;
      } catch (error) {
        options.onRefused(
          `решение, перенесённое из прогона ${pending.source}, не применено: ${error instanceof StepcastError ? error.message : String(error)}`,
        );
        return false;
      }
    };

    const readRecord = (): boolean => {
      if (!existsSync(path)) return false;

      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch (error) {
        // Файл исчез или недочитан между проверкой и чтением: следующий такт
        // прочитает его целиком. Отвергать нечего — записи ещё нет.
        if (isMissing(error)) return false;
        refuseOnce(
          `!read:${String(error)}`,
          `decisions/${options.waitId}.json нечитаем: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        refuseOnce(
          text,
          `decisions/${options.waitId}.json нечитаем: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }

      const parsed = DecisionRequestFileSchema.safeParse(raw);
      if (!parsed.success) {
        refuseOnce(text, `decisions/${options.waitId}.json не по форме: ${parsed.error.message}`);
        return false;
      }

      try {
        const validated = validateDecision(options.awaiting, toProposed(parsed.data), options.knownSteps);
        finish({ kind: 'decided', decision: validated, by: 'user' });
        return true;
      } catch (error) {
        refuseOnce(text, error instanceof StepcastError ? error.message : String(error));
        return false;
      }
    };

    const tick = (): void => {
      if (settled) return;
      if (readRecord()) return;
      if (applyCarried()) return;
      if (applyExpiry()) return;
      timer = setTimeout(tick, interval);
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) {
      finish({ kind: 'canceled' });
      return;
    }

    // Первый такт немедленно: решение, лежавшее на диске до начала ожидания
    // (возобновление прогона, чей процесс умер), не должно ждать интервал.
    tick();
  });
}

/** Запись файла решения в форму предложенного решения (camelCase контракта). */
function toProposed(record: DecisionRequestFile): ProposedDecision {
  return {
    outcome: record.outcome,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.restart_from === undefined ? {} : { restartFrom: record.restart_from }),
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
