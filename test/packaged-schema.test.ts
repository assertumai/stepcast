import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/core/errors.js';
import { judgeVerdictSchemaPath } from '../src/core/expect/verdict.js';
import { packagedSchemaPath } from '../src/core/package-schema.js';

interface PackageSchemaModule {
  readonly packagedSchemaPath: (name: string) => string;
}

/**
 * Поддельная установка движка: копия скомпилированного ядра рядом со своим
 * `package.json` и со своим каталогом `schema/` (либо вовсе без него).
 *
 * Прогон идёт из `dist/`, и разрешение имени в самом прогоне доказывает только
 * эту раскладку. Копия ядра в чужом каталоге — вторая раскладка: если
 * разрешение и правда идёт от расположения движка, а не от каталога запуска и
 * не от места объявления, копия обязана найти схему своей установки, а не
 * схему этого репозитория.
 */
async function fakeInstall(schemaNames?: readonly string[]): Promise<{
  readonly root: string;
  readonly module: PackageSchemaModule;
}> {
  // realpath: на macOS каталог временных файлов — символическая ссылка
  // (`/var` → `/private/var`), а движок возвращает путь уже разрешённым.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stepcast-pkg-')));
  writeFileSync(join(root, 'package.json'), '{ "name": "stepcast", "type": "module" }\n');
  cpSync(fileURLToPath(new URL('../src/core', import.meta.url)), join(root, 'src', 'core'), {
    recursive: true,
  });

  if (schemaNames !== undefined) {
    mkdirSync(join(root, 'schema'));
    for (const name of schemaNames) {
      writeFileSync(join(root, 'schema', `${name}.schema.json`), '{ "type": "object" }\n');
    }
  }

  const module = (await import(
    pathToFileURL(join(root, 'src', 'core', 'package-schema.js')).href
  )) as PackageSchemaModule;
  return { root, module };
}

describe('package-schema: схема, поставляемая пакетом', () => {
  it('резолвит имя в существующий файл, читаемый как JSON', () => {
    const path = packagedSchemaPath('backlog-slots');
    assert.ok(existsSync(path), `схема не найдена: ${path}`);
    assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')));
  });

  it('отказывает на имени с .. до обращения к файловой системе', () => {
    assert.throws(() => packagedSchemaPath('../../etc/passwd'), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /kebab-case/);
      return true;
    });
  });

  it('отказывает на пустом имени', () => {
    assert.throws(() => packagedSchemaPath(''), StepcastError);
  });

  it('отказывает на неизвестном имени, называя перечень поставляемых схем', () => {
    assert.throws(() => packagedSchemaPath('no-such'), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /no-such/);
      assert.match(error.hint ?? '', /backlog-slots/);
      return true;
    });
  });

  it('judgeVerdictSchemaPath по-прежнему указывает на существующий файл', () => {
    assert.ok(existsSync(judgeVerdictSchemaPath()));
  });

  it('другая раскладка установки даёт схему своей установки, а не этого дерева', async () => {
    const { root, module } = await fakeInstall(['backlog-slots']);

    assert.equal(
      module.packagedSchemaPath('backlog-slots'),
      join(root, 'schema', 'backlog-slots.schema.json'),
    );
    assert.notEqual(module.packagedSchemaPath('backlog-slots'), packagedSchemaPath('backlog-slots'));
  });

  it('установка без каталога schema/ отказывает ошибкой конфигурации, а не ошибкой чтения', async () => {
    const { module } = await fakeInstall();

    assert.throws(
      () => module.packagedSchemaPath('backlog-slots'),
      (error: unknown) => {
        // Тип сверяется по имени: копия ядра несёт собственный класс ошибки,
        // и `instanceof` через границу двух загрузок модуля не работает.
        assert.equal((error as Error).name, 'StepcastError');
        assert.equal((error as { exitCode?: number }).exitCode, 2);
        assert.match((error as { hint?: string }).hint ?? '', /установка пакета stepcast неполна/);
        return true;
      },
    );
  });
});
