import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseWidgetImports, unresolvedSharedNames } from '../src/ui/widgetImports.js';

describe('widgetImports: разбор голых спецификаторов', () => {
  it('имя из таблицы не считается неразрешённым', () => {
    const imports = parseWidgetImports("import { useState } from 'react';\n");
    assert.deepEqual(unresolvedSharedNames(imports), []);
  });

  it('ушедшее имя названо спецификом и именем', () => {
    const imports = parseWidgetImports("import { Button, NotAName } from '@stepcast/ui';\n");
    const unresolved = unresolvedSharedNames(imports);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0]?.kind, 'name');
    assert.equal(unresolved[0]?.specifier, '@stepcast/ui');
    assert.equal(unresolved[0]?.name, 'NotAName');
  });

  /**
   * Уход целого имени из таблицы — самый вероятный вид её смены, и он обязан
   * давать признак устаревания: карта имён страницы несёт ровно специфаки
   * таблицы, и такой импорт в браузере не разрешится вовсе (design.md
   * изменения `agent-edits-widgets`, Решение 9).
   */
  it('специфика нет в таблице вовсе — неразрешим сам специфик', () => {
    const imports = parseWidgetImports("import { Gone } from 'gone-module';\n");
    const unresolved = unresolvedSharedNames(imports);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0]?.kind, 'specifier');
    assert.equal(unresolved[0]?.specifier, 'gone-module');
    assert.equal(unresolved[0]?.name, 'gone-module');
  });

  it('у неизвестного специфика он назван один раз, а не по разу на имя клаузы', () => {
    const imports = parseWidgetImports("import { A, B, C } from 'gone-module';\n");
    assert.equal(unresolvedSharedNames(imports).length, 1);
  });

  it('подпуть пакета таблицы таблицей не несётся — тоже неразрешим', () => {
    const imports = parseWidgetImports("import { createRoot } from 'react-dom/client';\n");
    assert.deepEqual(imports, [{ specifier: 'react-dom/client', names: ['createRoot'] }]);
    const unresolved = unresolvedSharedNames(imports);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0]?.kind, 'specifier');
    assert.equal(unresolved[0]?.name, 'react-dom/client');
  });

  it('относительный импорт не входит в перечень голых спецификаторов', () => {
    const imports = parseWidgetImports("import { helper } from './helper.js';\n");
    assert.deepEqual(imports, []);
  });

  it('import type разбирается так же, как обычный', () => {
    const imports = parseWidgetImports("import type { ReactNode } from 'react';\n");
    assert.deepEqual(imports, [{ specifier: 'react', names: ['ReactNode'] }]);
  });

  it('строка импорта внутри комментария импортом не считается', () => {
    const imports = parseWidgetImports("// import { X } from 'react';\n/* import { Y } from 'react'; */\n");
    assert.deepEqual(imports, []);
  });

  it('неразбираемый файл даёт пустой перечень, а не отказ', () => {
    assert.deepEqual(parseWidgetImports('\x00\x01 не код вовсе {{{'), []);
  });
});
