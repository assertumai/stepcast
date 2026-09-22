import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { cn } from './utils';
import './switch.css';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}

/**
 * Переключатель — кнопка с `role="switch"`, без примитива Radix: состояние
 * одно, булево, и клавиатура (Space, Enter) у кнопки уже есть.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { className, checked, onCheckedChange, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      disabled={disabled}
      className={cn('sc-switch', className)}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    >
      <span className="sc-switch-thumb" />
    </button>
  );
});
