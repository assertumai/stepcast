import type { JSX, ReactNode } from 'react';

import { cn } from './utils';
import './emptyState.css';

export interface EmptyStateProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}

/** Пустое состояние списка — что здесь бывает и как это сюда попадает. */
export function EmptyState({ title, description, action, className }: EmptyStateProps): JSX.Element {
  return (
    <div className={cn('sc-empty', className)}>
      <div className="sc-empty-title">{title}</div>
      {description === undefined ? null : <div className="sc-empty-description">{description}</div>}
      {action === undefined ? null : <div className="sc-empty-action">{action}</div>}
    </div>
  );
}
