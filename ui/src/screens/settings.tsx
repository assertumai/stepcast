import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/settings/declaration.ts';
import { Settings } from '../pages/Settings';
import { navItem } from '../plugins/navItem';
import { NAV, SCREEN } from '../plugins/shell';

export default function settings(ctx: Context): void {
  ctx.slots.contribute(NAV, { component: navItem(declaration), order: declaration.nav?.order ?? 0 });
  ctx.slots.contribute(SCREEN, { component: Settings, key: declaration.id });
}
