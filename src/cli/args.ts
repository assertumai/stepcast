import { StepcastError } from '../core/errors.js';
import type { CommandSpec, ParsedArgs } from '../core/plugins/cli-types.js';

/**
 * Разбор аргументов командной строки. Внешний разборщик не заводится
 * сознательно: набор форм у stepcast закрытый, а лишняя зависимость в пакете,
 * который должен ставиться одной командой, стоит дороже сотни строк здесь.
 */

// Типы описания команды живут в ядре: ими пользуется контракт плагина, а
// ядру запрещено зависеть от поверхности. Здесь они реэкспортируются, чтобы
// потребители внутри `src/cli` импортировали их привычным путём.
export type { CliIo, CommandSpec, FlagKind, FlagSpec, ParsedArgs } from '../core/plugins/cli-types.js';

function normalizeFlagName(token: string): string {
  return token.replace(/^--?/, '');
}

export function parseArgs(
  argv: readonly string[],
  commands: Readonly<Record<string, CommandSpec>>,
): ParsedArgs {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    throw new StepcastError('Не указана команда', { hint: usage(commands) });
  }

  const spec = commands[command];
  if (spec === undefined) {
    throw new StepcastError(`Неизвестная команда: ${command}`, { hint: usage(commands) });
  }

  const positional: string[] = [];
  const flags: Record<string, string | number | boolean | Record<string, string>> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;

    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }

    const equalsAt = token.indexOf('=');
    const name = normalizeFlagName(equalsAt === -1 ? token : token.slice(0, equalsAt));
    const inlineValue = equalsAt === -1 ? undefined : token.slice(equalsAt + 1);

    const flagSpec = spec.flags?.[name];
    if (flagSpec === undefined) {
      throw new StepcastError(`Неизвестный флаг --${name} у команды ${command}`, {
        hint: usage(commands, command),
      });
    }

    if (flagSpec.kind === 'boolean') {
      if (inlineValue !== undefined && inlineValue !== 'true' && inlineValue !== 'false') {
        throw new StepcastError(`Флаг --${name} логический и не принимает значение ${inlineValue}`);
      }
      flags[name] = inlineValue !== 'false';
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new StepcastError(`Флаг --${name} требует значения`);
      }
      value = next;
      index += 1;
    }

    if (flagSpec.kind === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new StepcastError(`Флаг --${name} требует числа, получено ${value}`);
      }
      flags[name] = parsed;
      continue;
    }

    if (flagSpec.kind === 'keyValue') {
      const separatorAt = value.indexOf('=');
      if (separatorAt === -1) {
        throw new StepcastError(`Флаг --${name} требует пары вида ключ=значение, получено ${value}`);
      }
      const existing = (flags[name] as Record<string, string> | undefined) ?? {};
      existing[value.slice(0, separatorAt)] = value.slice(separatorAt + 1);
      flags[name] = existing;
      continue;
    }

    flags[name] = value;
  }

  const expected = spec.positional ?? [];
  if (positional.length > expected.length) {
    throw new StepcastError(
      `Команда ${command} принимает не больше ${expected.length} позиционных аргументов, получено ${positional.length}`,
      { hint: usage(commands, command) },
    );
  }

  return { command, positional, flags };
}

export function usage(
  commands: Readonly<Record<string, CommandSpec>>,
  only?: string,
): string {
  const lines: string[] = [];
  for (const [name, spec] of Object.entries(commands)) {
    if (only !== undefined && only !== name) continue;
    const args = (spec.positional ?? []).map((item) => `<${item}>`).join(' ');
    lines.push(`  stepcast ${name}${args === '' ? '' : ` ${args}`} — ${spec.description}`);
    for (const [flag, flagSpec] of Object.entries(spec.flags ?? {})) {
      lines.push(`      --${flag} — ${flagSpec.description}`);
    }
  }
  return lines.join('\n');
}
