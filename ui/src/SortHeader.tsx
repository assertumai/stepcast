import type { JSX } from 'react';

/**
 * Заголовок сортируемой колонки: первое нажатие — порядок по ней, повторное —
 * обратный. Текущая колонка и направление видны не только цветом — знаком и
 * `aria-sort`, тот же индикатор, что читает программа чтения с экрана.
 *
 * Общий для двух сортируемых таблиц витрины (список прогонов, очередь
 * улучшений): обе обязаны показывать направление одинаково, и второй,
 * расходящийся показ — беда, которую не заметят глазами (design.md изменения
 * ui-backlog-filters-sort, Решение 9). Величина сортировки параметризована
 * строкой: у прогонов их четыре, у очереди одна.
 */

export interface SortHeaderOrder {
  readonly metric: string;
  readonly direction: 'asc' | 'desc';
}

export function SortHeader({
  label,
  metric,
  order,
  onSort,
  className,
}: {
  readonly label: string;
  readonly metric: string;
  readonly order: SortHeaderOrder;
  readonly onSort: (metric: string) => void;
  readonly className?: string;
}): JSX.Element {
  const active = order.metric === metric;
  const ariaSort = active ? (order.direction === 'asc' ? 'ascending' : 'descending') : 'none';
  const arrow = active ? (order.direction === 'asc' ? '▲' : '▼') : '';
  const classes = ['sortable', active ? 'active' : '', className ?? ''].filter((value) => value !== '').join(' ');
  return (
    <th className={classes} aria-sort={ariaSort}>
      <button type="button" className="plain sort-button" onClick={() => onSort(metric)}>
        {label}
        {arrow === '' ? '' : ` ${arrow}`}
      </button>
    </th>
  );
}
