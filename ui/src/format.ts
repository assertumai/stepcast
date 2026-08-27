/**
 * Форматирование величин — реэкспорт общего с демоном модуля.
 *
 * Сами правила лежат в `src/ui/format.ts`: они чистые, и там их достаёт
 * обычный тест (`test/ui-format.test.ts`). Здесь остаётся привычный витрине
 * путь импорта, тот же, что у `router.tsx` над `routes.ts`.
 */

export { fmtBytes, fmtDuration, fmtMoney, fmtTime, fmtTokens } from '../../src/ui/format';
