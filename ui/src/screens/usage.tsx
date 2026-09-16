import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/usage/declaration.ts';
import type { Overview } from '../api';
import { Usage } from '../pages/Usage';
import { SCREEN } from '@stepcast/slots';
import { daysForPeriod, useUsagePeriods } from './usagePeriods';

function UsageScreen({
  overview,
  params,
  navigate,
}: {
  readonly overview: Overview | undefined;
  readonly params: Readonly<Record<string, string>>;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const periods = useUsagePeriods();
  const days = daysForPeriod(params.period, periods);
  return <Usage overview={overview} {...(days === undefined ? {} : { days })} navigate={navigate} />;
}

export default function usage(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: UsageScreen, key: declaration.id });
}
