import { Slot } from '@rn-primitives/slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { View } from 'react-native';
import { TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** Status pills, in the tones the app already uses (Rows.tsx StatusBadge). */
const badgeVariants = cva(
  'shrink-0 flex-row items-center gap-1 self-start rounded-full px-2.5 py-0.5',
  {
    variants: {
      variant: {
        neutral: 'bg-agent-bubble',
        info: 'bg-primary-tint',
        success: 'bg-success-tint',
        warn: 'bg-warn-bg',
        danger: 'bg-danger-tint',
        assistant: 'bg-assistant-tint',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

const badgeTextVariants = cva('text-small font-semibold', {
  variants: {
    variant: {
      neutral: 'text-muted',
      info: 'text-primary',
      success: 'text-success',
      warn: 'text-warn-text',
      danger: 'text-danger',
      assistant: 'text-assistant',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

type BadgeProps = React.ComponentProps<typeof View> &
  React.RefAttributes<View> & { asChild?: boolean } & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, asChild, ...props }: BadgeProps) {
  const Component = asChild ? Slot : View;
  return (
    <TextClassContext.Provider value={badgeTextVariants({ variant })}>
      <Component className={cn(badgeVariants({ variant }), className)} {...props} />
    </TextClassContext.Provider>
  );
}

export type { BadgeProps };
export { Badge, badgeTextVariants, badgeVariants };
