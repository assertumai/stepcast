import { useEffect, useState, type JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/proposals/declaration.ts';
import { fetchProposals, type ProposalsOverview, type ProposalsStreamEvent } from '../api';
import { Proposals } from '../pages/Proposals';
import { SCREEN } from '@stepcast/slots';

/**
 * Экран не заводит своего маршрута чтения потоком: событие `proposals`
 * несёт только облегчённый состав (`ui-proposals`, Решение 15) и служит
 * сигналом перечитать `GET /api/proposals`, который один несёт содержимое
 * цели, нужное дифу. Ссылка на объект меняется ровно тогда, когда
 * наблюдатель увидел сдвиг каталога очереди — то же правило отличия, что и у
 * `widgets`.
 */
function ProposalsScreen({
  navigate,
  proposals,
}: {
  readonly navigate: (href: string) => void;
  readonly proposals: ProposalsStreamEvent | undefined;
}): JSX.Element {
  const [overview, setOverview] = useState<ProposalsOverview | undefined>(undefined);

  const load = (): void => {
    fetchProposals()
      .then(setOverview)
      .catch(() => {
        // Отказ первого запроса оставляет экран на «Загрузка…» — следующее
        // событие потока или решение по записи позовёт `load()` заново.
      });
  };

  useEffect(load, [proposals]);

  return <Proposals overview={overview} navigate={navigate} onDecided={load} />;
}

export default function proposals(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: ProposalsScreen, key: declaration.id });
}
