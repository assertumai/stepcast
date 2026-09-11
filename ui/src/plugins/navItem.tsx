import type { JSX } from 'react';

import type { NavItemProps } from '@stepcast/slots';

/**
 * Общий вид пункта меню — один компонент на все маршруты с объявленным
 * `nav` (design.md изменения `user-defined-routes`, Решение 13): каркас
 * (`shell.tsx`) рисует его как `default` слота `NAV`, ключ которого — `id`
 * маршрута, а не имя экрана.
 *
 * Экран, желающий свой вид пункта (значок, счётчик), вносит вклад в тот же
 * слот тем же ключом и заменяет этот вид только для своего маршрута;
 * подсветку он при этом не пересчитывает сам — `active` уже пришёл каркасом,
 * посчитанным по `nav.active_for` действующего маршрута.
 */
export function GenericNavItem({ title, href, active, navigate }: NavItemProps): JSX.Element {
  if (href === undefined) {
    // Маршрут объявил место в навигации, но собрать по нему ссылку нечем
    // (обязательный параметр пути не заполнен пустыми параметрами) — пункт
    // остаётся видимым названием, а не пропадает молча.
    return <span className="nav-item nav-item-disabled">{title}</span>;
  }
  return (
    <a
      className={active ? 'nav-item active' : 'nav-item'}
      href={href}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {title}
    </a>
  );
}
