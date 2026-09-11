import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/backlog/declaration.ts';
import type { BacklogOverview } from '../api';
import { Backlog } from '../pages/Backlog';
import { navItem } from '../plugins/navItem';
import { NAV, SCREEN } from '@stepcast/slots';

function BacklogScreen({ backlog }: { readonly backlog: BacklogOverview | undefined }): JSX.Element {
  return <Backlog backlog={backlog} />;
}

export default function backlog(ctx: Context): void {
  ctx.slots.contribute(NAV, { component: navItem(declaration), order: declaration.nav?.order ?? 0 });
  ctx.slots.contribute(SCREEN, { component: BacklogScreen, key: declaration.id });
}
