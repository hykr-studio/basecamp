import { Slot } from '@rn-primitives/slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { Platform, Text as RNText, type Role } from 'react-native';
import { cn } from '@/lib/utils';

/** The app's type scale (theme.ts styles.title / heading / label / text / muted / error). */
const textVariants = cva(cn('text-text text-body', Platform.select({ web: 'select-text' })), {
  variants: {
    variant: {
      default: '',
      title: 'font-title text-title tracking-tight',
      heading: 'font-heading text-heading',
      label: 'text-small font-semibold',
      muted: 'text-muted text-small',
      error: 'text-danger text-small',
    },
  },
  defaultVariants: { variant: 'default' },
});

type TextVariantProps = VariantProps<typeof textVariants>;
type TextVariant = NonNullable<TextVariantProps['variant']>;

const ROLE: Partial<Record<TextVariant, Role>> = { title: 'heading', heading: 'heading' };
const ARIA_LEVEL: Partial<Record<TextVariant, string>> = { title: '1', heading: '2' };

/** Lets a parent (a Button) set its children's text classes. */
const TextClassContext = React.createContext<string | undefined>(undefined);

function Text({
  className,
  asChild = false,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof RNText> &
  React.RefAttributes<typeof RNText> &
  TextVariantProps & { asChild?: boolean }) {
  const textClass = React.useContext(TextClassContext);
  const Component = asChild ? Slot : RNText;
  return (
    <Component
      className={cn(textVariants({ variant }), textClass, className)}
      role={variant ? ROLE[variant] : undefined}
      aria-level={variant ? ARIA_LEVEL[variant] : undefined}
      {...props}
    />
  );
}

export { Text, TextClassContext, textVariants };
