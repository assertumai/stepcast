import { Service, type Context } from 'cordis';
import type { ComponentType, ReactNode } from 'react';

/**
 * Реестр слотов — место композиции витрины (design.md `cordis-kernel-browser`,
 * Решения 1-6).
 *
 * Слот — не своя карта «имя → объявлено», а имя сервиса контекста под
 * префиксом `slot:`: объявление — `ctx.provide('slot:<имя>', дескриптор)`,
 * вклад — область `ctx.inject(['slot:<имя>'], …)`. Отсюда бесплатно: порядок
 * загрузки не важен (плагин, внёсший вклад раньше объявления слота, просто
 * ждёт в `PENDING` и оживает сам), снятие слота каскадно снимает всех его
 * вкладчиков, а повторное объявление отказывает броском самого cordis
 * (`translateSlotNameConflict` ниже переводит его текст в названный отказ).
 *
 * Содержимое слотов (кто в каком слоте) — отдельно, в едином сервисе `slots`:
 * рендереру нужен один источник уведомлений на всю витрину, а не подписка на
 * каждый слот по отдельности.
 */

export type SlotKind = 'single' | 'list' | 'keyed' | 'chain';

/** Имя сервиса реестра — занято ядром (design.md, Решение 2); проверяется в `ui/src/kernel.ts`. */
export const SLOTS_SERVICE_NAME = 'slots';

/** Префикс, под которым имя слота живёт как имя сервиса контекста (design.md, Решение 1). */
const SLOT_PREFIX = 'slot:';

export function slotServiceName(name: string): string {
  return `${SLOT_PREFIX}${name}`;
}

export function isSlotServiceName(name: string): boolean {
  return name.startsWith(SLOT_PREFIX);
}

export function slotNameFromServiceName(name: string): string {
  return name.slice(SLOT_PREFIX.length);
}

/**
 * Дескриптор слота: имя, вид и — фантомным полем `__props` — тип данных,
 * которые слот раздаёт вкладчикам (design.md, Решение 5). Поле не несёт
 * значения ни при каком объявлении: оно существует только для того, чтобы
 * два дескриптора с разными `Props` не оказались структурно одним типом —
 * без него `SlotDescriptor<A>` и `SlotDescriptor<B>` были бы неразличимы для
 * компилятора, потому что `Props` больше нигде в форме значения не участвует.
 */
export interface SlotDescriptor<Props, Kind extends SlotKind = SlotKind> {
  readonly name: string;
  readonly kind: Kind;
  readonly __props?: Props;
}

/** Дескриптор без интереса к конкретному `Props` — форма параметра `slots` у `contribute`. */
export type AnySlotDescriptor = SlotDescriptor<unknown, SlotKind>;

export function slot<Props, Kind extends SlotKind = SlotKind>(name: string, kind: Kind): SlotDescriptor<Props, Kind> {
  return { name, kind };
}

/** Props, которые получает звено цепочки `chain`: то, что даёт слот, плюс уже отрисованное следующее звено. */
export type ChainLinkProps<Props> = Props & { readonly next: ReactNode };

type ComponentFor<Props, Kind extends SlotKind> = Kind extends 'chain'
  ? ComponentType<ChainLinkProps<Props>>
  : ComponentType<Props>;

/**
 * `key` и `order` по виду слота (design.md, Решение 4 и открытый вопрос про
 * `single`): `keyed` требует `key`, `list`/`chain` принимают необязательный
 * `order` (по умолчанию `0`), а `single` не принимает ни то ни другое —
 * лишнее поле в вызове `contribute` для `single`-слота не проходит
 * компиляцию, а не игнорируется молча.
 */
type ContributeExtra<Kind extends SlotKind> = Kind extends 'keyed'
  ? { readonly key: string; readonly order?: never }
  : Kind extends 'list' | 'chain'
    ? { readonly key?: never; readonly order?: number }
    : { readonly key?: never; readonly order?: never };

