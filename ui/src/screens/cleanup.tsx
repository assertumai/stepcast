import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/cleanup/declaration.ts';
import type { Overview } from '../api';
import { Cleanup } from '../pages/Cleanup';
import { navItem } from '../plugins/navItem';
import { NAV, SCREEN } from '../plugins/shell';

function CleanupScreen({ overview }: { readonly overview: Overview | undefined }): JSX.Element {
  return <Cleanup overview={overview} />;
}

export default function cleanup(ctx: Context): void {
  ctx.slots.contribute(NAV, { component: navItem(declaration), order: declaration.nav?.order ?? 0 });
  ctx.slots.contribute(SCREEN, { component: CleanupScreen, key: declaration.id });
}
