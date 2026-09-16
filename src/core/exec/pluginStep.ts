import { evaluatePredicates, validateAgainstSchema } from '../expect/evaluate.js';
import { StepcastError } from '../errors.js';
import type { DecisionRecord, PredicateResult, StepRecord, Usage } from '../journal/schema.js';
import type { Job, PluginStep } from '../pipeline/model.js';
import { validateStepKindFields } from '../pipeline/expand.js';
import { pluginContext } from '../plugins/kernel.js';
import { kernelFromRegistry } from '../plugins/registry.js';
import { DecisionHalt } from '../plugins/pipeline-contract.js';
import type {
  StepKindContribution,
  StepKindDecisions,
  StepKindInput,
  StepKindLog,
  StepKindOutcome,
} from '../plugins/pipeline-contract.js';
import { toDecisionRecord } from '../run/decision.js';
import { sumUsage } from '../backend/types.js';
import { describeExceeded, type BudgetScope, type Exceeded } from '../budget/accumulator.js';
import { runAttempts, type AttemptPlan } from './attempts.js';
import { runJudgePass } from './judgePass.js';
import type { RunContext, StepOutcome } from '../run/runner.js';
import { adapterOf, describeStepTask, stepEnv } from '../run/runner.js';

/**
 * Исполнение шага плагинного вида (design.md, решения 6 и 7).
 *
 * Цикл попыток — тот же `runAttempts`, каким исполняется командный шаг: второй
 * цикл движок не заводит (design.md, решение 7). Отличается только тело
 * попытки — здесь это вызов `execute` вклада, а не порождение процесса.
 * `runner.ts` вызывает эту функцию тем же путём, что `runCommandStep`.
 */

/**
 * Каталог шага в журнале: файлы попытки исполнитель пишет только через
 * `StepKindLog.file`, и пишет он их в тот же каталог, который движок отвёл
 * этой попытке. Каталог передан сюда готовым, а не берётся заново
 * `prepareStep`: у работы с циклом `until` каталог шага несёт номер итерации,
 * и второе вычисление завело бы рядом лишний каталог без неё.
 */
function makeLog(context: RunContext, job: Job, step: PluginStep, attempt: number, stepDir: string): StepKindLog {
  return {
    note(message) {
      context.journal.event({ kind: 'step_kind.logged', job: job.id, step: step.id, attempt, message });
    },
    file(name, content) {
      return context.journal.writeStepFile(stepDir, name, content);
    },
  };
}

/**
 * Гонка исполнения с таймаутом шага (design.md, решение 7): по истечении
 * `step.timeoutMs` сигнал взводится, а попытка отказывает тем же текстом, что
 * и у командного шага по таймауту, — исполнитель при этом не убивается: внутри
 * своего процесса убивать нечего.
 */
function raceWithTimeout(
  outcome: Promise<StepKindOutcome>,
  timeoutMs: number,
  controller: AbortController,
): Promise<{ readonly timedOut: boolean; readonly outcome?: StepKindOutcome; readonly error?: unknown }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
    outcome.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, outcome: value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, error });
      },
    );
  });
}

