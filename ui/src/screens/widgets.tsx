import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/widgets/declaration.ts';
import type { Overview, WidgetsOverview } from '../api';
import { Widgets } from '../pages/Widgets';
import { navItem } from '../plugins/navItem';
import { NAV, SCREEN } from '../plugins/shell';

function WidgetsScreen({
  overview,
  widgets,
}: {
  readonly overview: Overview | undefined;
  readonly widgets: WidgetsOverview | undefined;
}): JSX.Element {
  return <Widgets overview={overview} widgets={widgets} />;
}

export default function widgets(ctx: Context): void {
  ctx.slots.contribute(NAV, { component: navItem(declaration), order: declaration.nav?.order ?? 0 });
  ctx.slots.contribute(SCREEN, { component: WidgetsScreen, key: declaration.id });
}
