import { existsSync } from 'node:fs';

import { runPaths } from '../../../pipeline/run/journal/paths.js';
import { isStepcastError } from '../../../../kernel/errors.js';
import { INVALID, readNonNegativeInt, sendJson } from '../../daemon/http.js';
import { readJournalFile } from '../../file.js';
import { parseRunAddress, snapshotOrRecord } from '../../runAddress.js';
import { isSafeSegment } from '../../routes.js';
import { readStepOutput } from '../../stepOutput.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

const handleSnapshot: ApiHandler = (req, res, env) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const parsed = parseRunAddress(url.searchParams.get('run'));
  if (parsed === undefined) {
    sendJson(res, 400, { error: 'Run address must look like <project>/<run>' });
    return;
  }

  const snapshot = snapshotOrRecord(env.runsRoot, parsed.key, parsed.runId);
  if (snapshot === undefined) {
    sendJson(res, 404, { error: `Run ${parsed.runId} not found` });
    return;
  }

  sendJson(res, 200, snapshot);
};

const handleFile: ApiHandler = (req, res, env) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const parsed = parseRunAddress(url.searchParams.get('run'));
  const requested = url.searchParams.get('path');

  if (parsed === undefined || requested === null) {
    sendJson(res, 400, { error: 'Parameters run=<project>/<run> and path are required' });
    return;
  }

  const paths = runPaths(env.runsRoot, parsed.key, parsed.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Run ${parsed.runId} not found` });
    return;
  }

  // Умолчание — хвост: без параметра просят лог, а у лога интересен конец.
  const side = url.searchParams.get('side') === 'head' ? 'head' : 'tail';

  try {
    sendJson(res, 200, readJournalFile(paths.dir, requested, side));
  } catch (error) {
    // Выход за каталог прогона — ошибка клиента, а не сбой сервера.
    const message = isStepcastError(error) ? error.message : 'File cannot be read';
    sendJson(res, isStepcastError(error) ? 400 : 404, { error: message });
  }
};

/**
 * Вывод шага по логическому адресу: прогон, работа, шаг, попытка, смещение.
 *
 * Путь файла клиент не подаёт вовсе (design.md, Решение 1) — разрешает его
 * `readStepOutput` через `findStepDir` на каждый запрос, поэтому проверять
 * выход за каталог прогона здесь нечего: обход невозможен по устройству.
 * Идентификаторы работы и шага всё равно проходят проверку сегмента, как и
 * везде в этом файле.
 */
const handleStepOutput: ApiHandler = (req, res, env) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const parsed = parseRunAddress(url.searchParams.get('run'));
  const jobId = url.searchParams.get('job');
  const stepId = url.searchParams.get('step');

  if (
    parsed === undefined ||
    jobId === null ||
    stepId === null ||
    !isSafeSegment(jobId) ||
    !isSafeSegment(stepId)
  ) {
    sendJson(res, 400, {
      error: 'Parameters run=<project>/<run>, job and step (single layout segments) are required',
    });
    return;
  }

  const paths = runPaths(env.runsRoot, parsed.key, parsed.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Run ${parsed.runId} not found` });
    return;
  }

  const attempt = readNonNegativeInt(url, 'attempt');
  if (attempt === INVALID || attempt === 0) {
    sendJson(res, 400, { error: 'attempt must be a positive integer' });
    return;
  }

  const stdoutOffset = readNonNegativeInt(url, 'stdoutOffset');
  const stderrOffset = readNonNegativeInt(url, 'stderrOffset');
  if (stdoutOffset === INVALID || stderrOffset === INVALID) {
    sendJson(res, 400, { error: 'stdoutOffset and stderrOffset must be non-negative numbers' });
    return;
  }

  try {
    sendJson(
      res,
      200,
      readStepOutput(paths, jobId, stepId, {
        ...(attempt === undefined ? {} : { attempt }),
        ...(stdoutOffset === undefined ? {} : { stdoutOffset }),
        ...(stderrOffset === undefined ? {} : { stderrOffset }),
      }),
    );
  } catch (error) {
    // Чтение с диска гоняется с удалением прогона и с ротацией файлов: между
    // проверкой существования и чтением каталог шага может исчезнуть. Опрос
    // раз в секунду на каждое раскрытое окно делает эту гонку рядовой, а
    // необработанное исключение в слушателе запроса роняет весь демон —
    // отвечать надо одному запросу, как это делает `handleFile`.
    const message = isStepcastError(error) ? error.message : 'Step output cannot be read';
    sendJson(res, isStepcastError(error) ? 400 : 404, { error: message });
  }
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/run', handleSnapshot);
  ctx.api.register('GET', '/api/file', handleFile);
  ctx.api.register('GET', '/api/step-output', handleStepOutput);
});
