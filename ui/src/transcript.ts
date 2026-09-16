/**
 * Разбор потока шага — реэкспорт общего с демоном модуля.
 *
 * Сами правила лежат в `src/parts/ui/transcript.ts`: они чистые, и там их достаёт
 * обычный тест (`test/ui-transcript.test.ts`). Здесь остаётся привычный
 * витрине путь импорта, тот же, что у `format.ts` над `src/parts/ui/format.ts`.
 */

export {
  mergeToolOutcomes,
  parseTranscript,
  type ParsedTranscript,
  type ResultEntry,
  type RawEntry,
  type ReplyEntry,
  type SessionEntry,
  type ToolCallEntry,
  type ToolOutcome,
  type ToolResultEntry,
  type TranscriptEntry,
} from '../../src/parts/ui/transcript';
