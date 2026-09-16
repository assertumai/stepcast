/**
 * Разбор `pipeline.lock.yml` переехал в `src/parts/pipeline/document/lockRead.ts`:
 * `stepcast diff` тоже читает замок (design.md изменения
 * lock-records-session-group, Решение 3), а `src/core` не импортирует
 * `src/ui`. Этот файл — только переадресация; новый код обязан импортировать
 * `readLockJobs`, `LockJob` и `LockStep` напрямую из ядра.
 */
export * from '../pipeline/document/lockRead.js';