export type Contribution<Props, Kind extends SlotKind> = {
  readonly component: ComponentFor<Props, Kind>;
  /**
   * Дочерние слоты, которые этот вклад открывает внутри себя, — тем же
   * вызовом, что и сам вклад (design.md, Решение 3): слоты существуют ровно
   * столько, сколько существует объявивший их вклад.
   */
  readonly slots?: readonly AnySlotDescriptor[];
} & ContributeExtra<Kind>;

/** Запись реестра, отданная наружу читающему — компонент уже приведён к типу, который объявил дескриптор. */
export interface SlotEntry<Props = unknown> {
  readonly key: string | undefined;
  readonly owner: string;
  readonly component: ComponentType<Props>;
}

/**
 * Отвергнутый вклад (design.md, Решение 6) — три причины:
 *
 * - `occupied` — второй вкладчик в слоте вида `single`;
 * - `duplicate-key` — повторный ключ в слоте вида `keyed`;
 * - `kind-mismatch` — вкладчик обратился к слоту дескриптором с другим видом.
 *
 * Последнее — не придирка: вид принадлежит ОБЪЯВЛЕНИЮ слота (требование
 * `ui-kernel`, «вид MUST задаваться при объявлении слота»), и вкладчик,
 * собравший свой дескриптор с другим видом, менял бы правило состава всего
 * слота под себя. Такой вклад в слот не попадает и называется здесь, а не
 * исчезает молча.
 */
export type RejectedContribution =
  | {
      readonly reason: 'occupied' | 'duplicate-key';
      readonly slotName: string;
      readonly kind: SlotKind;
      readonly key: string | undefined;
      /** Занявший место и проигравший ему претендент — в этом порядке. */
      readonly owners: readonly [string, string];
    }
  | {
      readonly reason: 'kind-mismatch';
      readonly slotName: string;
      /** Вид, которым слот объявлен. */
      readonly kind: SlotKind;
      /** Вид, которым к слоту обратился вкладчик. */
      readonly contributedKind: SlotKind;
      readonly owner: string;
    };

/** Внутренняя, нетипизированная запись — реестр ключуется строкой (design.md, Решение 5). */
interface RawEntry {
  readonly kind: SlotKind;
  readonly key: string | undefined;
  readonly order: number;
  /** Порядок вызова `contribute()`, не порядок разрешения имени слота — тай-брейк, независимый от гонки имён. */
  readonly seq: number;
  readonly owner: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- реестр стирает тип компонента, восстанавливает его читающий (design.md, Решение 5).
  readonly component: ComponentType<any>;
}

const EMPTY_ENTRIES: readonly SlotEntry[] = Object.freeze([]);
const EMPTY_REJECTED: readonly RejectedContribution[] = Object.freeze([]);

/**
 * Сервис `slots` — карта «имя слота → вкладчики», кеш снимка на слот и одна
 * подписка на всю витрину (design.md, Решение 2 и 11). Кеш — не оптимизация:
 * `<Slot>` читает состав через `useSyncExternalStore`, который зацикливается
 * на нестабильном снимке, поэтому `getEntries` обязан отдавать ту же ссылку,
 * пока состав слота не изменился.
 */
export class SlotsService extends Service {
  private readonly bySlot = new Map<string, RawEntry[]>();
  private readonly snapshots = new Map<string, readonly SlotEntry[]>();
  private readonly rejectedBySlot = new Map<string, readonly RejectedContribution[]>();
  /**
   * Вклады, отвергнутые расхождением вида, — отдельно от `rejectedBySlot`: тот
   * пересчитывается из принятых записей слота, а эти в слот не попадали вовсе.
   * Ключ — `seq` вклада, чтобы снятие области вкладчика убирало ровно его.
   */
  private readonly mismatched = new Map<number, RejectedContribution>();
  private readonly listeners = new Set<() => void>();
  private seqCounter = 0;

  constructor(ctx: Context) {
    super(ctx, SLOTS_SERVICE_NAME);
  }

