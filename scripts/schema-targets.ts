import type { z } from 'zod';

import { PipelineDocumentSchema, JobDocumentSchema } from '../src/core/pipeline/schema.js';
import { RawConfigSchema } from '../src/core/config/schema.js';
import { BacklogItemSchema, BacklogSlotsResponseSchema } from '../src/core/backlog/schema.js';

/**
 * Перечень целей генерации JSON Schema — общий для скрипта печати
 * (`generate-schema.ts`) и для теста их свежести (`test/schema-generated.test.ts`):
 * расхождение между печатаемым и проверяемым перечнем было бы той же бедой,
 * от которой уходит генерация схем из моделей.
 */
export interface SchemaTarget {
  readonly file: string;
  readonly schema: z.ZodType;
  readonly title: string;
  /** Форма документа: `input` — то, что пишет человек, `output` — то, что печатает команда. */
  readonly io: 'input' | 'output';
}

export const SCHEMA_TARGETS: readonly SchemaTarget[] = [
  { file: 'schema/pipeline.schema.json', schema: PipelineDocumentSchema, title: 'stepcast pipeline', io: 'input' },
  { file: 'schema/job.schema.json', schema: JobDocumentSchema, title: 'stepcast job', io: 'input' },
  { file: 'schema/config.schema.json', schema: RawConfigSchema, title: 'stepcast config', io: 'input' },
  {
    file: 'schema/backlog.schema.json',
    schema: BacklogItemSchema,
    title: 'stepcast backlog item',
    io: 'input',
  },
  {
    file: 'schema/backlog-slots.schema.json',
    schema: BacklogSlotsResponseSchema,
    title: 'stepcast backlog pick --lanes',
    io: 'output',
  },
];
