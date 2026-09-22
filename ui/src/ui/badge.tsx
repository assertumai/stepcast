import { forwardRef, type HTMLAttributes } from 'react';

import { cn } from './utils';
import './badge.css';

export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive' | 'success' | 'running';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly variant?: BadgeVariant;
}

/**
 * Бейдж витрины — статус, слой, тир. Три состояния прогона (`running`,
 * `success`, `destructive` для отказа) красятся своей шкалой токенов
 * `--status-*`, как и прежний `.badge` в `styles.css`.
 */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant = 'outline', ...props },
  ref,
) {
  return <span ref={ref} className={cn('sc-badge', `sc-badge--${variant}`, className)} {...props} />;
});

/**
 * Вариант бейджа по статусу прогона или пункта очереди: идущее — цветом хода,
 * завершённое — успеха, отказавшее — отказа, остальное — нейтральный контур.
 */
export function statusBadgeVariant(status: string | undefined): BadgeVariant {
  switch (status) {
    case 'running':
    case 'in_progress':
    case 'waiting':
      return 'running';
    case 'success':
    case 'done':
    case 'accepted':
      return 'success';
    case 'failed':
    case 'budget_exceeded':
    case 'canceled':
    case 'rejected':
      return 'destructive';
    default:
      return 'outline';
  }
}
