import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { cn } from './utils';
import './button.css';

export type ButtonVariant = 'default' | 'outline' | 'destructive' | 'ghost' | 'link';
export type ButtonSize = 'default' | 'sm' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

/** Кнопка витрины и плагина — та же вёрстка, что и у встроенных экранов, без своего CSS у плагина (`ui-components`, «Плагин рисует кнопку витрины»). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'default', size = 'default', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('sc-button', `sc-button--${variant}`, `sc-button--${size}`, className)}
      {...props}
    />
  );
});
