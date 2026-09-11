import type { ScreenDeclaration } from '../declaration.js';

/**
 * `period` — необязательный (`:period?`): голый `/usage` разбирается тем же
 * экраном, без параметра.
 *
 * Перечень значений закрыт: пресеты периода объявляет сам экран, и адрес с
 * чужим значением (`/usage/вчера`) этому экрану не принадлежит — он ведёт на
 * экран по умолчанию, как вёл до перевода экранов в строки состава
 * (`ui-screens`, «Переведённые экраны не меняют поведения»). Отсюда же
 * браузерная половина берёт состав и порядок переключателя
 * (`ui/src/screens/usagePeriods.ts`): перечень один на обе половины.
 */
export const declaration: ScreenDeclaration = {
  id: 'screen-usage',
  title: 'Расход',
  nav: { order: 5 },
  params: ['period'],
  path: '/usage/:period?',
  paramValues: { period: ['7d', '30d', '90d', 'all'] },
};
