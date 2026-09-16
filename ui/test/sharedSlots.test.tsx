import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SHARED_MODULES } from '../../src/parts/ui/daemon/sharedModules.ts';
import * as SharedSlots from '@stepcast/slots';
import { SCREEN as ShellScreen } from '../src/plugins/shell.tsx';

/**
 * Поверхность `@stepcast/slots` (design.md изменения `shared-module-table`,
 * Решение 5): перечень записи таблицы обязан совпадать с тем, что модуль
 * действительно экспортирует (Решение 4), а дескриптор встроенного слота —
 * быть тем же значением, которым пользуется каркас, а не его копией (Решение
 * 2 таблицы — «копия дескриптора второго экземпляра» прямо названа поломкой).
 */

describe('ui-shared-slots: перечень записи таблицы не расходится с модулем', () => {
  it('каждое объявленное имя действительно экспортируется', () => {
    const mod = SharedSlots as unknown as Record<string, unknown>;
    const missing = SHARED_MODULES['@stepcast/slots'].names.filter(
      (name) => !Object.prototype.hasOwnProperty.call(mod, name),
    );
    assert.deepEqual(missing, [], 'перечень записи разошёлся с реальным экспортом ui/src/sharedSlots.ts');
  });

  it('отсутствующее в реальном экспорте имя проверка называет', () => {
    const mod = SharedSlots as unknown as Record<string, unknown>;
    const withBogusName = [...SHARED_MODULES['@stepcast/slots'].names, 'совсемНеСуществующееИмя'];
    const missing = withBogusName.filter((name) => !Object.prototype.hasOwnProperty.call(mod, name));
    assert.deepEqual(missing, ['совсемНеСуществующееИмя']);
  });

  it('модуль не экспортирует лишнего сверх объявленного перечня', () => {
    const declared = new Set(SHARED_MODULES['@stepcast/slots'].names);
    const extra = Object.keys(SharedSlots).filter((name) => !declared.has(name));
    assert.deepEqual(extra, [], 'модуль экспортирует имя, не названное записью таблицы');
  });
});

describe('ui-shared-slots: дескриптор — то же значение, которым пользуется каркас', () => {
  it('SCREEN из поверхности и SCREEN каркаса — один и тот же объект', () => {
    assert.equal(SharedSlots.SCREEN, ShellScreen);
  });
});
