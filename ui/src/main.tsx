import { StrictMode } from 'react';
import * as ReactNamespace from 'react';
import * as ReactDomNamespace from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as JsxRuntimeNamespace from 'react/jsx-runtime';

import { WIDGET_RUNTIME_GLOBAL, type WidgetRuntimeSpecifier } from '../../src/ui/widgetRuntime';
import { createBrowserKernel } from './kernel';
import { KernelRoot } from './slots.tsx';
import runs from './plugins/runs';
import shell from './plugins/shell';
import './styles.css';

/**
 * Публикация экземпляра React страницы — до первой отрисовки, чтобы
 * переходники (`/widgets/runtime/<имя>.js`) нашли его к моменту первого
 * `import()` виджета (design.md изменения `ui-runtime-widget-spike`,
 * Решение 3). Без общего экземпляра виджет, получивший свой React, молча
 * ломает хуки.
 */
(globalThis as Record<string, unknown>)[WIDGET_RUNTIME_GLOBAL] = {
  react: ReactNamespace,
  'react-dom': ReactDomNamespace,
  'react/jsx-runtime': JsxRuntimeNamespace,
} satisfies Record<WidgetRuntimeSpecifier, unknown>;

/**
 * Ядро поднимается здесь, вне дерева React и до первой отрисовки (design.md
 * `cordis-kernel-browser`, Решение 13) — тем же порядком «сначала то, что
 * обязано быть единственным, потом отрисовка», что и публикация React для
 * виджетов выше. `StrictMode` в разработке вызывает эффекты дважды: ядро,
 * заводимое эффектом, удвоило бы регистрации или подняло бы второе.
 *
 * `shell` и `runs` — встроенные плагины (design.md, Решение 8), применённые
 * сразу же вслед за ядром: их отказ, если случится, соберёт `settle()`
 * рендерера корня (`KernelRoot`), а не прервёт загрузку здесь (design.md,
 * Решение 6, — отказы собираются, а не бросаются из вызова).
 */
const kernel = createBrowserKernel();
kernel.ctx.plugin(shell);
kernel.ctx.plugin(runs);

const container = document.getElementById('root');
if (container === null) throw new Error('Разметка витрины без корневого элемента');

createRoot(container).render(
  <StrictMode>
    <KernelRoot kernel={kernel} />
  </StrictMode>,
);
