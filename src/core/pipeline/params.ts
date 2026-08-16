import { ScarpError } from '../errors.js';
import type { RawParam } from './schema.js';

export type ParamValue = string | number | boolean;

/**
 * Свести объявленные параметры и переданные значения.
 *
 * Одна функция обслуживает и `inputs` пайплайна, и `params` работы: правила у
 * них одинаковые, а расходящиеся реализации разъехались бы на первой же
 * доработке.
 */
export function resolveParams(
  declared: Readonly<Record<string, RawParam>>,
  provided: Readonly<Record<string, ParamValue>>,
  context: { readonly file: string; readonly what: 'inputs' | 'with'; readonly owner?: string },
): Record<string, ParamValue> {
  const where = context.owner === undefined ? context.what : `${context.owner}.${context.what}`;

  for (const name of Object.keys(provided)) {
    if (!(name in declared)) {
      const known = Object.keys(declared).sort().join(', ');
      throw new ScarpError(`Параметр ${name} не объявлен`, {
        file: context.file,
        at: `${where}.${name}`,
        hint: known === '' ? 'Объявленных параметров нет' : `Объявлены: ${known}`,
      });
    }
  }

  const out: Record<string, ParamValue> = {};

  for (const [name, spec] of Object.entries(declared)) {
    const raw = provided[name];

    if (raw === undefined) {
      if (spec.default !== undefined) {
        out[name] = coerce(spec.default, spec.type, name, context.file, where);
        continue;
      }
      if (spec.required === true) {
        throw new ScarpError(`Не передан обязательный параметр ${name}`, {
          file: context.file,
          at: `${where}.${name}`,
          hint: context.what === 'inputs' ? `Передайте --input ${name}=<значение>` : `Добавьте ${name} в with`,
        });
      }
      continue;
    }

    out[name] = coerce(raw, spec.type, name, context.file, where);
  }

  return out;
}

function coerce(
  value: ParamValue,
  type: RawParam['type'],
  name: string,
  file: string,
  where: string,
): ParamValue {
  const at = `${where}.${name}`;

  switch (type) {
    case 'string':
      return String(value);

    case 'bool': {
      if (typeof value === 'boolean') return value;
      const text = String(value).toLowerCase();
      if (text === 'true') return true;
      if (text === 'false') return false;
      throw new ScarpError(`Параметр ${name} должен быть логическим, получено ${String(value)}`, {
        file,
        at,
        hint: 'Допустимы true и false',
      });
    }

    case 'int': {
      const parsed = typeof value === 'number' ? value : Number(String(value));
      if (!Number.isInteger(parsed)) {
        throw new ScarpError(`Параметр ${name} должен быть целым, получено ${String(value)}`, {
          file,
          at,
        });
      }
      return parsed;
    }
  }
}
