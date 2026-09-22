import type { JSX, ReactNode } from 'react';

import { cn } from './utils';
import './pageHeader.css';

export interface PageHeaderProps {
  readonly title: ReactNode;
  /** Одна фраза о том, что на экране и как этим пользоваться. */
  readonly description?: ReactNode;
  /** Кнопки и переключатели справа от заголовка. */
  readonly actions?: ReactNode;
  readonly className?: string;
}

/** Шапка экрана — заголовок, описание и действия одним видом на всю витрину. */
export function PageHeader({ title, description, actions, className }: PageHeaderProps): JSX.Element {
  return (
    <header className={cn('sc-page-header', className)}>
      <div className="sc-page-header-text">
        <h1 className="sc-page-title">{title}</h1>
        {description === undefined ? null : <p className="sc-page-description">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="sc-page-actions">{actions}</div>}
    </header>
  );
}
