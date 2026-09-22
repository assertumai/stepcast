import { forwardRef, type ComponentPropsWithoutRef, type HTMLAttributes, type JSX } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

import { cn } from './utils';
import './dialog.css';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export const DialogContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DialogPrimitive.Content>>(
  function DialogContent({ className, children, ...props }, ref) {
    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sc-dialog-overlay" />
        <DialogPrimitive.Content ref={ref} className={cn('sc-dialog-content', className)} {...props}>
          {children}
          <DialogPrimitive.Close className="sc-dialog-close" aria-label="Close">
            ×
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  },
);

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('sc-dialog-header', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('sc-dialog-footer', className)} {...props} />;
}

export const DialogTitle = forwardRef<HTMLHeadingElement, ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(
  function DialogTitle({ className, ...props }, ref) {
    return <DialogPrimitive.Title ref={ref} className={cn('sc-dialog-title', className)} {...props} />;
  },
);

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return <DialogPrimitive.Description ref={ref} className={cn('sc-dialog-description', className)} {...props} />;
});
