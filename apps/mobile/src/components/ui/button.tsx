import { cva, type VariantProps } from 'class-variance-authority';
import { Platform, Pressable } from 'react-native';
import { TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * The app's buttons (the same variants as components/Button.tsx): primary for the one main
 * action, secondary outlined, subtle text-weight, ghost for a repeated row action, and
 * destructive for the confirming, irreversible one. 44px targets everywhere.
 */
const buttonVariants = cva(
  cn(
    'group shrink-0 flex-row items-center justify-center gap-2 rounded-control',
    Platform.select({ web: 'outline-none transition-colors disabled:pointer-events-none' }),
  ),
  {
    variants: {
      variant: {
        primary: cn('bg-primary active:opacity-85', Platform.select({ web: 'hover:bg-[#264cc8]' })),
        secondary: cn(
          'bg-card border border-border active:opacity-85',
          Platform.select({ web: 'hover:bg-primary-tint' }),
        ),
        subtle: cn('active:opacity-85', Platform.select({ web: 'hover:bg-primary-tint' })),
        ghost: cn('active:opacity-85', Platform.select({ web: 'hover:bg-primary-tint' })),
        destructive: cn(
          'bg-danger active:opacity-85',
          Platform.select({ web: 'hover:bg-danger-hover' }),
        ),
      },
      size: {
        default: 'min-h-11 px-4',
        sm: 'min-h-9 px-3',
        icon: 'size-11',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

const buttonTextVariants = cva('text-body font-semibold', {
  variants: {
    variant: {
      primary: 'text-primary-text',
      secondary: 'text-text',
      subtle: 'text-primary',
      ghost: 'text-muted',
      destructive: 'text-primary-text',
    },
    size: { default: '', sm: 'text-small', icon: '' },
  },
  defaultVariants: { variant: 'primary', size: 'default' },
});

type ButtonProps = React.ComponentProps<typeof Pressable> &
  React.RefAttributes<typeof Pressable> &
  VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <Pressable
        className={cn(
          buttonVariants({ variant, size }),
          props.disabled && 'bg-disabled-bg border-disabled-bg',
          className,
        )}
        role="button"
        {...props}
      />
    </TextClassContext.Provider>
  );
}

export type { ButtonProps };
export { Button, buttonTextVariants, buttonVariants };
