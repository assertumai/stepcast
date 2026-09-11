import type { JSX } from 'react';

import type { RouteTable } from '../../../src/ui/routes.ts';

/** Файл слоя, в который витрина пишет маршруты по умолчанию, — для подсказок на странице. */
export const HOME_ROUTES_FILE = '~/.stepcast/routes.yml';

export interface RoutesNoticeProps {
  readonly pathname: string;
  readonly table: RouteTable;
  /** Причина отказа последней сборки таблицы — не показывается там, где её уже называет соседний вид. */
  readonly buildError?: string | undefined;
  /** Файл слоя, в который пишутся маршруты, — для подсказки на пустой таблице (`ui-routes`, «Таблица пуста»). */
  readonly layerFile: string;
}

/**
 * Причина, по которой вместо цели показан перечень маршрутов (`ui-routes`,
 * «Адрес без маршрута показывает перечень объявленных маршрутов»): адрес не
 * разобран, стартовая страница не объявлена, действующих маршрутов нет вовсе.
 *
 * Отдельный вид, а не часть перечня, потому что перечней два: голый текстовый
 * (ниже) и полный, с источниками и формой правки, от строки `screen-routes`
 * (`ui/src/screens/routes.tsx`). Причина обязана быть названа в обоих — иначе
 * в поставочной конфигурации, где строка включена, пользователь видел бы
 * экран «Маршруты» без единого слова о том, почему он на него попал.
 */
export function RoutesNotice({ pathname, table, buildError, layerFile }: RoutesNoticeProps): JSX.Element {
  const hasRoot = table.some((route) => route.path === '/');
  return (
    <div className="routes-notice">
      <h1>Адрес не разобран ни одним маршрутом</h1>
      <p className="dim">
        Открыт <code>{pathname}</code>
      </p>
      {buildError === undefined ? null : (
        <p className="routes-listing-error" role="alert">
          Таблица маршрутов не пересобрана: {buildError}
        </p>
      )}
      {pathname === '/' && !hasRoot ? <p>Стартовая страница не объявлена: ни один маршрут не назвал путь «/».</p> : null}
      {table.length === 0 ? (
        <p>Действующих маршрутов нет — все отключены слоями пользователя. Файл слоя: {layerFile}</p>
      ) : null}
    </div>
  );
}

export type RoutesListingProps = RoutesNoticeProps;

/**
 * Перечень объявленных маршрутов на неизвестном адресе — голым текстом, без
 * источников (`ui-routes`, design.md Решение 12): экран «Маршруты»
 * (`ui/src/screens/routes.tsx`) вносит более полный вид с источниками и
 * правкой в тот же ключ слота, если он в действующем составе. Этот компонент
 * — то, что видит пользователь, когда строка отключена или состав экранов
 * ещё не пришёл: витрина не должна становиться пустой страницей из-за того,
 * что выключен один экран (`ui-routes`, Решение 12).
 */
export function RoutesListing({ pathname, table, buildError, layerFile }: RoutesListingProps): JSX.Element {
  return (
    <div className="routes-listing">
      <RoutesNotice pathname={pathname} table={table} buildError={buildError} layerFile={layerFile} />
      {table.length === 0 ? null : (
        <ul>
          {table.map((route) => (
            <li key={route.id}>
              <code>{route.path}</code> → {route.target.kind}:{route.target.id}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
