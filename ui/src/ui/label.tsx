import { forwardRef, type LabelHTMLAttributes } from 'react';

import { cn } from './utils';
import './label.css';

/** Подпись поля формы — приглушённая, того же кегля, что и текст поля. */
export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(function Label(
  { className, ...props },
  ref,
) {
  return <label ref={ref} className={cn('sc-label', className)} {...props} />;
});