  /**
   * Внести компонент в слот и объявить его дочерние слоты — один вызов
   * (design.md, Решение 3). `this.ctx` — контекст вызвавшего: cordis отдаёт
   * сервис через трекер, привязанный к обращающемуся контексту, тем же
   * приёмом, что и `ContributionService.register` в демоне
   * (`src/core/plugins/kernel.ts`). Возвращается раньше, чем вклад окажется в
   * слоте: тело `ctx.inject` исполняется, когда имя слота разрешится, пусть
   * даже в ближайшей микрозадаче, — синхронности здесь нет и не будет.
   *
   * Вид состава берётся из ОБЪЯВЛЕНИЯ слота, а не из дескриптора вкладчика:
   * дескриптор вкладчика — форма обращения, и собран он может быть где угодно
   * (в том числе с другим видом). Объявление же — значение сервиса
   * `slot:<имя>`, которое как раз и разрешил `inject`; расхождение видов
   * отвергает вклад с названной причиной.
   */
  contribute<Props, Kind extends SlotKind>(
    descriptor: SlotDescriptor<Props, Kind>,
    contribution: Contribution<Props, Kind>,
  ): void {
    const seq = this.seqCounter++;
    const owner = this.ctx.fiber.name;
    const parentName = descriptor.name;
    const key = contribution.key;
    const order = contribution.order ?? 0;
    const component = contribution.component as unknown as ComponentType<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const childSlots = contribution.slots ?? [];

    this.ctx.inject([slotServiceName(parentName)], (inner) => {
      const declared = inner.get(slotServiceName(parentName)) as AnySlotDescriptor | undefined;
      // `undefined` здесь недостижим (имя разрешено — значит значение есть),
      // но объявление слота хранит значение, а не только имя, и читать его
      // без проверки было бы обещанием, которого тип не даёт.
      const kind = declared?.kind ?? descriptor.kind;

      if (kind !== descriptor.kind) {
        // Дочерние слоты такого вклада не объявляются: вклада в слоте нет,
        // значит нет и компонента, внутри которого они стояли бы.
        const rejection: RejectedContribution = {
          reason: 'kind-mismatch',
          slotName: parentName,
          kind,
          contributedKind: descriptor.kind,
          owner,
        };
        inner.effect(() => {
          this.mismatched.set(seq, rejection);
          this.notify();
          return () => {
            this.mismatched.delete(seq);
            this.notify();
          };
        }, `slots.contribute(${parentName}) — вид не совпал с объявлением`);
        return;
      }

      for (const child of childSlots) {
        inner.provide(slotServiceName(child.name), child);
      }
      inner.effect(() => {
        this.add(parentName, kind, { kind, key, order, seq, owner, component });
        return () => this.remove(parentName, seq);
      }, `slots.contribute(${parentName})`);
    });
  }

  /** Вкладчики слота по имени — по правилу его вида, в стабильном порядке, той же ссылкой, пока состав не изменился. */
  getEntries<Props = unknown>(name: string): readonly SlotEntry<Props>[] {
    return (this.snapshots.get(name) ?? EMPTY_ENTRIES) as readonly SlotEntry<Props>[];
  }

  /** Вклады, отвергнутые правилом состава слота, — не молча потерянные, а перечень для полосы диагностик. */
  getRejected(): readonly RejectedContribution[] {
    if (this.rejectedBySlot.size === 0 && this.mismatched.size === 0) return EMPTY_REJECTED;
    const out: RejectedContribution[] = [];
    for (const rejected of this.rejectedBySlot.values()) out.push(...rejected);
    out.push(...this.mismatched.values());
    return out;
  }

