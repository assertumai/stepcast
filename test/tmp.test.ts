import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const FIXTURE = fileURLToPath(new URL('./tmp-fixture.js', import.meta.url));

/** Сколько ждать первой строки от фикстуры, прежде чем считать её несостоявшейся. */
const FIRST_LINE_TIMEOUT_MS = 30_000;

function runFixture(mode: string, env?: Record<string, string | undefined>): { status: number | null; lines: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [FIXTURE, mode], {
    encoding: 'utf8',
    ...(env === undefined ? {} : { env }),
  });
  return { status: result.status, lines: result.stdout.trim().split('\n'), stderr: result.stderr };
}

/**
 * Корень песочницы, напечатанный фикстурой. Пустой вывод — не «корень
 * снят», а несостоявшийся дочерний процесс: без этой проверки утверждение
 * `existsSync('')` зеленело бы, ничего не проверив.
 */
function rootOf(lines: readonly string[]): string {
  const root = lines[0] ?? '';
  assert.match(
    basename(root),
    /^stepcast-test-/,
    `фикстура обязана напечатать корень песочницы первой строкой, напечатано: ${JSON.stringify(lines)}`,
  );
  return root;
}

/**
 * Снять корень, оставленный дочерним процессом намеренно. Имя проверяется
 * перед снятием: путь берётся из вывода фикстуры, и снимать по нему что попало
 * — не то же самое, что убирать за собой.
 */
function removeRoot(root: string | undefined): void {
  if (root !== undefined && /^stepcast-test-/.test(basename(root))) {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Первая строка вывода дочернего процесса. Ожидание ограничено по времени и
 * оканчивается отказом, если процесс умер молча: у `node --test` таймаута
 * теста по умолчанию нет, и вечно висящий промис остановил бы весь прогон
 * вместо того, чтобы назвать причину.
 */
function firstLine(child: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`фикстура не напечатала корень песочницы за ${FIRST_LINE_TIMEOUT_MS} мс`));
    }, FIRST_LINE_TIMEOUT_MS);
    timer.unref();
    child.stdout!.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(chunk.toString().trim().split('\n')[0]!);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', () => {
      clearTimeout(timer);
      reject(new Error('фикстура завершилась, не напечатав корня песочницы'));
    });
  });
}

