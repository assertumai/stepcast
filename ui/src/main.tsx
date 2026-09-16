import { StrictMode } from 'react';
import * as ReactNamespace from 'react';
import * as ReactDomNamespace from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as JsxRuntimeNamespace from 'react/jsx-runtime';
import * as CordisNamespace from 'cordis';
import * as SharedSlotsNamespace from '@stepcast/slots';
import * as SharedUiNamespace from '@stepcast/ui';

import { WIDGET_RUNTIME_GLOBAL } from '../../src/parts/ui/daemon/sharedModules';
import { createBrowserKernel } from './kernel';
import { bindRouterKernel } from './router';
import { KernelRoot } from './slots.tsx';
import routes from './plugins/routes';
import screens from './plugins/screens';
import shell from './plugins/shell';
import './styles.css';

/**
 * Публикация экземпляра каждого имени таблицы общих модулей — до первой
 * отрисовки, чтобы переходники (`/shared/<имя>.js`) нашли его к моменту
 * первого `import()` виджета или браузерной половины плагина (design.md
 * изменения `shared-module-table`, Решение 1). Без общего экземпляра
 * импортирующий, получивший свой React или свой cordis, молча ломает хуки
 * или заводит сервис в чужом контексте.
 *
 * Таблица общих модулей (`src/parts/ui/daemon/sharedModules.ts`) достигла всех шести
 * имён здесь — объект публикации растёт вместе с самими модулями поверхности
 * (`ui/src/sharedSlots.ts`, `ui/src/parts/ui/index.ts`), а не раньше их появления.
 */
(globalThis as Record<string, unknown>)[WIDGET_RUNTIME_GLOBAL] = {
  react: ReactNamespace,
  'react-dom': ReactDomNamespace,
  'react/jsx-runtime': JsxRuntimeNamespace,
  cordis: CordisNamespace,
  '@stepcast/slots': SharedSlotsNamespace,
  '@stepcast/ui': SharedUiNamespace,
};

/**
 * Ядро поднимается здесь, вне дерева React и до первой отрисовки (design.md
 * `cordis-kernel-browser`, Решение 13) — тем же порядком «сначала то, что
 * обязано быть единственным, потом отрисовка», что и публикация React для
 * виджетов выше. `StrictMode` в разработке вызывает эффекты дважды: ядро,
 * заводимое эффектом, удвоило бы регистрации или подняло бы второе.
 *
 * `shell` — встроенный плагин каркаса (design.md, Решение 8); `screens` —
 * плагин, который спрашивает состав экранов у демона и применяет встроенные
 * половины (`ui-screens`, «Витрина узнаёт действующий состав экранов у
 * демона»). Отказ любого из них, если случится, соберёт `settle()` рендерера
 * корня (`KernelRoot`), а не прервёт загрузку здесь (design.md, Решение 6—
 * отказы собираются, а не бросаются из вызова).
 *
 * `bindRouterKernel` — до применения плагинов: `screens` уже на первом шаге
 * своей асинхронной работы пишет в `ctx.screens`, а маршрутизатор
 * (`ui/src/router.tsx`) не имеет собственного способа получить контекст.
 */
const kernel = createBrowserKernel();
bindRouterKernel(kernel.ctx);
kernel.ctx.plugin(shell);
kernel.ctx.plugin(routes);
kernel.ctx.plugin(screens);

const container = document.getElementById('root');
if (container === null) throw new Error('Разметка витрины без корневого элемента');

createRoot(container).render(
  <StrictMode>
    <KernelRoot kernel={kernel} />
  </StrictMode>,
);
