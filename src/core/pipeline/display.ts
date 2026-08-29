import { StepcastError } from '../errors.js';
import { interpolate, placeholderNamespaces } from './interpolate.js';

/**
 * Раскрытие блока `display` — третий, самый поздний случай раскрытия в
 * движке.
 *
 * `inputs.*`, `params.*` и `project.*` раскрываются при разборе документа;
 * `jobs.*`, `run.*` и `env.*` — перед исполнением работы (`resolveLate`).
 * `display` не проходит ни через второй этап, ни тем более через первый со
 * своими отложенными именами: его поля не потребляет ни один шаг, их читает
 * витрина, — и раскрываются они здесь, в момент сборки снимка, против
 * текущего содержимого `data`. Отсюда и работает самоссылка
 * `${jobs.<сам>.data.title}`: к отрисовке работа уже успела записать.
 *
 * Раскрытие мягкое: ключа нет — поля просто нет. Правило обратно строгому
 * правилу полей, потребляемых шагом, ровно потому, что у подписи нет
 * потребителя ниже по течению: пустая строка в пути контекста ломает шаг
 * тремя шагами позже, а отсутствующая подпись не ломает ничего.
 */

/**
 * Данные работ прогона под тем же именем, под которым их называет
 * подстановка: `jobs.<работа>.data.<ключ>`. Промежуточный `data` здесь не
 * украшение — он и есть второй сегмент пути, и без него область видимости
 * разошлась бы с формой выражения.
 */
export type DisplayData = Readonly<
  Record<string, { readonly data: Readonly<Record<string, string>> }>
>;

export function renderDisplay(
  templates: Readonly<Record<string, string>> | undefined,
  data: DisplayData,
): Record<string, string> | undefined {
  if (templates === undefined) return undefined;

  const scope = {
    values: { jobs: data },
    deferred: new Set<string>(),
    mode: 'late' as const,
  };

  const out: Record<string, string> = {};
  for (const [key, template] of Object.entries(templates)) {
    // Пространству, кроме `jobs`, здесь взяться неоткуда: `run` и `env`
    // раскрываются перед исполнением работы, а подпись через тот этап не
    // проходит. Такое поле опускается вместе с неразрешимыми — показать
    // подстановку как текст значило бы выдать её за подпись.
    if (placeholderNamespaces(template).some((namespace) => namespace !== 'jobs')) continue;
    try {
      out[key] = interpolate(template, scope).value;
    } catch (error) {
      if (error instanceof StepcastError) continue;
      throw error;
    }
  }

  return Object.keys(out).length === 0 ? undefined : out;
}
