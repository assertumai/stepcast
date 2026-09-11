import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/steps/declaration.ts';
import { Steps } from '../pages/Steps';
import { SCREEN } from '@stepcast/slots';

export default function steps(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: Steps, key: declaration.id });
}
