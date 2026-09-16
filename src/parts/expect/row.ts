import {
  CHANGED_ONLY_PREDICATE,
  CMD_PREDICATE,
  EXIT_CODE_PREDICATE,
  FILE_EXISTS_PREDICATE,
  JUDGE_PREDICATE,
  KNOWLEDGE_VALID_PREDICATE,
  MATCHES_PREDICATE,
  NOT_MATCHES_PREDICATE,
  SCHEMA_PREDICATE,
  SCRIPT_PREDICATE,
} from '../../core/pipeline/expand.js';
import { partRow } from '../pipeline/services.js';

/**
 * Строка встроенного слоя: все десять встроенных предикатов
 * (`builtin-predicates-as-row`, design.md, Решение 1) — одна строка на весь
 * набор, а не по строке на предикат: отдельная строка имела бы смысл только
 * вместе с отдельным вкладом, а модель `Predicate` и `switch` вычисления
 * (`expect/evaluate.ts`) остаются размеченным объединением на десять
 * типизированных ветвей, не на десять приведений `unknown`. Внутренняя форма
 * разбора (`native.test`/`native.parse`) остаётся в `src/core/pipeline/expand.ts` —
 * её физический переезд в этот каталог ничем не обусловлен этим пунктом
 * (design.md, Non-Goals).
 *
 * Импорт верхнего уровня, обращение к формам — внутри тела `apply`: `rows.ts`
 * → `row.ts` → `expand.ts` → `parts/builtin.ts` → `rows.ts` замыкается в
 * цикл, и связывание модулей ES разводит его без ошибки только для
 * обращений, происходящих после инициализации всех модулей (тот же приём,
 * что у строк видов шага, `builtin-step-kinds-as-rows`, design.md, Решение 1).
 *
 * Строка-потребитель сервиса `predicates` (design.md `pipeline-owns-services`,
 * Решение 2): применяется собственной областью с объявленным `inject`, а не
 * прямо на корне, — порядок относительно строки-поставщика (`pipeline`) её
 * применения не решает. Владелец вклада остаётся «встроенным»: признак — не
 * корневая область, а пометка области строки этого каталога (Решение 3).
 */
export const row = partRow('predicates', ['predicates'], (ctx) => {
  for (const form of [
    EXIT_CODE_PREDICATE,
    FILE_EXISTS_PREDICATE,
    SCHEMA_PREDICATE,
    MATCHES_PREDICATE,
    NOT_MATCHES_PREDICATE,
    CHANGED_ONLY_PREDICATE,
    KNOWLEDGE_VALID_PREDICATE,
    CMD_PREDICATE,
    SCRIPT_PREDICATE,
    JUDGE_PREDICATE,
  ]) {
    ctx.predicates.register(form.name, form);
  }
});
