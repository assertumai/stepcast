import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/settings/declaration.ts';
import { Settings } from '../pages/Settings';
import { SCREEN } from '@stepcast/slots';

export default function settings(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: Settings, key: declaration.id });
}
