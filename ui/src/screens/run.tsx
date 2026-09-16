import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/parts/ui/screens/run/declaration.ts';
import type { RouteTarget } from '../../../src/parts/ui/routes.ts';
import type { RunSnapshot } from '../api';
import { RunDetail } from '../pages/RunDetail';
import { SCREEN } from '@stepcast/slots';

/**
 * Цель страницы прогона — то, чем на неё ссылаются прочие экраны
 * (`ui-routes`, design.md Решение 8): адрес собирает `TargetLink`
 * (`ui/src/routeLink.tsx`) по действующей таблице, а отключённый маршрут этой
 * цели становится не-ссылкой с названной причиной, а не другим адресом.
 */
export const RUN_TARGET: RouteTarget = { kind: 'screen', id: declaration.id };

/** Страница прогона: без пункта меню (`ui-screens`, «Экран без пункта меню»). */
function RunScreen({
  params,
  snapshot,
  navigate,
}: {
  readonly params: Readonly<Record<string, string>>;
  readonly snapshot: RunSnapshot | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  return (
    <RunDetail
      key={`${params.projectKey}/${params.runId}`}
      projectKey={params.projectKey ?? ''}
      runId={params.runId ?? ''}
      snapshot={snapshot}
      navigate={navigate}
    />
  );
}

export default function run(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: RunScreen, key: declaration.id });
}
