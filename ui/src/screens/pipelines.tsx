import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/pipelines/declaration.ts';
import type { Overview } from '../api';
import { Pipelines } from '../pages/Pipelines';
import { SCREEN } from '@stepcast/slots';

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
  ctx.slots.contribute(SCREEN, { component: PipelinesScreen, key: declaration.id });
}
