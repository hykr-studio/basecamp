import * as CheckboxPrimitive from '@rn-primitives/checkbox';
import { Platform } from 'react-native';
import { Icon } from '@/framework/Icon';
import { cn } from '@/lib/utils';
import { colors } from '@/theme';

/** The app's checkbox (as in TodoRow): 22px box, 44px target, filled primary when done. */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'size-[22px] shrink-0 items-center justify-center rounded-[6px] border-2 border-[#aab2bf]',
        Platform.select({ web: 'outline-none', native: 'overflow-hidden' }),
        props.checked && 'border-primary bg-primary',
        props.disabled && 'opacity-50',
        className,
      )}
      hitSlop={11}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="items-center justify-center">
        <Icon name="check" color={colors.primaryText} size={14} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
