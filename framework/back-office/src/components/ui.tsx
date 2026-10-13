import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

type Tone = 'primary' | 'secondary' | 'quiet' | 'danger';

const BUTTON: Record<Tone, string> = {
  primary: 'bg-primary border-primary',
  secondary: 'bg-card border-border',
  quiet: 'bg-transparent border-transparent',
  danger: 'bg-card border-border',
};
const LABEL: Record<Tone, string> = {
  primary: 'text-primary-text',
  secondary: 'text-text',
  quiet: 'text-primary',
  danger: 'text-danger',
};

export function Button(props: {
  label: string;
  onPress: () => void;
  tone?: Tone;
  disabled?: boolean;
  busy?: boolean;
}) {
  const tone = props.tone ?? 'secondary';
  const off = props.disabled || props.busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy: props.busy }}
      disabled={off}
      onPress={props.onPress}
      className={`min-h-9 flex-row items-center justify-center gap-2 rounded-control border px-3 ${off ? 'opacity-50' : ''} ${BUTTON[tone]}`}
    >
      {props.busy ? <ActivityIndicator size="small" /> : null}
      <Text className={`text-small font-heading ${LABEL[tone]}`}>{props.label}</Text>
    </Pressable>
  );
}

type BadgeTone = 'neutral' | 'warn' | 'danger' | 'success' | 'primary';
const BADGE: Record<BadgeTone, string> = {
  neutral: 'bg-rail text-muted',
  warn: 'bg-warn-bg text-warn-text',
  danger: 'bg-danger-tint text-danger',
  success: 'bg-success-tint text-success',
  primary: 'bg-primary-tint text-primary',
};

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: BadgeTone }) {
  const [bg, fg] = BADGE[tone].split(' ');
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${bg}`}>
      <Text className={`text-small ${fg}`}>{label}</Text>
    </View>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View className="items-center justify-center gap-1 px-6 py-12">
      <Text className="text-heading font-heading text-text">{title}</Text>
      {children ? <Text className="text-body text-center text-muted">{children}</Text> : null}
    </View>
  );
}

export function ErrorLine({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <Text accessibilityRole="alert" className="text-small text-danger">
      {message}
    </Text>
  );
}
