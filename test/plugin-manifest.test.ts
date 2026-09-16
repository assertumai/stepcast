import assert from 'node:assert/strict';
import { readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';

import { isStepcastError } from '../src/kernel/errors.js';
import { readPluginManifest } from '../src/kernel/tree/manifest.js';
import { tempDir } from './tmp.js';

function pluginDir(): string {
  return tempDir('plugin-manifest-');
}

function writeManifest(dir: string, content: unknown): void {
  writeFileSync(join(dir, 'plugin.json'), typeof content === 'string' ? content : JSON.stringify(content));
}

describe('plugin-manifest: чтение plugin.json', () => {
  it('обе половины', () => {
    const dir = pluginDir();
    writeFileSync(join(dir, 'server.mjs'), 'export default {}\n');
    writeFileSync(join(dir, 'browser.tsx'), 'export default () => {}\n');
    writeManifest(dir, { version: '1.0.0', description: 'часы', server: 'server.mjs', browser: 'browser.tsx' });

    const manifest = readPluginManifest(dir);
    assert.equal(manifest.version, '1.0.0');
    assert.equal(manifest.description, 'часы');
    assert.equal(manifest.server, realpathSync(join(dir, 'server.mjs')));
    assert.equal(manifest.browser, realpathSync(join(dir, 'browser.tsx')));
  });

  it('только браузерная половина', () => {
    const dir = pluginDir();
    writeFileSync(join(dir, 'browser.tsx'), 'export default () => {}\n');
    writeManifest(dir, { browser: 'browser.tsx' });

    const manifest = readPluginManifest(dir);
    assert.equal(manifest.server, undefined);
    assert.equal(manifest.browser, realpathSync(join(dir, 'browser.tsx')));
  });

  it('ни одной половины — отказ, называющий манифест', () => {
    const dir = pluginDir();
    writeManifest(dir, { version: '1.0.0' });

    assert.throws(() => readPluginManifest(dir), (error: unknown) => {
      assert.ok(isStepcastError(error));
      assert.match(error.message, /половин/);
      assert.equal(error.file, join(dir, 'plugin.json'));
      return true;
    });
  });

  it('манифест не читается — файла нет', () => {
    const dir = pluginDir();

    assert.throws(() => readPluginManifest(dir), (error: unknown) => {
      assert.ok(isStepcastError(error));
      assert.equal(error.file, join(dir, 'plugin.json'));
      return true;
    });
  });

  it('манифест не разбирается как JSON', () => {
    const dir = pluginDir();
    writeManifest(dir, '{ не json');

    assert.throws(() => readPluginManifest(dir), (error: unknown) => {
      assert.ok(isStepcastError(error));
      assert.match(error.message, /JSON/);
      assert.equal(error.file, join(dir, 'plugin.json'));
      return true;
    });
  });

  it('половина указывает наружу каталога плагина', () => {
    const dir = pluginDir();
    const outsideDir = tempDir('plugin-manifest-outside-');
    writeFileSync(join(outsideDir, 'escape.mjs'), 'export default {}\n');
    writeManifest(dir, { server: `../${basename(outsideDir)}/escape.mjs` });

    assert.throws(() => readPluginManifest(dir), (error: unknown) => {
      assert.ok(isStepcastError(error));
      assert.match(error.message, /пределы/);
      assert.equal(error.at, 'server');
      return true;
    });
  });

  it('половина — символическая ссылка наружу каталога плагина', () => {
    const dir = pluginDir();
    const outsideDir = tempDir('plugin-manifest-outside-');
    const outside = join(outsideDir, 'outside.mjs');
    writeFileSync(outside, 'export default {}\n');
    symlinkSync(outside, join(dir, 'server.mjs'));
    writeManifest(dir, { server: 'server.mjs' });

    assert.throws(() => readPluginManifest(dir), (error: unknown) => {
      assert.ok(isStepcastError(error));
      assert.match(error.message, /пределы/);
      return true;
    });
  });

  it('опубликованная схема несёт то же ограничение «хотя бы одна половина», что и модель', () => {
    // Проверка `refine` в печать схемы сама не попадает (`z.toJSONSchema` видит
    // форму, не тело предиката) — без дописанного `anyOf` редактор принимал бы
    // манифест, который чтение отвергает (`user-plugins`, «Схема опубликована»).
    const schema = JSON.parse(
      readFileSync(new URL('../../schema/plugin-manifest.schema.json', import.meta.url), 'utf8'),
    ) as { readonly anyOf?: readonly { readonly required?: readonly string[] }[] };

    assert.deepEqual(
      schema.anyOf?.map((variant) => variant.required),
      [['server'], ['browser']],
    );
  });

  it('манифест не соответствует схеме — лишний ключ', () => {
    const dir = pluginDir();
    writeFileSync(join(dir, 'server.mjs'), 'export default {}\n');
    writeManifest(dir, { server: 'server.mjs', name: 'clock' });

    assert.throws(() => readPluginManifest(dir), (error: unknown) => {
      assert.ok(isStepcastError(error));
      assert.match(error.message, /name/);
      return true;
    });
  });
});
