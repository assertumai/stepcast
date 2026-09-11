import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/pipelines/declaration.ts';
import type { Overview } from '../api';
import { Pipelines } from '../pages/Pipelines';
import { navItem } from '../plugins/navItem';
import { NAV, SCREEN } from '@stepcast/slots';

function PipelinesScreen({
  overview,
  navigate,
}: {
  readonly overview: Overview | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  return <Pipelines overview={overview} navigate={navigate} />;
}

export default function pipelines(ctx: Context): void {
  ctx.slots.contribute(NAV, { component: navItem(declaration), order: declaration.nav?.order ?? 0 });
  ctx.slots.contribute(SCREEN, { component: PipelinesScreen, key: declaration.id });
}