/** Дочерний процесс, прерванный сигналом после того, как напечатал свой корень. */
async function signalOutcome(
  signal: NodeJS.Signals,
  env?: Record<string, string | undefined>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; root: string; stderr: string }> {
  const child = spawn(process.execPath, [FIXTURE, 'signal-wait'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(env === undefined ? {} : { env }),
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const root = await firstLine(child);
  assert.match(basename(root), /^stepcast-test-/, `фикстура обязана напечатать корень песочницы, напечатано: ${root}`);

  child.kill(signal);
  // `close`, а не `exit`: поток ошибок к этому моменту дочитан, и напечатанное
  // перед смертью не теряется.
  const [code, sig] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  return { code, signal: sig, root, stderr };
}

describe('test/tmp: песочница временных файлов тестового процесса', () => {
  it('успешный прогон не оставляет корня на диске', () => {
    const { status, lines } = runFixture('success');
    assert.equal(status, 0);
    const root = rootOf(lines);
    assert.equal(existsSync(root), false, `корень ${root} обязан быть снят`);
  });

  it('падение утверждения не оставляет корня на диске', () => {
    const { status, lines } = runFixture('assert-fail');
    assert.notEqual(status, 0);
    const root = rootOf(lines);
    assert.equal(existsSync(root), false, `корень ${root} обязан быть снят`);
  });

  it('необработанное исключение не оставляет корня на диске', () => {
    const { status, lines } = runFixture('throw');
    assert.notEqual(status, 0);
    const root = rootOf(lines);
    assert.equal(existsSync(root), false, `корень ${root} обязан быть снят`);
  });

  it('SIGINT снимает корень и завершает процесс сигналом', async () => {
    const { code, signal, root } = await signalOutcome('SIGINT');
    assert.equal(signal, 'SIGINT');
    assert.equal(code, null, 'процесс, убитый сигналом, не возвращает числовой код');
    assert.equal(existsSync(root), false, `корень ${root} обязан быть снят`);
  });

  it('SIGTERM снимает корень и завершает процесс сигналом', async () => {
    const { code, signal, root } = await signalOutcome('SIGTERM');
    assert.equal(signal, 'SIGTERM');
    assert.equal(code, null, 'процесс, убитый сигналом, не возвращает числовой код');
    assert.equal(existsSync(root), false, `корень ${root} обязан быть снят`);
  });

  it('os.tmpdir() внутри процесса ведёт в корень песочницы', () => {
    const { status, lines } = runFixture('engine-tmpdir');
    assert.equal(status, 0);
    const root = rootOf(lines);
    const inner = lines[1];
    assert.ok(
      inner!.startsWith(`${root}/`),
      `каталог движка ${inner} обязан лежать внутри корня ${root}`,
    );
  });

  it('дочерний процесс с унаследованным окружением заводит каталог внутри родительского корня', () => {
    const { status, lines } = runFixture('spawn-parent');
    assert.equal(status, 0);
    const root = rootOf(lines);
    const childLine = lines.find((line) => line.startsWith('CHILD:'));
    assert.ok(childLine, 'дочерний процесс обязан отчитаться о своём каталоге');
    const childDir = childLine!.slice('CHILD:'.length);
    assert.ok(
      childDir.startsWith(`${root}/`),
      `каталог потомка ${childDir} обязан лежать внутри родительского корня ${root}`,
    );
  });

  it('STEPCAST_TEST_KEEP=1 оставляет корень и печатает его путь', () => {
    const { status, lines, stderr } = runFixture('success', { ...process.env, STEPCAST_TEST_KEEP: '1' });
    const [root] = lines;
    try {
      assert.equal(status, 0);
      assert.equal(existsSync(root!), true, 'сохранённый корень обязан остаться на диске');
      assert.match(basename(root!), /^stepcast-test-keep-/);
      assert.ok(stderr.includes(root!), 'путь сохранённого корня обязан быть в потоке ошибок');
    } finally {
      removeRoot(root);
    }
  });

  // Прерывание с клавиатуры — обычный конец прогона, ради разбора которого
  // корень и сохраняют: умирающий от сигнала процесс обработчиков `exit` не
  // исполняет, и путь пришлось бы искать вручную.
  it('STEPCAST_TEST_KEEP=1 печатает путь и при прерывании сигналом', async () => {
    const { signal, root, stderr } = await signalOutcome('SIGINT', { ...process.env, STEPCAST_TEST_KEEP: '1' });
    try {
      assert.equal(signal, 'SIGINT');
      assert.equal(existsSync(root), true, 'сохранённый корень обязан пережить прерывание');
      assert.match(basename(root), /^stepcast-test-keep-/);
      assert.ok(stderr.includes(root), 'путь сохранённого корня обязан быть в потоке ошибок');
    } finally {
      removeRoot(root);
    }
  });

  it('отказ уборки не меняет код возврата и называет неснятый путь', () => {
    const { status, lines, stderr } = runFixture('cleanup-fails');
    const [root, blocked] = lines;
    // Уборка охватывает и утверждения: каталог без прав переживает и корень,
    // и упавшую проверку — падение этого теста не должно добавлять к нему
    // утечку, которую он же и стережёт.
    try {
      assert.equal(status, 0, 'отказ снятия не должен красить код возврата');
      assert.ok(stderr.includes(rootOf(lines)), 'неснятый путь обязан быть назван в потоке ошибок');
    } finally {
      if (blocked !== undefined && blocked.startsWith(`${root}/`)) chmodSync(blocked, 0o700);
      removeRoot(root);
    }
  });

  it('имена внутри песочницы не начинаются с stepcast-', () => {
    const { lines } = runFixture('success');
    const root = rootOf(lines);
    const probe = lines[1];
    assert.match(basename(root), /^stepcast-test-/);
    assert.doesNotMatch(basename(probe!), /^stepcast-/);
  });
});
