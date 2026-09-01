import { spawnSync } from 'node:child_process';

import type { z } from 'zod';

import { StepcastError } from '../errors.js';
import type { KnowledgeDeclaration } from '../pipeline/model.js';
import { createFsKnowledgeSource } from './fs.js';
import {
  KnowledgeCheckResponseSchema,
  KnowledgeIndexResponseSchema,
  KnowledgeSelectResponseSchema,
  KnowledgeWriteResponseSchema,
  type KnowledgeCheckResponse,
  type KnowledgeEntry,
  type KnowledgeIndexEntry,
  type KnowledgeSelector,
  type KnowledgeSource,
  type KnowledgeWriteRequest,
  type KnowledgeWriteResponse,
} from './types.js';

/**
 * Собрать источник знания по объявленной практике.
 *
 * Практика не объявлена — источника нет, и это законное состояние: движок
 * отклоняет записи `knowledge:` и предикат `knowledge_valid` линтом, а не
 * подсовывает пустоту. Ошибку об этом даёт вызывающий, который знает, что
 * именно потребовало источника.
 */
export function createKnowledgeSource(options: {
  readonly knowledge: KnowledgeDeclaration;
  readonly root: string;
  readonly specDir?: string | undefined;
  readonly now?: number;
}): KnowledgeSource | undefined {
  const { knowledge } = options;
  if (knowledge.provider === undefined) return undefined;

  if (knowledge.provider === 'fs') {
    if (knowledge.dir === undefined) {
      throw new StepcastError('Встроенный источник знания объявлен без каталога', {
        at: 'project.knowledge.dir',
      });
    }
    return createFsKnowledgeSource({
      root: options.root,
      dir: knowledge.dir,
      specDir: options.specDir,
      indexMaxTokens: knowledge.indexMaxTokens,
      staleAfterMs: knowledge.staleAfterMs,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  if (knowledge.command === undefined) {
    throw new StepcastError('Источник знания cmd объявлен без команды', {
      at: 'project.knowledge.command',
    });
  }

  return new CommandKnowledgeSource(knowledge.command, options.root, knowledge.timeoutMs);
}

/**
 * Источник за внешней командой. Глагол — первый аргумент, запрос JSON на
 * стандартном вводе, ответ JSON на стандартном выводе.
 *
 * Запускается **движком**, а не агентом: права шага на источник не
 * распространяются, объявления в `project.tools` он не требует, и агент не
 * может ни обойти отбор, ни дотянуться до самого источника — он получает
 * ровно то, что источник отдал.
 *
 * Запуск синхронный (`spawnSync`), потому что синхронна сборка контекста:
 * бюджет обязан проверяться до запуска шага, а асинхронный источник развёл
 * бы сборку и проверку по разным моментам времени.
 */
class CommandKnowledgeSource implements KnowledgeSource {
  constructor(
    private readonly command: string,
    private readonly cwd: string,
    private readonly timeoutMs: number,
  ) {}

  index(): readonly KnowledgeIndexEntry[] {
    return this.call('index', {}, KnowledgeIndexResponseSchema).entries;
  }

  select(selector: KnowledgeSelector): readonly KnowledgeEntry[] {
    const request =
      selector.kind === 'index'
        ? { index: true }
        : selector.kind === 'scope'
          ? { scope: selector.scope, ...(selector.budget === undefined ? {} : { budget: selector.budget }) }
          : { id: selector.id, ...(selector.budget === undefined ? {} : { budget: selector.budget }) };
    return this.call('select', request, KnowledgeSelectResponseSchema).entries;
  }

  check(): KnowledgeCheckResponse {
    return this.call('check', {}, KnowledgeCheckResponseSchema);
  }

  write(request: KnowledgeWriteRequest): KnowledgeWriteResponse {
    return this.call('write', request, KnowledgeWriteResponseSchema);
  }

  private call<T>(verb: string, request: unknown, schema: z.ZodType<T>): T {
    const result = spawnSync(`${this.command} ${verb}`, {
      cwd: this.cwd,
      shell: true,
      input: JSON.stringify(request),
      encoding: 'utf8',
      timeout: this.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });

    if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new StepcastError(
        `Источник знания не ответил за отведённое время: ${this.command} ${verb}`,
        { hint: 'Поднимите project.knowledge.timeout или ускорьте источник' },
      );
    }
    if (result.error !== undefined) {
      throw new StepcastError(`Источник знания не запустился: ${(result.error as Error).message}`, {
        cause: result.error,
      });
    }
    if (result.status !== 0) {
      // Отказ источника — отказ шага. Пустой контекст здесь был бы хуже
      // отказа: шаг отработал бы на пустоте и выглядел успешным.
      const detail = (result.stderr ?? '').trim();
      throw new StepcastError(
        `Источник знания завершился кодом ${result.status ?? 'неизвестно'}: ${this.command} ${verb}`,
        detail === '' ? {} : { hint: detail.slice(0, 400) },
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout ?? '');
    } catch (error) {
      throw new StepcastError(`Источник знания отдал не JSON: ${this.command} ${verb}`, {
        cause: error,
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new StepcastError(
        `Ответ источника знания не соответствует контракту: ${this.command} ${verb}`,
        { hint: parsed.error.issues.map((issue) => issue.message).join('; ').slice(0, 400) },
      );
    }
    return parsed.data;
  }
}
