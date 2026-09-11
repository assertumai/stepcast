import type { ScreenDeclaration } from '../declaration.js';

/** Первый пункт бокового меню — экран по умолчанию (`ui-screens`, «Экран витрины — строка состава с двумя половинами»). */
export const declaration: ScreenDeclaration = {
  id: 'screen-runs',
  title: 'Прогоны',
  nav: { order: 0 },
  params: [],
  path: '/',
};
