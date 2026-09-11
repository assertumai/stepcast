import { forwardRef, type InputHTMLAttributes } from 'react';

import { cn } from './utils';
import './input.css';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn('sc-input', className)} {...props} />;
});
