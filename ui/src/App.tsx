import type { JSX } from 'react';

import { MENU } from '../../src/ui/routes';
import { useLive } from './live';
import { useRoute } from './router';
import { Cleanup } from './pages/Cleanup';
import { Pipelines } from './pages/Pipelines';
import { RunDetail } from './pages/RunDetail';
import { Runs } from './pages/Runs';
import { Settings } from './pages/Settings';

/**
 * Каркас витрины: боковое меню слева, экран справа, один живой поток на
 * вкладку.
 *
 * Меню сбоку, а не полосой сверху: пунктов четыре, и колонка держит их в
 * одном столбце, не отнимая ширины у содержимого экрана и не завися от того,
 * сколько их станет. Признак живой связи стоит в подвале той же колонки —
 * он относится ко всей витрине, а не к текущему экрану.
 *
 * `useLive` подписан на адрес текущего прогона, когда он открыт, — и ни на
 * что, когда открыт любой из экранов меню. Переключение экрана меняет этот
 * адрес и тем самым пересоздаёт подписку: второй `EventSource` на вкладке не
 * заводится.
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
      <nav className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            navigate('/');
          }}
        >
          stepcast
        </a>

        {MENU.map((item) => (
          <a
            key={item.page}
            className={item.pages.includes(route.page) ? 'nav-item active' : 'nav-item'}
            href={item.href}
            aria-current={item.pages.includes(route.page) ? 'page' : undefined}
            onClick={(event) => {
              // Cmd/Ctrl-клик должен открывать вкладку: перехватывается только обычный переход.
              if (event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              navigate(item.href);
            }}
          >
            {item.title}
          </a>
        ))}

        <div className={state === 'live' ? 'live on' : 'live off'}>{liveLabel}</div>
      </nav>

      <main className="content">
        {route.page === 'runs' ? <Runs overview={overview} navigate={navigate} /> : null}
        {route.page === 'pipelines' ? <Pipelines overview={overview} navigate={navigate} /> : null}
        {route.page === 'cleanup' ? <Cleanup overview={overview} /> : null}
        {route.page === 'settings' ? <Settings /> : null}
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
