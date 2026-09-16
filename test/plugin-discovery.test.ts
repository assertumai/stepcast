import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { discoverPluginDirectories, pluginsDirPath } from '../src/kernel/tree/discover.js';
import { tempDir } from './tmp.js';

describe('plugin-discovery: обход каталога плагинов слоя', () => {
  it('каталога плагинов нет вовсе — пустой список без ошибки', () => {
    const root = tempDir('plugin-discovery-');
    assert.deepEqual(discoverPluginDirectories(pluginsDirPath(root), 'home', []), []);
  });

  it('каталоги верхнего уровня становятся операциями, отсортированными по имени', () => {
    const root = tempDir('plugin-discovery-');
    mkdirSync(join(pluginsDirPath(root), 'clock'), { recursive: true });
    mkdirSync(join(pluginsDirPath(root), 'analytics'), { recursive: true });

    const operations = discoverPluginDirectories(pluginsDirPath(root), 'project', []);
    assert.deepEqual(operations.map((op) => op.id), ['analytics', 'clock']);
    assert.equal(operations[0]?.kind, 'directory');
    assert.equal(operations[0]?.use, join(pluginsDirPath(root), 'analytics'));
    assert.equal(operations[0]?.layer, 'project');
    assert.equal(operations[0]?.failure, undefined);
  });

  it('каталог без plugin.json — обычная операция строки: она отказывает позже, при загрузке', () => {
    const root = tempDir('plugin-discovery-');
    mkdirSync(join(pluginsDirPath(root), 'broken'), { recursive: true });

    const operations = discoverPluginDirectories(pluginsDirPath(root), 'home', []);
    assert.deepEqual(operations.map((op) => op.id), ['broken']);
    assert.equal(operations[0]?.use, join(pluginsDirPath(root), 'broken'));
    assert.equal(operations[0]?.failure, undefined);
  });

  it('файл верхнего уровня каталога плагинов не считается плагином', () => {
    const root = tempDir('plugin-discovery-');
    mkdirSync(pluginsDirPath(root), { recursive: true });
    mkdirSync(join(pluginsDirPath(root), 'real'), { recursive: true });
    // Файл рядом — не каталог, не должен попасть в перечень.
    writeFileSync(join(pluginsDirPath(root), 'notes.txt'), 'x');

    const operations = discoverPluginDirectories(pluginsDirPath(root), 'home', []);
    assert.deepEqual(operations.map((op) => op.id), ['real']);
  });

  it('вложенность глубже уровня не обходится', () => {
    const root = tempDir('plugin-discovery-');
    mkdirSync(join(pluginsDirPath(root), 'clock', 'nested'), { recursive: true });

    const operations = discoverPluginDirectories(pluginsDirPath(root), 'home', []);
    assert.deepEqual(operations.map((op) => op.id), ['clock']);
  });

  it('каталог, названный идентификатором встроенной строки, даёт строку с отказом, а не исключение обхода', () => {
    const root = tempDir('plugin-discovery-');
    mkdirSync(join(pluginsDirPath(root), 'backend-claude'), { recursive: true });
    mkdirSync(join(pluginsDirPath(root), 'clock'), { recursive: true });

    const operations = discoverPluginDirectories(pluginsDirPath(root), 'home', ['backend-claude']);

    assert.deepEqual(operations.map((op) => op.id), ['backend-claude', 'clock'], 'соседний каталог обойдён как обычно');
    const reserved = operations.find((op) => op.id === 'backend-claude');
    assert.match(reserved?.failure?.message ?? '', /backend-claude/);
    assert.match(reserved?.failure?.hint ?? '', /патч/);
    assert.equal(operations.find((op) => op.id === 'clock')?.failure, undefined);
  });

  it('каталог, названный идентификатором строки поставки вызывающего, тоже отказывает', () => {
    const root = tempDir('plugin-discovery-');
    mkdirSync(join(pluginsDirPath(root), 'ui-shell'), { recursive: true });

    const operations = discoverPluginDirectories(pluginsDirPath(root), 'project', ['backend-claude', 'ui-shell']);
    assert.match(operations[0]?.failure?.message ?? '', /ui-shell/);
  });
});
