import type { ScreenDeclaration } from '../declaration.js';

/** Без маршрутов собственных: данные приходят потоком событий (`ui-screens`, «screen-widgets»). */
export const declaration: ScreenDeclaration = {
  id: 'screen-widgets',
  title: 'Виджеты',
  nav: { order: 3 },
  params: [],
  path: '/widgets',
};
