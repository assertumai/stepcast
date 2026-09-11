import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/widgets/declaration.ts';
import type { Overview, WidgetsOverview } from '../api';
import { Widgets } from '../pages/Widgets';
import { SCREEN } from '@stepcast/slots';

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
  ctx.slots.contribute(SCREEN, { component: WidgetsScreen, key: declaration.id });
}
