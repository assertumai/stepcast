import type { ScreenDeclaration } from '../declaration.js';

/**
 * Экран «Решения» (`user-decision-steps`, design.md решение 11): таблица
 * ожидающих прогонов, собранная из обзора, который витрина уже получает
 * живьём по `GET /api/events` — своего маршрута чтения экран не заводит.
 */
export const declaration: ScreenDeclaration = {
  id: 'screen-decisions',
  title: 'Decisions',
  params: [],
};
