import { forwardRef, type HTMLAttributes } from 'react';

import { cn } from './utils';
import './separator.css';

export interface SeparatorProps extends HTMLAttributes<HTMLDivElement> {
  readonly orientation?: 'horizontal' | 'vertical';
  /** Подпись посередине линии — заголовок группы меню или раздела. */
  readonly label?: string;
}

/** Разделитель разделов — линия на токене рамки, с необязательной подписью. */
export const Separator = forwardRef<HTMLDivElement, SeparatorProps>(function Separator(
  { className, orientation = 'horizontal', label, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={orientation}
      className={cn('sc-separator', `sc-separator--${orientation}`, label !== undefined && 'sc-separator--labeled', className)}
      {...props}
    >
      {label === undefined ? null : <span className="sc-separator-label">{label}</span>}
    </div>
  );
});
