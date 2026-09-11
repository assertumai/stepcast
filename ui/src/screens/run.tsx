import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/run/declaration.ts';
import type { RunSnapshot } from '../api';
import { RunDetail } from '../pages/RunDetail';
import { SCREEN } from '../plugins/shell';
import { screenHref } from '../router';

/**
 * Адрес страницы прогона — частный случай `hrefFor` (design.md, Решение 9).
 * Живёт здесь, у экрана, а не в маршрутизаторе: `id` берётся из объявления
 * этого же экрана, и ни каркас, ни маршрутизатор имени экрана не называют
 * (`ui-screens`, «Навигация и разбор адреса собираются из зарегистрированных
 * экранов»). Им пользуются экраны, ссылающиеся на прогон, — прогоны,
 * пайплайны, расход.
 */
export function runHref(projectKey: string, runId: string): string {
  return screenHref(declaration.id, { projectKey, runId });
}

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
