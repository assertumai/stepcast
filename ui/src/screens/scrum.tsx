import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/scrum/declaration.ts';
import type { BacklogOverview } from '../api';
import { Scrum } from '../pages/Scrum';
import { SCREEN } from '@stepcast/slots';

function ScrumScreen({ backlog }: { readonly backlog: BacklogOverview | undefined }): JSX.Element {
  return <Scrum backlog={backlog} />;
}

export default function scrum(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: ScrumScreen, key: declaration.id });
}
