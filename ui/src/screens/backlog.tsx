import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/backlog/declaration.ts';
import type { BacklogOverview } from '../api';
import { Backlog } from '../pages/Backlog';
import { SCREEN } from '@stepcast/slots';

function BacklogScreen({ backlog }: { readonly backlog: BacklogOverview | undefined }): JSX.Element {
  return <Backlog backlog={backlog} />;
}

export default function backlog(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: BacklogScreen, key: declaration.id });
}
