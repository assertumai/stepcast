/**
 * Коды возврата процесса. Контракт зафиксирован в docs/run-layout.md и
 * используется вызывающими сценариями, поэтому значения менять нельзя.
 */
export const ExitCode = {
  ok: 0,
  jobFailed: 1,
  configError: 2,
  budgetExceeded: 3,
  /** Отказ аутентификации бэкенда: окружение неисполнимо, а не пайплайн упал. */
  backendUnavailable: 4,
  canceled: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface StepcastErrorOptions {
  /** Код возврата процесса. По умолчанию — ошибка конфигурации. */
  readonly exitCode?: ExitCodeValue;
  /** Файл, к которому относится ошибка. */
  readonly file?: string;
  /** Путь внутри документа, например `jobs.implement.needs`. */
  readonly at?: string;
  /** Что делать пользователю. Печатается отдельной строкой. */
  readonly hint?: string;
  readonly cause?: unknown;
}

/**
 * Единственный тип ошибки, который движок выпускает наружу осознанно.
 * Всё остальное, всплывшее наверх, считается дефектом и печатается со стеком.
 */
export class StepcastError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly file: string | undefined;
  readonly at: string | undefined;
  readonly hint: string | undefined;

  constructor(message: string, options: StepcastErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StepcastError';
    this.exitCode = options.exitCode ?? ExitCode.configError;
    this.file = options.file;
    this.at = options.at;
    this.hint = options.hint;
  }

  /** Расположение проблемы одной строкой, если оно известно. */
  location(): string | undefined {
    if (this.file !== undefined && this.at !== undefined) return `${this.file}: ${this.at}`;
    return this.file ?? this.at;
  }
}

export function isStepcastError(value: unknown): value is StepcastError {
  return value instanceof StepcastError;
}
