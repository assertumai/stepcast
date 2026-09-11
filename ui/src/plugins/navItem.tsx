import type { JSX } from 'react';

import type { ScreenDeclaration } from '../../../src/ui/screens/declaration.ts';
import { screenHref } from '../router';
import type { ParsedRoute } from '../router';

/**
 * Общий вид пункта меню — по строке на экран (design.md, Решение 11):
 * каркас (`shell.tsx`) не знает ни одного имени экрана, а пункт меню несёт
 * вид, который выбрал сам экран, вместо того чтобы каркас рисовал меню по
 * таблице объявлений.
 *
 * Экран, желающий свой вид пункта (значок, счётчик), не обязан пользоваться
 * этим помощником — `screen-runs` собирает свой ради активной подсветки на
 * странице прогона, у которой своего пункта меню нет.
 */
export interface NavItemProps {
  readonly route: ParsedRoute;
  readonly navigate: (href: string) => void;
}

export function navItem(declaration: ScreenDeclaration): (props: NavItemProps) => JSX.Element {
  return function NavItem({ route, navigate }: NavItemProps): JSX.Element {
    const active = route.screenId === declaration.id;
    const href = screenHref(declaration.id);
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
        {declaration.title}
      </a>
    );
  };
}
