import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/runs/declaration.ts';
import type { Overview } from '../api';
import { Runs } from '../pages/Runs';
import { SCREEN } from '@stepcast/slots';

/**
 * Экран «Прогоны» — первый образец перевода (design.md, Решение 15):
 * `ui/src/pages/Runs.tsx` не изменён ни в чём, те же props, источник другой.
 *
 * Подсветка пункта меню на странице прогона (`screen-run`, у которой своего
 * пункта нет) — свойство маршрута, а не знание этого экрана о другом
 * (`ui-routes`, design.md Решение 13, `nav.active_for` встроенного файла
 * маршрутов): собственного вида пункта меню этому экрану больше не нужно.
 */
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
  ctx.slots.contribute(SCREEN, { component: RunsScreen, key: declaration.id });
}