  /** Подписка на изменение состава любого слота — один источник уведомлений на всю витрину (design.md, Решение 2). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private add(name: string, kind: SlotKind, entry: RawEntry): void {
    const list = this.bySlot.get(name) ?? [];
    list.push(entry);
    this.bySlot.set(name, list);
    this.recompute(name, kind);
    this.notify();
  }

  private remove(name: string, seq: number): void {
    const list = this.bySlot.get(name);
    if (list === undefined) return;
    const index = list.findIndex((entry) => entry.seq === seq);
    if (index === -1) return;
    const kind = list[index]!.kind;
    list.splice(index, 1);
    this.recompute(name, kind);
    this.notify();
  }

  /**
   * Пересчёт состава и отвергнутых записей слота — целиком, от текущих
   * «сырых» записей. `single` и `keyed` решают, кто первый, по `seq`
   * (порядок вызова `contribute()`), а не по порядку, в котором разрешились
   * имена слотов, — это и есть независимость от гонки имён (design.md,
   * Решение 4).
   */
  private recompute(name: string, kind: SlotKind): void {
    const raw = [...(this.bySlot.get(name) ?? [])].sort((a, b) => a.seq - b.seq);
    if (raw.length === 0) {
      this.snapshots.delete(name);
      this.rejectedBySlot.delete(name);
      return;
    }

    let accepted: RawEntry[];
    const rejected: RejectedContribution[] = [];

    if (kind === 'single') {
      accepted = raw.slice(0, 1);
      const winner = raw[0]!;
      for (const extra of raw.slice(1)) {
        rejected.push({ reason: 'occupied', slotName: name, kind, key: undefined, owners: [winner.owner, extra.owner] });
      }
    } else if (kind === 'keyed') {
      const seen = new Map<string, RawEntry>();
      accepted = [];
      for (const entry of raw) {
        const entryKey = entry.key ?? '';
        const existing = seen.get(entryKey);
        if (existing === undefined) {
          seen.set(entryKey, entry);
          accepted.push(entry);
        } else {
          rejected.push({
            reason: 'duplicate-key',
            slotName: name,
            kind,
            key: entry.key,
            owners: [existing.owner, entry.owner],
          });
        }
      }
    } else {
      // list / chain: все приняты, порядок — `order`, при равенстве `seq`.
      accepted = [...raw].sort((a, b) => a.order - b.order || a.seq - b.seq);
    }

    this.snapshots.set(
      name,
      Object.freeze(accepted.map((entry) => ({ key: entry.key, owner: entry.owner, component: entry.component }))),
    );
    this.rejectedBySlot.set(name, rejected.length === 0 ? EMPTY_REJECTED : Object.freeze(rejected));
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

declare module 'cordis' {
  interface Context {
    slots: SlotsService;
  }
}

/**
 * Отказ cordis на попытке объявить уже занятое имя слота — сообщение
 * внутреннего формата cordis (`service "<имя>" has been registered at
 * <...>`), переводится в названный отказ тем же приёмом, что
 * `translateReservedNameConflict` в демонском `src/core/plugins/kernel.ts`
 * (design.md, Решение 1 и 6). В отличие от демона список занятых имён не
 * фиксирован: под перевод попадает любое имя с префиксом `slot:`. Сообщение
 * cordis называет только первого владельца — второго (кто сейчас попытался
 * объявить то же имя) передаёт вызывающий: это имя fiber'а, чей `provide()`
 * бросил отказ.
 */
const RESERVED_SERVICE_RE = /^service "([^"]+)" has been registered at <([^>]*)>/;

export interface SlotNameConflict {
  readonly message: string;
  readonly conflict: {
    readonly slotName: string;
    readonly owners: readonly [string, string];
  };
}

export function translateSlotNameConflict(error: unknown, claimant: string): SlotNameConflict | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = RESERVED_SERVICE_RE.exec(error.message);
  const fullName = match?.[1];
  const firstOwner = match?.[2];
  if (fullName === undefined || firstOwner === undefined || !isSlotServiceName(fullName)) return undefined;
  const slotName = slotNameFromServiceName(fullName);
  return {
    message: `Слот ${slotName} уже объявлен: его объявляют ${firstOwner} и ${claimant}`,
    conflict: { slotName, owners: [firstOwner, claimant] },
  };
}
