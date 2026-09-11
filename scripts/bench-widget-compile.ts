import { mkdtempSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Замер компилятора виджетов: `esbuild` (нативный бинарник) против
 * `esbuild-wasm` — вопрос design.md изменения `ui-runtime-widget-spike`
 * (Решение 1). Печатает число, а не мнение: холодный первый вызов, тёплый
 * вызов, вес установленного пакета и поведение при отсутствии платформенного
 * бинарника — на одном представительном виджете (хук, эффект, JSX,
 * обработчик клика).
 *
 * Имя кандидата уходит в `import()` вычисленной строкой, а не литералом:
 * литерал заставил бы модульный резолвер требовать оба пакета установленными
 * и типизированными разом, а решение по итогу замера оставляет в
 * `dependencies` только одного из них. Так скрипт типизируется и запускается,
 * даже когда установлен только победивший кандидат — второй превращается в
 * назван­ную ошибку импорта, ту же, что получит демон при отсутствии
 * бинарника (Риск 1 design.md).
 */

const WIDGET_SOURCE = `
import { useEffect, useState } from 'react';

export default function Clock() {
  const [now, setNow] = useState(() => new Date());
  const [ticking, setTicking] = useState(true);

  useEffect(() => {
    if (!ticking) return undefined;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  return (
    <div className="widget-clock">
      <p>{now.toLocaleTimeString()}</p>
      <button onClick={() => setTicking((value) => !value)}>
        {ticking ? 'Пауза' : 'Пуск'}
      </button>
    </div>
  );
}
`;

const WARM_ITERATIONS = 50;

interface EsbuildLike {
  transform(input: string, options: Record<string, unknown>): Promise<{ code: string }>;
  stop(): Promise<void> | void;
}

/** Размер каталога рекурсивно, в байтах — без вызова `du`, чтобы замер был переносим. */
function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    total += stat.isDirectory() ? dirSizeBytes(full) : stat.size;
  }
  return total;
}

function formatMs(ms: number): string {
  return `${ms.toFixed(2)} мс`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Каталоги установки кандидата в `node_modules` — платформенные пакеты esbuild ставятся рядом, под `@esbuild/*`. */
function installedDirs(candidate: string): readonly string[] {
  // Скрипт компилируется в `dist/scripts/`; `node_modules` — двумя уровнями выше.
  const root = fileURLToPath(new URL('../../node_modules', import.meta.url));
  if (candidate === 'esbuild') {
    return [join(root, 'esbuild'), join(root, '@esbuild')];
  }
  return [join(root, 'esbuild-wasm')];
}

async function measure(candidate: string): Promise<void> {
  console.log(`\n=== ${candidate} ===`);

  const installBytes = installedDirs(candidate).reduce((sum, dir) => sum + dirSizeBytes(dir), 0);
  console.log(`вес установки: ${formatBytes(installBytes)}`);

  let mod: EsbuildLike;
  try {
    // Вычисленный специфик: см. заголовок файла — литеральный import() заставил
    // бы резолвер требовать пакет физически установленным на типизации.
    mod = (await import(candidate)) as unknown as EsbuildLike;
  } catch (error) {
    console.log(`импорт отказал: ${(error as Error).message}`);
    // Проигравший кандидат в зависимостях не остаётся (docs/widgets.md,
    // раздел о компиляторе), поэтому отказ импорта — обычное состояние, а не
    // беда: замер обязан называть, чем его починить.
    console.log(`поставьте кандидата одним разом и повторите: npm install --no-save ${candidate}`);
    return;
  }

  const options = { loader: 'tsx', jsx: 'automatic' };

  const coldStart = performance.now();
  try {
    await mod.transform(WIDGET_SOURCE, options);
  } catch (error) {
    console.log(`холодный вызов отказал: ${(error as Error).message}`);
    return;
  }
  const coldMs = performance.now() - coldStart;
  console.log(`холодный первый вызов (с подъёмом службы): ${formatMs(coldMs)}`);

  const warmStart = performance.now();
  for (let i = 0; i < WARM_ITERATIONS; i += 1) {
    await mod.transform(WIDGET_SOURCE, options);
  }
  const warmMs = (performance.now() - warmStart) / WARM_ITERATIONS;
  console.log(`тёплый вызов (среднее по ${WARM_ITERATIONS}): ${formatMs(warmMs)}`);

  await mod.stop();
}

/**
 * Поведение нативного `esbuild` с платформенным бинарником, который есть на
 * диске, но не исполняется, — `ESBUILD_BINARY_PATH` указывает на обычный
 * файл. Путь, которого нет вовсе, `esbuild` тихо игнорирует и откатывается на
 * штатный бинарник (проверено вручную): не воспроизводит риск 1 design.md —
 * «бинарник не ставится» на урезанном образе выглядит именно так, файлом без
 * прав на исполнение, а не отсутствующим путём. Проверяется отдельным
 * процессом — модуль держит путь к бинарнику в своём состоянии между
 * вызовами, и подмена переменной после первого импорта в этом же процессе
 * ничего не изменит.
 */
async function measureMissingBinary(): Promise<void> {
  console.log('\n=== esbuild с неисполняемым бинарником (Риск 1 design.md) ===');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'stepcast-esbuild-bench-'));
  const fakeBinary = join(dir, 'esbuild');
  // Обычные права создания файла — без бита исполнения: спавн обязан отказать.
  writeFileSync(fakeBinary, '#!/bin/sh\necho not a real esbuild\n');

  const probe = `
    (async () => {
      try {
        const esbuild = await import('esbuild');
        await esbuild.transform('const x = 1;', { loader: 'tsx' });
        console.log('неожиданно прошло без ошибки');
      } catch (error) {
        console.log('отказ: ' + error.message.split('\\n')[0]);
      }
    })();
  `;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      env: { ...process.env, ESBUILD_BINARY_PATH: fakeBinary },
      encoding: 'utf8',
      timeout: 15_000,
    });
    console.log(out.trim());
  } catch (error) {
    console.log(`дочерний процесс отказал: ${(error as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('esbuild-wasm тем же вопросом не задаётся: платформенного бинарника у него нет вовсе.');
}

async function main(): Promise<void> {
  console.log(`представительный виджет: ${WIDGET_SOURCE.trim().split('\n').length} строк, хук + эффект + JSX`);
  await measure('esbuild');
  await measure('esbuild-wasm');
  await measureMissingBinary();
}

await main();
