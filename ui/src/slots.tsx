import {
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { Context } from 'cordis';

import { ROOT, KernelContext, type BrowserKernel, type Diagnostic } from './kernel';
// Расширение явно, как и в `kernel.ts`: голое `./slots` неоднозначно между
// этим файлом и `ui/src/slots.ts` (реестр) — см. комментарий там же.
import type { AnySlotDescriptor, SlotDescriptor, SlotKind, SlotEntry } from './slots.ts';

/**
 * Рендерер слотов — связь реестра (`ui/src/slots.ts`) с деревом React
 * (design.md `cordis-kernel-browser`, Решение 11).
 *
 * `<Slot>` подписывается на реестр через `useSyncExternalStore`: состав
 * слота меняется вне React (эффекты cordis), и без него React не узнал бы о
 * перерисовке. Третий аргумент (`getServerSnapshot`) обязателен — тесты идут
 * через `react-dom/server`, который без него бросает.
 */

type KeyExtra<Kind extends SlotKind> = Kind extends 'keyed' ? { readonly k: string } : { readonly k?: never };

export type SlotProps<Props, Kind extends SlotKind> = {
  readonly of: SlotDescriptor<Props, Kind>;
  readonly props: Props;
  /** Что показать, когда слот пуст (или ключа `k` в нём нет) — последнему звену `chain` тоже достаётся оно. */
  readonly default?: ReactNode;
} & KeyExtra<Kind>;

function useKernelContext(): Context {
  const ctx = useContext(KernelContext);
  if (ctx === undefined) {
    throw new Error('<Slot> вызван вне дерева ядра витрины: оберните разметку в <KernelRoot>');
  }
  return ctx;
}

function useSlotEntries<Props>(name: string): readonly SlotEntry<Props>[] {
  const ctx = useKernelContext();
  const registry = ctx.slots;
  return useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.getEntries<Props>(name),
    () => registry.getEntries<Props>(name),
  );
}

function renderChain<Props>(
  entries: readonly SlotEntry<Props>[],
  props: Props,
  fallback: ReactNode,
): ReactNode {
  let next: ReactNode = fallback;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- см. комментарий в `Slot` про стёртый тип компонента.
    const Link = entry.component as ComponentType<any>;
    next = <Link key={entry.id} {...props} next={next} />;
  }
  return next;
}

export function Slot<Props, Kind extends SlotKind>(slotProps: SlotProps<Props, Kind>): ReactElement {
  const { of: descriptor, props, default: fallback, k: key } = slotProps;
  const entries = useSlotEntries<Props>(descriptor.name);

  if (descriptor.kind === 'single') {
    const entry = entries[0];
    if (entry === undefined) return <>{fallback}</>;
    // `Props` здесь — абстрактный параметр этой функции, не конкретный тип:
    // JSX не умеет проверить спред абстрактных props на `IntrinsicAttributes`.
    // Компонент типобезопасен на границе `contribute`/`<Slot of=…>` — внутри
    // самого рендерера тип уже стёрт тем же приёмом, что и в реестре
    // (`ui/src/slots.ts`, `ComponentType<any>` у внутренней записи).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Component = entry.component as ComponentType<any>;
    return <Component {...props} />;
  }

  if (descriptor.kind === 'keyed') {
    const entry = entries.find((candidate) => candidate.key === key);
    if (entry === undefined) return <>{fallback}</>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Component = entry.component as ComponentType<any>;
    return <Component {...props} />;
  }

  if (descriptor.kind === 'chain') {
    return <>{renderChain(entries, props, fallback)}</>;
  }

  // list: все вкладчики в объявленном порядке.
  return (
    <>
      {entries.map((entry) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- см. комментарий выше про стёртый тип компонента.
        const Component = entry.component as ComponentType<any>;
        return <Component key={entry.id} {...props} />;
      })}
    </>
  );
}

