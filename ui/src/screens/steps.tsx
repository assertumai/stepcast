import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/steps/declaration.ts';
import { Steps } from '../pages/Steps';
import { navItem } from '../plugins/navItem';
import { NAV, SCREEN } from '@stepcast/slots';

export default function steps(ctx: Context): void {
  ctx.slots.contribute(NAV, { component: navItem(declaration), order: declaration.nav?.order ?? 0 });
  ctx.slots.contribute(SCREEN, { component: Steps, key: declaration.id });
}
