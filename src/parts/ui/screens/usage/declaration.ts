import type { ScreenDeclaration } from '../declaration.js';

/**
 * `period` — необязательный параметр пути маршрута (`ui-routes`): голый
 * `/usage` разбирается тем же экраном, без параметра. Закрытый перечень
 * значений и путь — теперь поля маршрута (`src/builtin/routes.yml`), а не
 * этого объявления; браузерная половина берёт состав и порядок переключателя
 * из маршрута, которым экран открыт (`ui/src/screens/usagePeriods.ts`).
 */
export const declaration: ScreenDeclaration = {
  id: 'screen-usage',
  title: 'Usage',
  params: ['period'],
};
