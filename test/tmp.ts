import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Признак разбора: без него дальше в этом модуле нет способа оставить
// песочницу на диске намеренно (design.md, «Сохранение ради разбора —
// признаком окружения»).
const keep = process.env['STEPCAST_TEST_KEEP'] === '1';

// Заводится один раз на процесс — импорт модуля кэшируется рантаймом ESM.
// Прямо в настоящем `$TMPDIR`, поэтому свойства пути (символьные ссылки
// платформы вроде `/var` → `/private/var` на macOS) не меняются.
const root = mkdtempSync(join(tmpdir(), keep ? 'stepcast-test-keep-' : 'stepcast-test-'));

// Перевод происходит до тела любого теста: импорты вычисляются раньше него,
// а прямое создание запрещено линтом — значит всякий, кому нужен временный
// каталог, либо уже импортировал этот модуль, либо позовёт `tmpdir()` позже,
// когда переменные уже смотрят сюда. Из-за этого внутрь песочницы попадает и
// то, что заводит не тест: движок под тестом, дочерние процессы, `git`.
process.env['TMPDIR'] = root;
process.env['TMP'] = root;
process.env['TEMP'] = root;

/** Снять корень; отказ не должен красить прогон — только назвать путь. */
function cleanup(): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`stepcast: не удалось снять песочницу ${root}: ${String(error)}\n`);
  }
}

/** Назвать сохранённый корень: без пути от признака разбора нет толку. */
function reportKept(): void {
  process.stderr.write(`stepcast: песочница сохранена для разбора — ${root}\n`);
}

if (keep) {
  process.on('exit', reportKept);
} else {
  // Единственная точка, исполняемая при любом исходе: успех, падение
  // утверждения, брошенное мимо теста исключение, `process.exit` изнутри
  // теста (design.md, «Уборка привязана к процессу, а не к тесту»).
  process.on('exit', cleanup);
}

/**
 * `SIGINT`/`SIGTERM` убирают песочницу и переподнимают сигнал вместо того,
 * чтобы завершить процесс самим: снятый перед повторной отправкой листенер
 * возвращает сигналу штатную обработку, и код завершения остаётся тем же
 * сигнальным, что и без песочницы.
 *
 * От умирающего по сигналу процесса обработчики `exit` не исполняются, поэтому
 * путь сохранённого корня печатается здесь же: прерывание с клавиатуры — самый
 * обычный способ закончить прогон, ради разбора которого корень и сохраняют.
 */
function handleSignal(this: NodeJS.Process, signal: NodeJS.Signals): void {
  if (keep) reportKept();
  else cleanup();
  this.removeListener(signal, handleSignal);
  this.kill(this.pid, signal);
}

process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);

/** Каталог внутри песочницы. Имена — по назначению, без префикса `stepcast-`. */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(root, prefix));
}
