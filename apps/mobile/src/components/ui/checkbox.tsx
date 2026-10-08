import * as CheckboxPrimitive from '@rn-primitives/checkbox';
import { Platform, View } from 'react-native';
import { Icon } from '@/framework/Icon';
import { cn } from '@/lib/utils';
import { colors } from '@/theme';

/** The app's checkbox (as in TodoRow): 22px box, 44px target, filled primary when done. */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'relative size-[22px] shrink-0 items-center justify-center rounded-[6px] border-2 border-control-border',
        Platform.select({ web: 'outline-none', native: 'overflow-hidden' }),
        props.checked && 'border-primary bg-primary',
        props.disabled && 'opacity-50',
        className,
      )}
      hitSlop={11}
      {...props}
    >
      {/* The web ignores hitSlop: an invisible 44px layer around the box takes the click. */}
      {Platform.OS === 'web' && <View style={hitLayer} />}
      <CheckboxPrimitive.Indicator className="items-center justify-center">
        <Icon name="check" color={colors.primaryText} size={14} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

// Measured from inside the 2px border: 18 + 13 + 13 = 44.
const hitLayer = { position: 'absolute', top: -13, right: -13, bottom: -13, left: -13 } as const;

export { Checkbox };
