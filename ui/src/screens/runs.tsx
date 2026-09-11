import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/runs/declaration.ts';
import { declaration as runDeclaration } from '../../../src/ui/screens/run/declaration.ts';
import type { Overview } from '../api';
import { Runs } from '../pages/Runs';
import { NAV, SCREEN } from '../plugins/shell';
import { screenHref, type ParsedRoute } from '../router';

/**
 * Экран «Прогоны» — первый образец перевода (design.md, Решение 15):
 * `ui/src/pages/Runs.tsx` не изменён ни в чём, те же props, источник другой.
 *
 * Свой вид пункта меню, не общий помощник `navItem`: страница прогона
 * (`screen-run`) своего пункта не имеет и подсвечивает этот же — тем же
 * правилом, что было у прежнего плагина `ui/src/plugins/runs.tsx`.
 */
function RunsNavItem({
  route,
  navigate,
}: {
  readonly route: ParsedRoute;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  // Страница прогона подсвечивает этот же пункт: её `id` берётся из её
  // объявления, а не пишется литералом здесь.
  const active = route.screenId === declaration.id || route.screenId === runDeclaration.id;
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
}

function RunsScreen({
  overview,
  navigate,
}: {
  readonly overview: Overview | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  return <Runs overview={overview} navigate={navigate} />;
}

export default function runs(ctx: Context): void {
  ctx.slots.contribute(NAV, { component: RunsNavItem, order: declaration.nav?.order ?? 0 });
  ctx.slots.contribute(SCREEN, { component: RunsScreen, key: declaration.id });
}
