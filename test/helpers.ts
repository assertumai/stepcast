import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import assert from 'node:assert/strict';

import { resolveConfig, type Config } from '../src/core/config/resolve.js';
import type { AgentStep, RunStep, Step } from '../src/core/pipeline/model.js';

export interface Project {
  readonly root: string;
  readonly home: string;
  readonly config: Config;
  /** Записать файл по пути относительно корня проекта, вернуть абсолютный путь. */
  write(relativePath: string, content: string): string;
  path(relativePath: string): string;
}

/** Временный проект на диске: общий каркас для тестов раскрытия и линта. */
export function makeProject(files: Readonly<Record<string, string>> = {}): Project {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-project-'));
  const root = join(base, 'work');
  const home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, '.stepcast'), { recursive: true });

  const project: Project = {
    root,
    home,
    config: resolveConfig({
      cwd: root,
      home,
      globalPath: join(home, '.stepcast', 'config.yml'),
      projectPath: join(root, '.stepcast', 'config.yml'),
    }).config,
    write(relativePath, content) {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      return full;
    },
    path(relativePath) {
      return join(root, relativePath);
    },
  };

  for (const [name, content] of Object.entries(files)) project.write(name, content);
  return project;
}

/** Минимальный пайплайн с одним шагом командной строки. */
export const MINIMAL_PIPELINE = `
version: 1
kind: pipeline
name: minimal
jobs:
  build:
    steps:
      - id: compile
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`;

/** Сузить шаг до командного, заодно проверив тип. */
export function asRun(step: Step): RunStep {
  assert.equal(step.kind, 'run', `шаг ${step.id} ожидался командным`);
  return step as RunStep;
}

/** Сузить шаг до агентского, заодно проверив тип. */
export function asAgent(step: Step): AgentStep {
  assert.equal(step.kind, 'agent', `шаг ${step.id} ожидался агентским`);
  return step as AgentStep;
}
