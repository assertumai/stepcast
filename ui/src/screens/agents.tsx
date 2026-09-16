import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/agents/declaration.ts';
import { Agents } from '../pages/Agents';
import { SCREEN } from '@stepcast/slots';

export default function agents(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: Agents, key: declaration.id });
}
