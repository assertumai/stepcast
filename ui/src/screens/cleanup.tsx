import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/cleanup/declaration.ts';
import type { Overview } from '../api';
import { Cleanup } from '../pages/Cleanup';
import { SCREEN } from '@stepcast/slots';

function CleanupScreen({ overview }: { readonly overview: Overview | undefined }): JSX.Element {
  return <Cleanup overview={overview} />;
}

export default function cleanup(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: CleanupScreen, key: declaration.id });
}
