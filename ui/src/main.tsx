import { StrictMode } from 'react';
import * as ReactNamespace from 'react';
import * as ReactDomNamespace from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as JsxRuntimeNamespace from 'react/jsx-runtime';

import { WIDGET_RUNTIME_GLOBAL, type WidgetRuntimeSpecifier } from '../../src/ui/widgetRuntime';
import { App } from './App';
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

const container = document.getElementById('root');
if (container === null) throw new Error('Разметка витрины без корневого элемента');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
