import type { JSX } from 'react';
import type { Context } from 'cordis';

import type { Route } from '../router';
import { Runs } from '../pages/Runs';
import { NAV, SCREEN } from './shell';

/**
 * Экран «Прогоны» вкладом в слот (design.md `cordis-kernel-browser`,
 * Решение 8): пункт меню в `nav`, сам экран в `screen` ключом `runs`.
 * `ui/src/pages/Runs.tsx` не изменён ни в чём — те же props, источник
 * другой (`design.md`, Решение 10, требование `ui-kernel`, «Встроенный экран
 * живёт вкладом в слот и не меняет поведения»).
 */

function RunsNavItem({ route, navigate }: { readonly route: Route; readonly navigate: (href: string) => void }): JSX.Element {
  const active = route.page === 'runs' || route.page === 'run';
  return (
    <a
      className={active ? 'nav-item active' : 'nav-item'}
      href="/"
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        navigate('/');
      }}
    >
      Прогоны
    </a>
  );
}

export default function runs(ctx: Context): void {
  ctx.slots.contribute(NAV, { component: RunsNavItem });
  ctx.slots.contribute(SCREEN, { component: Runs, key: 'runs' });
}
