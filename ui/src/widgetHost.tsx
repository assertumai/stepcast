import {
  Component,
  useEffect,
  useState,
  type ComponentType,
  type ErrorInfo,
  type JSX,
  type ReactNode,
} from 'react';

import { widgetModuleHref } from '../../src/ui/routes';
import { WIDGET_ERROR_EXPORT } from '../../src/ui/sharedModules';
import type { WidgetCompileFailure } from './api';

/**
 * Хост одного виджета: загружает модуль по адресу с версией, отличает
 * рабочий результат от ошибки компиляции и от неразрешённого импорта, и
 * держит границу ошибок вокруг отрисовки (design.md изменения
 * `ui-runtime-widget-spike`, Решения 8 и 9).
 *
 * Ошибка компиляции — не исключение `import()`, а поле экспорта: демон
 * всегда отвечает 200 и рабочим JS (`errorModuleText`, `src/ui/widgets.ts`),
 * поэтому хост различает исходы уже после успешного импорта, читая
 * `mod[WIDGET_ERROR_EXPORT]`. Настоящее исключение `import()` — либо сеть,
 * либо голое имя, которого нет в карте: оба показаны карточкой «неразрешённый
 * импорт», второй — с названным именем (design.md, Решение 2).
 */

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly Widget: ComponentType }
  | { readonly kind: 'compile-error'; readonly failure: WidgetCompileFailure }
  | { readonly kind: 'import-error'; readonly message: string };

/** Хром называет спецификатор в тексте отказа; другие браузеры — не всегда, тогда показывается сырой текст. */
function unresolvedImportName(message: string): string | undefined {
  return /specifier ["']([^"']+)["']/.exec(message)?.[1];
}

function WidgetCard({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="widget-card widget-card-error">
      <div className="widget-card-title">{title}</div>
      {children}
    </div>
  );
}

function CompileFailureCard({ failure }: { readonly failure: WidgetCompileFailure }): JSX.Element {
  return (
    <WidgetCard title="Ошибка компиляции">
      <div className="dim mono">
        {failure.file}:{failure.line}:{failure.column}
      </div>
      <pre className="widget-card-detail">{failure.text}</pre>
    </WidgetCard>
  );
}

function ImportErrorCard({ message }: { readonly message: string }): JSX.Element {
  const name = unresolvedImportName(message);
  return (
    <WidgetCard title="Неразрешённый импорт">
      {name === undefined ? <pre className="widget-card-detail">{message}</pre> : <div className="mono">{name}</div>}
    </WidgetCard>
  );
}

interface BoundaryProps {
  /** Смена значения сбрасывает границу: исправленный виджет обязан ожить без перезагрузки страницы. */
  readonly resetKey: string;
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly error: Error | undefined;
}

/**
 * Граница ошибок вокруг карточки одного виджета. Без неё исключение при
 * отрисовке валит дерево React целиком, и свойство «остальная страница цела»
 * держалось бы только на исправных виджетах (design.md, Решение 9).
 */
class WidgetErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: undefined };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidUpdate(prevProps: BoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error !== undefined) {
      this.setState({ error: undefined });
    }
  }

  // Обязателен рядом с `getDerivedStateFromError`, даже без тела: без него
  // React считает исключение необработанным на уровне разработки.
  override componentDidCatch(_error: Error, _info: ErrorInfo): void {}

  override render(): ReactNode {
    if (this.state.error !== undefined) {
      return <WidgetCard title="Виджет упал при отрисовке">{this.state.error.message}</WidgetCard>;
    }
    return this.props.children;
  }
}

function WidgetModuleView({ state }: { readonly state: LoadState }): JSX.Element {
  if (state.kind === 'loading') return <div className="widget-card dim">Загрузка…</div>;
  if (state.kind === 'compile-error') return <CompileFailureCard failure={state.failure} />;
  if (state.kind === 'import-error') return <ImportErrorCard message={state.message} />;
  const Widget = state.Widget;
  return <Widget />;
}

export interface WidgetHostProps {
  readonly projectKey: string;
  readonly id: string;
  readonly version: string;
}

export function WidgetHost({ projectKey, id, version }: WidgetHostProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    // Версия в адресе — единственный способ обойти неизменяемый реестр
    // модулей браузера: тот же URL вернул бы прежний модуль (design.md,
    // Решение 6).
    const href = widgetModuleHref(projectKey, id, version);

    import(/* @vite-ignore */ href)
      .then((mod: Record<string, unknown>) => {
        if (cancelled) return;
        const failure = mod[WIDGET_ERROR_EXPORT] as WidgetCompileFailure | undefined;
        if (failure !== undefined) {
          setState({ kind: 'compile-error', failure });
          return;
        }
        const exported = mod.default;
        if (typeof exported !== 'function') {
          setState({ kind: 'import-error', message: 'Модуль не экспортирует компонент по умолчанию' });
          return;
        }
        setState({ kind: 'ready', Widget: exported as ComponentType });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ kind: 'import-error', message: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [projectKey, id, version]);

  return (
    <WidgetErrorBoundary resetKey={version}>
      <WidgetModuleView state={state} />
    </WidgetErrorBoundary>
  );
}