/**
 * Полоса диагностик. Плагин и слот выводятся отдельными полями, а не
 * вычитываются глазами из текста: у отказа плагина (`failed`) текст — это
 * `error.message` самого отказа, где имени плагина может не быть вовсе, а
 * требование `ui-kernel` («каждый отказ MUST называть плагин и слот»)
 * относится ко всем трём видам одинаково. Слот показывается, только когда он
 * известен: отказ, к слотам отношения не имеющий, не получает выдуманного.
 */
function DiagnosticsBar({ diagnostics }: { readonly diagnostics: readonly Diagnostic[] }): ReactElement {
  return (
    <div className="kernel-diagnostics" role="alert">
      {diagnostics.map((diagnostic, index) => (
        <div key={index} className={`kernel-diagnostic kernel-diagnostic-${diagnostic.kind}`}>
          <span className="kernel-diagnostic-plugin">{diagnostic.plugin}</span>
          {diagnostic.slot === undefined ? null : (
            <span className="kernel-diagnostic-slot">{` → слот ${diagnostic.slot}`}</span>
          )}
          {': '}
          <span className="kernel-diagnostic-message">{diagnostic.message}</span>
        </div>
      ))}
    </div>
  );
}

function NoRoot(): ReactElement {
  return (
    <div className="kernel-empty">
      Ни один плагин не внёс каркас витрины в корневой слот — открывать
      нечего.
    </div>
  );
}

/**
 * Тело корневого рендерера: контекст дереву, диагностики полосой поверх
 * витрины (а не только в `console.error`), `root` — слотом с внятной
 * страницей вместо пустоты, когда вкладчика нет (design.md, Решение 6).
 * Отдельно от `KernelRoot` — чтобы диагностики можно было задать явно, без
 * эффекта: тесты идут через `react-dom/server`, который эффекты не исполняет.
 */
export function KernelFrame({
  kernel,
  diagnostics,
}: {
  readonly kernel: BrowserKernel;
  readonly diagnostics: readonly Diagnostic[];
}): ReactElement {
  return (
    <KernelContext.Provider value={kernel.ctx}>
      {diagnostics.length > 0 ? <DiagnosticsBar diagnostics={diagnostics} /> : null}
      <Slot of={ROOT} props={{}} default={<NoRoot />} />
    </KernelContext.Provider>
  );
}

/**
 * Корневой рендерер ядра: сам собирает диагностики `settle()`-ом и держит их
 * в состоянии.
 *
 * Пересобирает их не только монтированием: состав браузерных строк приходит
 * потоком демона уже после первой отрисовки, и отказ замены (`stale`,
 * `failed` — `ui/src/services/plugins.ts`) случается позже любого эффекта
 * монтирования. Без подписки такой отказ оставался бы только в
 * `console.error`, а полоса — пустой (design.md `hot-swap-preserves-data`,
 * Решение 6).
 */
export function KernelRoot({ kernel }: { readonly kernel: BrowserKernel }): ReactElement {
  const [diagnostics, setDiagnostics] = useState<readonly Diagnostic[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Одна строка лога на беду, а не на пересборку: тем же правилом, каким
    // наблюдатель демона не повторяет отказ разбора журнала (`src/ui/watcher.ts`).
    const logged = new Set<string>();

    const refresh = (): void => {
      void kernel.settle().then((result) => {
        if (cancelled) return;
        setDiagnostics(result);
        for (const diagnostic of result) {
          const where =
            diagnostic.slot === undefined ? diagnostic.plugin : `${diagnostic.plugin} → слот ${diagnostic.slot}`;
          const line = `[stepcast] ${where}: ${diagnostic.message}`;
          if (logged.has(line)) continue;
          logged.add(line);
          console.error(line);
        }
      });
    };

    refresh();
    const unsubscribe = kernel.subscribe(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [kernel]);

  return <KernelFrame kernel={kernel} diagnostics={diagnostics} />;
}

export type { AnySlotDescriptor };
