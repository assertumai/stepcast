import type { JSX } from 'react';
import type { Context } from 'cordis';

import { declaration } from '../../../src/ui/screens/routes/declaration.ts';
import { HOME_ROUTES_FILE, RoutesNotice } from '../pages/Routes';
import { RoutesEditor } from '../pages/RoutesEditor';
import { useRoutes } from '../router';
import { ROUTES_LISTING_KEY, SCREEN } from '@stepcast/slots';

/**
 * Экран «Маршруты» — своя строка состава, своя половина (`ui-routes`,
 * design.md Решение 12). Та же половина вносится и ключом перечня на
 * неизвестном адресе (`ROUTES_LISTING_KEY`, `ui/src/plugins/shell.tsx`):
 * перечень маршрутов — вклад этой же строки, а не отдельная сущность.
 *
 * Вклад в ключ перечня — не сам экран, а экран под причиной: пользователь,
 * попавший сюда неразобранным адресом, обязан прочесть, почему он здесь
 * («адрес не разобран», «стартовая страница не объявлена», «действующих
 * маршрутов нет»), а не увидеть просто заголовок «Маршруты» (`ui-routes`,
 * «Стартовая страница не объявлена», «Таблица пуста»).
 */
function RoutesListingScreen(): JSX.Element {
  const { table } = useRoutes();
  return (
    <div className="routes-listing">
      {/* Причина отказа сборки не дублируется: её называет сам редактор
          ответом `GET /api/routes` и полоса каркаса над содержимым. */}
      <RoutesNotice pathname={window.location.pathname} table={table} layerFile={HOME_ROUTES_FILE} />
      <RoutesEditor />
    </div>
  );
}

export default function routes(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: RoutesEditor, key: declaration.id });
  ctx.slots.contribute(SCREEN, { component: RoutesListingScreen, key: ROUTES_LISTING_KEY });
}
