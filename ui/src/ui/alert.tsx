import { forwardRef, type HTMLAttributes } from 'react';

import { cn } from './utils';
import './alert.css';

export type AlertVariant = 'default' | 'destructive' | 'warning';

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  readonly variant?: AlertVariant;
}

/**
 * Полоса сообщения — отказ запроса, отказ сборки состава, предупреждение.
 * `role="alert"` ставится всегда: сообщение появляется в ответ на событие,
 * и читалка обязана его назвать.
 */
export const Alert = forwardRef<HTMLDivElement, AlertProps>(function Alert(
  { className, variant = 'default', ...props },
  ref,
) {
  return <div ref={ref} role="alert" className={cn('sc-alert', `sc-alert--${variant}`, className)} {...props} />;
});

export const AlertTitle = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function AlertTitle(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cn('sc-alert-title', className)} {...props} />;
});

export const AlertDescription = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function AlertDescription({ className, ...props }, ref) {
    return <div ref={ref} className={cn('sc-alert-description', className)} {...props} />;
  },
);
