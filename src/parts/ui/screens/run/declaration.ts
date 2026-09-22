import type { ScreenDeclaration } from '../declaration.js';

/** Страница прогона: без пункта меню — открывается ссылкой из экрана прогонов (`ui-screens`, «Экран без пункта меню»). */
export const declaration: ScreenDeclaration = {
  id: 'screen-run',
  title: 'Run',
  params: ['projectKey', 'runId'],
};
