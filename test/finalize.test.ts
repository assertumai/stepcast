/**
 * `scripts/finalize.mjs` больше не существует в петле: работа `finalize`
 * зовёт `stepcast backlog settle` (см. `.stepcast/jobs/finalize.yml`), и её
 * покрытие — `describe('CLI: stepcast backlog settle', …)` в
 * `test/cli-backlog.test.ts`.
 *
 * Сам файл `scripts/finalize.mjs` в этом заходе физически не убран: у
 * исполняющего заход агента нет прав на удаление файлов (см.
 * `openspec/changes/agent-cannot-clean-up/proposal.md` — то же ограничение,
 * которым обязан жить и он сам), и он остаётся мёртвым кодом до ручной
 * уборки человеком.
 */
