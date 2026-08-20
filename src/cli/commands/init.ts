import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { StepcastError, ExitCode, type ExitCodeValue } from '../../core/errors.js';
import type { ParsedArgs } from '../args.js';

/**
 * Шаблон нарочно без агентского бэкенда: `stepcast init && stepcast run
 * stepcast.yml` должен работать сразу после установки, без Claude Code и без
 * сетевого доступа.
 */
const PIPELINE_TEMPLATE = `version: 1
kind: pipeline
name: example

jobs:
  build:
    description: Командный шаг, показывающий структуру файла
    steps:
      - id: check
        run: [echo, ok]
        expect:
          - exit_code: 0

  example:
    description: Работа, вынесенная в отдельный файл через uses
    needs: [build]
    uses: .stepcast/jobs/example.yml
`;

const EXAMPLE_JOB_TEMPLATE = `version: 1
kind: job

steps:
  - id: hello
    run: [echo, "привет из отдельного файла работы"]
    expect:
      - exit_code: 0
`;

export function runInitCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): ExitCodeValue {
  const force = args.flags.force === true;
  const pipelinePath = join(cwd, 'stepcast.yml');

  if (existsSync(pipelinePath) && !force) {
    throw new StepcastError(`${pipelinePath} уже существует`, {
      file: pipelinePath,
      hint: 'Передайте --force, чтобы перезаписать',
    });
  }

  const examplePath = join(cwd, '.stepcast', 'jobs', 'example.yml');
  mkdirSync(dirname(examplePath), { recursive: true });
  writeFileSync(pipelinePath, PIPELINE_TEMPLATE);
  writeFileSync(examplePath, EXAMPLE_JOB_TEMPLATE);

  write(`создан ${pipelinePath}`);
  write(`создан ${examplePath}`);
  return ExitCode.ok;
}
