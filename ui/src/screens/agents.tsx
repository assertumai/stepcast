import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/agents/declaration.ts';
import { Agents } from '../pages/Agents';
import { navItem } from '../plugins/navItem';
import { NAV, SCREEN } from '../plugins/shell';

export default function agents(ctx: Context): void {
  ctx.slots.contribute(NAV, { component: navItem(declaration), order: declaration.nav?.order ?? 0 });
  ctx.slots.contribute(SCREEN, { component: Agents, key: declaration.id });
}