export async function runPluginStep(
  step: PluginStep,
  job: Job,
  context: RunContext,
  stepDirPath: string,
  contribution: StepKindContribution,
  budgetScopes: () => BudgetScope[],
  changedPaths: () => readonly string[] | undefined,
  /** Итерация цикла until, если работа его объявляет — часть идентичности ожидания. */
  iteration?: number,
): Promise<StepOutcome> {
  const { journal, config } = context;
  const results: (readonly PredicateResult[])[] = [];
  /**
   * Структурированный выход последней попытки — он же выход шага (`output.json`,
   * `${jobs.*.output}`). Как и у командного шага, значение прошлой попытки не
   * должно дожить до следующей и выдаться за её результат: поле снимается в
   * начале каждой попытки.
   */
  let structuredOutput: unknown;
  /** Первое превышение, замеченное за шаг, — им взводится защёлка прогона. */
  let exceeded: Exceeded | undefined;
  /**
   * Решение, применённое к ожиданию этого шага (design.md изменения
   * `user-decision-steps`, решение 5) — записывается в `StepRecord.decision`
   * независимо от эффекта: `continue` тоже решение, а не молчаливый обход.
   */
  let decisionRecord: DecisionRecord | undefined;
  // Отдельные сквозные ряды подкаталогов шага — те же, что у командного:
  // `judge-<n>` у судей, `script-<n>` у предиката-скрипта.
  let judgeCallCount = 0;
  const nextCallIndex = (): number => {
    judgeCallCount += 1;
    return judgeCallCount;
  };
  let scriptCallCount = 0;
  const nextScriptCallIndex = (): number => {
    scriptCallCount += 1;
    return scriptCallCount;
  };

  const loop = await runAttempts<StepRecord['attempts'][number]>({
    attempts: step.attempts,
    run: async (plan: AttemptPlan) => {
      // Потолок бюджета решает, стартовать ли попытку вовсе (та же проверка,
      // что открывает `runCommandStep`).
      const found = context.usage.check(budgetScopes());
      if (found !== undefined) {
        exceeded ??= found;
        const now = new Date().toISOString();
        results.push([]);
        return {
          passed: false,
          terminal: true,
          value: { attempt: plan.attempt, status: 'budget_exceeded', started_at: now, finished_at: now },
        };
      }

      structuredOutput = undefined;

      // Поля шага проверяются схемой вклада ещё раз, по окончательным
      // значениям (design.md, решение 5, тот же образец, что у
      // `uses.paramsSchema`, `runner.ts`): до позднего раскрытия поле могло
      // нести подстановку, непроверимую статически при разборе. Адрес — адрес
      // ключа для формы `fields`, адрес самого шага для формы `document`: у
      // разобранных полей вклада с собственной формой записи пути в документе
      // нет (design.md изменения `step-kind-document-contract`, Решение 6).
      const stepAt = `jobs.${job.id}.steps.${step.index - 1}`;
      const at = contribution.document !== undefined ? stepAt : `${stepAt}.${step.name}`;
      try {
        validateStepKindFields(contribution, step.fields, at, context.registry);
      } catch (error) {
        const now = new Date().toISOString();
        results.push([]);
        return {
          passed: false,
          terminal: true,
          value: {
            attempt: plan.attempt,
            status: 'failed',
            reason: error instanceof StepcastError ? error.message : String(error),
            started_at: now,
            finished_at: now,
          },
        };
      }

      const controller = new AbortController();
      const onRunAbort = (): void => controller.abort();
      context.signal?.addEventListener('abort', onRunAbort, { once: true });

      const startedAt = new Date().toISOString();
      const env = stepEnv(step, job, plan.attempt, context, stepDirPath);
      // Способность ожидания — только виду, распоряжающемуся своим сроком
      // (design.md, решение 1, решение 6): движок не даёт decision.request
      // виду, который не объявил waits, и потому не может забыть дождаться
      // его ответственно.
      const decision: StepKindDecisions | undefined =
        contribution.waits === true
          ? {
              async request(request) {
                const result = await context.awaitDecision(
                  {
                    job: job.id,
                    step: step.id,
                    attempt: plan.attempt,
                    ...(iteration === undefined ? {} : { iteration }),
                  },
                  request,
                );
                decisionRecord = toDecisionRecord(result);
                return result;
              },
            }
          : undefined;
      const input: StepKindInput = {
        fields: step.fields,
        step: { id: step.id, index: step.index, timeoutMs: step.timeoutMs },
        job: { id: job.id },
        attempt: plan.attempt,
        env,
        cwd: context.cwd,
        stepDir: stepDirPath,
        signal: controller.signal,
        log: makeLog(context, job, step, plan.attempt, stepDirPath),
        ctx: pluginContext(kernelFromRegistry(context.registry).ctx),
        ...(decision === undefined ? {} : { decision }),
      };

      let raced: Awaited<ReturnType<typeof raceWithTimeout>>;
      try {
        raced =
          // Гонка с таймаутом — только для вида без waits (design.md, решение
          // 6): вид, распоряжающийся своим сроком, `step.timeoutMs` не гонит —
          // поле остаётся во входе исполнителя справочным значением.
          contribution.waits === true
            ? await (async () => {
                try {
                  const value = await contribution.execute(input);
                  return { timedOut: false as const, outcome: value };
                } catch (error) {
                  return { timedOut: false as const, error };
                }
              })()
            : await raceWithTimeout(
                Promise.resolve().then(() => contribution.execute(input)),
                step.timeoutMs,
                controller,
              );
      } finally {
        context.signal?.removeEventListener('abort', onRunAbort);
      }

      const finishedAt = new Date().toISOString();

      if (raced.timedOut) {
        // Тот же предикат и тот же текст, что у командного шага по таймауту
        // (`exec/runStep.ts`, `describeOutcome`): причина остановки выводится
        // из имени непройденного предиката (`causeOf`), и без него шаг
        // числился бы отказавшим по `expect`, а не по таймауту.
        const timedOut: PredicateResult = {
          predicate: 'timeout',
          passed: false,
          hard: true,
          detail: `Шаг не завершился за ${step.timeoutMs} мс`,
        };
        results.push([timedOut]);
        return {
          passed: false,
          value: {
            attempt: plan.attempt,
            status: 'failed',
            reason: timedOut.detail as string,
            started_at: startedAt,
            finished_at: finishedAt,
          },
        };
      }

      if (raced.error instanceof DecisionHalt) {
        // Отклонение и перезапуск заканчивают прогон как отмену (design.md
        // изменения `user-decision-steps`, решение 3): что именно произошло,
        // читатель узнаёт из записи `decision`, а не из перечня причин
        // остановки — причина остаётся `canceled` с текстом, называющим волю
        // пользователя.
        decisionRecord = toDecisionRecord(raced.error.result);
        const { result } = raced.error;
        const reasonText =
          result.effect === 'reject'
            ? `решение пользователя: отклонено — ${result.reason ?? ''}`
            : `решение пользователя: перезапуск с ${result.restartFrom ?? ''}`;
        results.push([]);
        return {
          passed: false,
          terminal: true,
          value: {
            attempt: plan.attempt,
            status: 'canceled',
            reason: reasonText,
            started_at: startedAt,
            finished_at: finishedAt,
          },
        };
      }

      if (raced.error !== undefined) {
        // Исключение исполнителя — непройденная попытка с названной причиной,
        // а не крушение шага (design.md, решение 6): тот же выбор, что у
        // `evaluate` плагинного предиката.
        results.push([]);
        return {
          passed: false,
          terminal: true,
          value: {
            attempt: plan.attempt,
            status: 'failed',
            reason: `Исполнитель вида шага ${step.name} отказал: ${raced.error instanceof Error ? raced.error.message : String(raced.error)}`,
            started_at: startedAt,
            finished_at: finishedAt,
          },
        };
      }

      const outcome = raced.outcome ?? {};
      if (outcome.text !== undefined) {
        // То же имя файла, что у командного шага: первая попытка — `stdout.log`,
        // дальше `stdout.<n>.log` (`exec/runStep.ts`). `stepcast logs` и
        // витрина читают именно его.
        const suffix = plan.attempt === 1 ? '' : `.${plan.attempt}`;
        journal.writeStepFile(stepDirPath, `stdout${suffix}.log`, outcome.text);
      }
      structuredOutput = outcome.structured;

      // Расход попытки копится, а не замещается: расход самого исполнителя и
      // расход каждого судьи складываются тем же счётчиком (`runCommandStep`).
      let attemptUsage: Usage | undefined;
      const recordUsage = (usage: Usage): void => {
        const merged = attemptUsage === undefined ? usage : sumUsage(attemptUsage, usage);
        attemptUsage = merged;
        context.usage.record(job.id, step.id, plan.attempt, merged);
        exceeded ??= context.usage.check(budgetScopes());
      };
      if (outcome.usage !== undefined) recordUsage(outcome.usage);

      const text = outcome.text ?? '';
      const firstPass = await evaluatePredicates(
        step.expect,
        {
          exitCode: outcome.exitCode ?? 0,
          text,
          structured: outcome.structured,
          cwd: context.cwd,
          env,
          changedPaths: changedPaths(),
          knowledge: context.knowledgeSource,
          // Контракт вызова предиката-скрипта: без него `script` в `expect`
          // отказал бы исключением, а не вердиктом (`expect/evaluate.ts`).
          script: {
            stepDir: stepDirPath,
            attempt: plan.attempt,
            journal,
            nextCallIndex: nextScriptCallIndex,
            timeoutMs: step.timeoutMs,
            ...(config.defaults.stallTimeoutMs === undefined
              ? {}
              : { stallTimeoutMs: config.defaults.stallTimeoutMs }),
            signal: controller.signal,
          },
        },
        context.registry,
      );

      // Схема выхода вклада — та же диагностика, что у `output_schema` шага
      // `script` (design.md, решение 9).
      const outputFailure: PredicateResult | undefined =
        contribution.output === undefined
          ? undefined
          : (() => {
              const validated = validateAgainstSchema(contribution.output, outcome.structured);
              if (validated.passed) return undefined;
              return {
                predicate: 'step_output',
                passed: false,
                hard: true,
                detail: `шаг ${step.id} вида ${step.name} записал выход не по output:\n${validated.detail ?? ''}`,
              };
            })();

      // Судья — второй проход попытки, тот же, что у командного шага:
      // синхронное вычисление оставило его заготовкой «не вычислен», и без
      // этого вызова предикат `judge` молча проходил бы. По промаху схемы
      // выхода судьи не зовутся — платить за вызов модели, когда отказ уже
      // решён, незачем (тот же выбор, что у промаха контракта `script`).
      const evaluated =
        outputFailure !== undefined || !step.expect.some((predicate) => predicate.kind === 'judge')
          ? firstPass
          : await runJudgePass({
              predicates: step.expect,
              firstPass,
              task: describeStepTask(step, context.registry),
              text,
              structured: outcome.structured ?? text,
              cwd: context.cwd,
              stepDir: stepDirPath,
              attempt: plan.attempt,
              timeoutMs: step.timeoutMs,
              ...(config.defaults.stallTimeoutMs === undefined
                ? {}
                : { stallTimeoutMs: config.defaults.stallTimeoutMs }),
              signal: controller.signal,
              onStall: (silentMs: number) =>
                journal.event({ kind: 'step.stalled', job: job.id, step: step.id, silent_ms: silentMs }),
              env,
              adapterFor: (name) => adapterOf(name, context),
              defaultAgent: config.defaults.agent,
              backendSlots: context.backendSlots,
              journal,
              nextCallIndex,
              canCall: () => {
                const seen = context.usage.check(budgetScopes());
                exceeded ??= seen;
                return seen === undefined;
              },
              onUsage: recordUsage,
            });

      const allResults = outputFailure === undefined ? evaluated : [...evaluated, outputFailure];
      results.push(allResults);
      const hardFailure = allResults.find((entry) => !entry.passed && entry.hard);
      for (const failure of allResults) {
        if (!failure.passed && failure.hard) {
          journal.event({
            kind: 'expect.failed',
            job: job.id,
            step: step.id,
            attempt: plan.attempt,
            predicate: failure.predicate,
            ...(failure.detail === undefined ? {} : { detail: failure.detail }),
          });
        }
      }

      const record: StepRecord['attempts'][number] = {
        attempt: plan.attempt,
        status: hardFailure === undefined ? 'success' : 'failed',
        ...(hardFailure === undefined ? {} : { reason: hardFailure.detail ?? hardFailure.predicate }),
        started_at: startedAt,
        finished_at: finishedAt,
        ...(outcome.exitCode === undefined ? {} : { exit_code: outcome.exitCode }),
        ...(attemptUsage === undefined ? {} : { usage: attemptUsage }),
      };
      return { passed: hardFailure === undefined, value: record };
    },
    canContinue: () => context.usage.check(budgetScopes()) === undefined,
  });

  const last = loop.outcomes.at(-1);
  const status: StepOutcome['status'] =
    context.signal?.aborted === true ? 'canceled' : loop.passed ? 'success' : last?.status ?? 'failed';
  // Шаг, остановленный потолком, называет своей причиной сам потолок: его
  // запись попытки причины не несёт вовсе (исполнитель не звался).
  const reason =
    status === 'budget_exceeded' && exceeded !== undefined ? describeExceeded(exceeded) : last?.reason;
  return {
    status,
    ...(reason === undefined ? {} : { reason }),
    attempts: loop.outcomes,
    results,
    // Структурированный выход отдаётся только успешному шагу — как и у
    // командного: значение попытки, отказавшей по предикату, выходом работы
    // не становится.
    ...(status === 'success' && structuredOutput !== undefined ? { structured: structuredOutput } : {}),
    // Превышение отдаётся наружу, даже когда сам шаг дошёл до конца успехом:
    // защёлка прогона взводится потолком прогона так же, как и остановленным
    // шагом (`runJobSteps`, design.md решение 3 изменения о бюджете).
    ...(exceeded === undefined ? {} : { exceeded }),
    // Решение по ожиданию этого шага — независимо от эффекта: `continue`
    // тоже решение и тоже записывается (design.md изменения
    // `user-decision-steps`, решение 5).
    ...(decisionRecord === undefined ? {} : { decision: decisionRecord }),
  };
}
