import type { JSX } from 'react';

import { useLive } from './live';
import { useRoute } from './router';
import { Pipelines } from './pages/Pipelines';
import { RunDetail } from './pages/RunDetail';

/**
 * Каркас витрины: два экрана, один живой поток на вкладку.
 *
 * `useLive` подписан на адрес текущего прогона, когда он открыт, — и ни на
 * что, когда открыт первый экран. Переключение экрана меняет этот адрес и тем
 * самым пересоздаёт подписку: второй `EventSource` на вкладке не заводится.
 */
export function App(): JSX.Element {
  const { route, navigate } = useRoute();
  const followedAddress = route.page === 'run' ? `${route.projectKey}/${route.runId}` : undefined;
  const { overview, snapshot, state } = useLive(followedAddress);
  const liveLabel = {
    connecting: 'подключение к демону…',
    live: 'живое обновление',
    offline: 'нет связи с демоном',
  }[state];

  return (
    <div className="shell">
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            navigate('/');
          }}
        >
          stepcast
        </a>
        <span className={state === 'live' ? 'live on' : 'live off'}>{liveLabel}</span>
      </header>

      <main className="content">
        {route.page === 'pipelines' ? <Pipelines overview={overview} navigate={navigate} /> : null}
        {route.page === 'run' ? (
          <RunDetail
            key={`${route.projectKey}/${route.runId}`}
            projectKey={route.projectKey}
            runId={route.runId}
            snapshot={snapshot}
            navigate={navigate}
          />
        ) : null}
      </main>
    </div>
  );
}
