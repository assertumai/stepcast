import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { elementSlotComponent } from '@stepcast/slots';

/**
 * Адаптер веб-компонента (design.md изменения `shared-module-table`, Решение
 * 10): плагин на другом фреймворке встаёт в слот пользовательским элементом
 * без импорта React. Регистрация самого элемента (`customElements.define`) и
 * его отрисовка в браузере требуют DOM, которого в этой проверке нет —
 * проверяется то, что проверяемо без него: адаптер отдаёт разметку с
 * объявленным именем элемента, и props слота доходят до него атрибутами
 * (design.md, Риски).
 */

describe('ui-shared-slots: адаптер веб-компонента', () => {
  it('отрисовывает элемент с объявленным именем', () => {
    const Widget = elementSlotComponent<{ readonly label: string }>('my-plugin-widget');
    const markup = renderToStaticMarkup(<Widget label="привет" />);

    assert.match(markup, /<my-plugin-widget/);
  });

  it('данные слота доходят до элемента', () => {
    const Widget = elementSlotComponent<{ readonly label: string; readonly count: number }>('my-plugin-widget');
    const markup = renderToStaticMarkup(<Widget label="привет" count={3} />);

    assert.match(markup, /label="привет"/);
    assert.match(markup, /count="3"/);
  });

  it('два разных имени элемента дают разную разметку', () => {
    const A = elementSlotComponent<{ readonly x: number }>('plugin-a');
    const B = elementSlotComponent<{ readonly x: number }>('plugin-b');

    assert.match(renderToStaticMarkup(<A x={1} />), /<plugin-a/);
    assert.match(renderToStaticMarkup(<B x={1} />), /<plugin-b/);
  });
});
