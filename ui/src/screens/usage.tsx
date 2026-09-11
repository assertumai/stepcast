import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/usage/declaration.ts';
import type { Overview } from '../api';
import { Usage } from '../pages/Usage';
import { navItem } from '../plugins/navItem';
import { NAV, SCREEN } from '../plugins/shell';
import { daysForPeriod } from './usagePeriods';

function UsageScreen({
  overview,
  params,
  navigate,
}: {
  readonly overview: Overview | undefined;
  readonly params: Readonly<Record<string, string>>;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const days = daysForPeriod(params.period);
  return <Usage overview={overview} {...(days === undefined ? {} : { days })} navigate={navigate} />;
}

export default function usage(ctx: Context): void {
  ctx.slots.contribute(NAV, { component: navItem(declaration), order: declaration.nav?.order ?? 0 });
  ctx.slots.contribute(SCREEN, { component: UsageScreen, key: declaration.id });
}
