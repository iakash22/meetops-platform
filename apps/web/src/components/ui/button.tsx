import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { Button as BootstrapButton } from 'react-bootstrap';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/85',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline:
          'border border-border bg-card hover:border-input hover:bg-accent hover:text-accent-foreground',
        secondary:
          'border border-border bg-secondary text-secondary-foreground hover:bg-secondary/70',
        highlight: 'bg-highlight text-highlight-foreground hover:bg-highlight/90',
        shimmer:
          'shimmer bg-primary text-primary-foreground ring-1 ring-inset ring-white/10 hover:bg-primary/85',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-link underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-11 px-4 py-2',
        sm: 'h-11 rounded-md px-3 text-xs',
        lg: 'h-11 rounded-md px-8',
        icon: 'size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

type BsVariant = NonNullable<React.ComponentProps<typeof BootstrapButton>['variant']>;

/** Map MeetOps variants onto Bootstrap action variants (RB handles disabled/focus semantics). */
function bootstrapVariant(
  variant: NonNullable<VariantProps<typeof buttonVariants>['variant']> | null | undefined,
): BsVariant {
  switch (variant) {
    case 'destructive':
      return 'danger';
    case 'outline':
      return 'outline-secondary';
    case 'secondary':
      return 'secondary';
    case 'highlight':
      // Custom brand rose — CSS in bootstrap-theme.css defines `.btn-highlight`.
      return 'danger';
    case 'link':
    case 'ghost':
      return 'link';
    case 'shimmer':
    case 'default':
    default:
      return 'primary';
  }
}

function bootstrapSize(
  size: NonNullable<VariantProps<typeof buttonVariants>['size']> | null | undefined,
): 'sm' | 'lg' | undefined {
  if (size === 'sm') return 'sm';
  if (size === 'lg') return 'lg';
  return undefined;
}

export interface ButtonProps
  extends
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'size'>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type = 'button', ...props }, ref) => {
    const classes = cn(buttonVariants({ variant, size, className }));

    if (asChild) {
      return <Slot className={classes} ref={ref} {...props} />;
    }

    const bsSize = bootstrapSize(size);

    return (
      <BootstrapButton
        ref={ref}
        type={type}
        variant={bootstrapVariant(variant)}
        {...(bsSize ? { size: bsSize } : {})}
        className={cn(classes, variant === 'highlight' && 'btn-highlight')}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
