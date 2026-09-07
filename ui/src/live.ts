import { useEffect, useState } from 'react';

import type { BacklogOverview, Overview, RunSnapshot } from './api';

/**
 * Живое состояние страницы: один `EventSource` на демон.
 *
 * Демон ведёт один общий наблюдатель на всех подключённых клиентов
 * (`src/ui/watcher.ts`), и открывать вторую подписку на той же вкладке значило
 * бы дублировать то, что уже приходит. `GET /api/events` шлёт `overview` и
 * `backlog` каждым кадром; с `?run=<адрес>` — тем же потоком ещё и `run`,
 * снимок прогона. Смена адреса прогона (переход на другую страницу прогона
 * или обратно на первый экран) пересоздаёт подписку с новым параметром —
 * второго запроса `GET /api/run` при этом не делается: снимок приходит
 * событием.
 */
/**
 * Состояние связи. «Ещё подключаемся» отделено от «связи нет»: пока поток
 * открывается, исправное соединение выглядело бы оборванным, а бейдж «нет
 * связи с демоном» на здоровой витрине — ложная тревога.
 */
export type LiveState = 'connecting' | 'live' | 'offline';

export interface Live {
  readonly overview: Overview | undefined;
  readonly backlog: BacklogOverview | undefined;
  readonly snapshot: RunSnapshot | undefined;
  readonly state: LiveState;
}

export function useLive(followedAddress?: string): Live {
  const [overview, setOverview] = useState<Overview | undefined>(undefined);
  const [backlog, setBacklog] = useState<BacklogOverview | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<RunSnapshot | undefined>(undefined);
  const [state, setState] = useState<LiveState>('connecting');

  useEffect(() => {
    // Прежний снимок принадлежит прежнему адресу: показывать его, пока не
    // пришёл новый, значило бы приписать чужие данные новой странице.
    setSnapshot(undefined);
    setState('connecting');

    const query = followedAddress === undefined ? '' : `?run=${encodeURIComponent(followedAddress)}`;
    const source = new EventSource(`/api/events${query}`);

    source.addEventListener('overview', (event) => {
      setState('live');
      setOverview(JSON.parse((event as MessageEvent<string>).data) as Overview);
    });
    source.addEventListener('backlog', (event) => {
      setState('live');
      setBacklog(JSON.parse((event as MessageEvent<string>).data) as BacklogOverview);
    });
    source.addEventListener('run', (event) => {
      setState('live');
      setSnapshot(JSON.parse((event as MessageEvent<string>).data) as RunSnapshot);
    });
    source.addEventListener('error', () => setState('offline'));

    return () => {
      source.close();
    };
  }, [followedAddress]);

  return { overview, backlog, snapshot, state };
}
