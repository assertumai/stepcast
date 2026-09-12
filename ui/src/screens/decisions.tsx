import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/decisions/declaration.ts';
import type { RouteTarget } from '../../../src/ui/routes.ts';
import type { Overview } from '../api';
import { Decisions } from '../pages/Decisions';
import { SCREEN } from '@stepcast/slots';

/** Цель экрана «Решения» — для ссылок с карточки шага прогона (`RunDetail`). */
export const DECISIONS_TARGET: RouteTarget = { kind: 'screen', id: declaration.id };

function DecisionsScreen({
  overview,
  navigate,
}: {
  readonly overview: Overview | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  return <Decisions overview={overview} navigate={navigate} />;
}

export default function decisions(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: DecisionsScreen, key: declaration.id });
}
