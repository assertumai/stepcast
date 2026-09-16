import type { JSX, ReactNode } from 'react';

import type { RouteTarget } from '../../src/parts/ui/routes.ts';
import { hrefForTarget } from './router';

/**
 * Ссылка на цель маршрута — один вид на всю витрину (`ui-routes`, Решение 8;
 * «Ссылка на цель без маршрута»): если ни один действующий маршрут к этой цели
 * не ведёт, место не пропадает и не превращается в безымянный текст — оно
 * называет причину.
 *
 * Три самодельных ветки «а вдруг `undefined`» (переключатель периодов, строка
 * прогона в списке, последний прогон пайплайна) сведены сюда: пользователь,
 * отключивший маршрут страницы прогона, обязан увидеть одно и то же
 * объяснение всюду, а не исчезнувшую кнопку в одном месте и молчаливый текст
 * в другом.
 */

/** Причина отсутствия ссылки — называет цель, маршрута к которой нет. */
export function missingRouteReason(target: RouteTarget): string {
  return `маршрута нет: ни один действующий маршрут не ведёт к цели ${target.kind}:${target.id}`;
}

export interface TargetLinkProps {
  readonly target: RouteTarget;
  /** Параметры пути для сборки адреса — имена шаблона маршрута. */
  readonly params?: Readonly<Record<string, string>>;
  readonly navigate: (href: string) => void;
  readonly className?: string;
  readonly children: ReactNode;
}

export function TargetLink({ target, params = {}, navigate, className, children }: TargetLinkProps): JSX.Element {
  const href = hrefForTarget(target, params);
  if (href === undefined) {
    const reason = missingRouteReason(target);
    return (
      <span className={className === undefined ? 'missing-link' : `${className} missing-link`} title={reason}>
        {children}
        <span className="missing-link-reason">{reason}</span>
      </span>
    );
  }
  return (
    <a
      {...(className === undefined ? {} : { className })}
      href={href}
      onClick={(event) => {
        // Средняя кнопка и Cmd/Ctrl-клик должны открывать вкладку:
        // перехватывается только обычный переход.
        if (event.metaKey || event.ctrlKey || event.button !== 0) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
