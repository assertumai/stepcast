import { h, render, type ComponentChild } from 'preact';
import { useState } from 'preact/hooks';
import type { Context } from 'cordis';
import { elementSlotComponent, SCREEN } from '@stepcast/slots';

/**
 * Образец плагина на другом фреймворке (design.md изменения
 * `shared-module-table`, Решение 10): Preact бандлится вместе с плагином —
 * не имя таблицы общих модулей, а собственный вес плагина — и в слот встаёт
 * пользовательским элементом через адаптер `elementSlotComponent`, а не
 * компонентом React. Ни `react`, ни `react-dom`, ни `cordis` (кроме типа
 * `Context` — стирается компиляцией, в бандле его нет) этот файл не
 * импортирует.
 */

const TAG = 'stepcast-example-clock';

function Clock(): ComponentChild {
  const [count, setCount] = useState(0);
  return h('button', { type: 'button', onClick: () => setCount((n) => n + 1) }, `тик: ${count}`);
}

class ClockElement extends HTMLElement {
  connectedCallback(): void {
    render(h(Clock, {}), this);
  }

  disconnectedCallback(): void {
    render(null, this);
  }
}

export default function element(ctx: Context): void {
  // Реестр пользовательских элементов браузера неизменен — то же свойство,
  // что и у реестра модулей замены (docs/ui-plugins.md, «Что снимается
  // вместе с вкладом»): снять регистрацию нечем, а повторный `define` того
  // же имени бросает. Плагин обязан проверить `customElements.get` перед
  // объявлением — это и есть вся защита от повторной загрузки строки.
  if (customElements.get(TAG) === undefined) {
    customElements.define(TAG, ClockElement);
  }

  ctx.slots.contribute(SCREEN, { component: elementSlotComponent(TAG), key: 'element-example' });
}
