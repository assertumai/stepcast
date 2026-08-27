import type { JSX } from 'react';

import { MENU } from '../../src/ui/routes';
import { useLive } from './live';
import { useRoute } from './router';
import { Cleanup } from './pages/Cleanup';
import { Pipelines } from './pages/Pipelines';
import { RunDetail } from './pages/RunDetail';
import { Settings } from './pages/Settings';

/**
 * Каркас витрины: экраны меню, страница прогона и один живой поток на вкладку.
 *
 * `useLive` подписан на адрес текущего прогона, когда он открыт, — и ни на
 * что, когда открыт любой из экранов меню. Переключение экрана меняет этот
 * адрес и тем самым пересоздаёт подписку: второй `EventSource` на вкладке не
 * заводится.
 *
 * Страница прогона в меню не значится намеренно: пункт меню — место, куда
 * можно уйти в любой момент, а прогон открывается из списка и живёт под
 * пунктом «Пайплайны».
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

  // Страница прогона подсвечивает пункт, из которого на неё приходят: иначе
  // меню на ней выглядит так, будто открыт не относящийся к нему экран.
  const activePage = route.page === 'run' ? 'pipelines' : route.page;

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

        <nav className="menu">
          {MENU.map((item) => (
            <a
              key={item.page}
              className={item.page === activePage ? 'menu-item current' : 'menu-item'}
              href={item.href}
              aria-current={item.page === activePage ? 'page' : undefined}
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
        </nav>

        <span className={state === 'live' ? 'live on' : 'live off'}>{liveLabel}</span>
      </header>

      <main className="content">
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
