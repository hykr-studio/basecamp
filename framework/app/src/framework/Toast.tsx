import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { colors, space } from '../theme';
import { Icon, type IconName } from './Icon';

type ToastInput = {
  message: string;
  tone?: 'success' | 'error' | 'neutral';
  action?: { label: string; onPress: () => void };
  durationMs?: number;
};
type Toast = ToastInput & { id: number };

const ToastContext = createContext<{ show: (t: ToastInput) => void } | null>(null);

/** Outcomes of decisions and undoable actions, announced politely to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  // Phones keep the bottom for navigation and approvals; toasts drop in from the top.
  const narrow = useWindowDimensions().width < 900;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((t: ToastInput) => {
    if (timer.current) clearTimeout(timer.current);
    const id = Date.now();
    setToast({ ...t, id });
    timer.current = setTimeout(
      () => setToast((cur) => (cur?.id === id ? null : cur)),
      t.durationMs ?? 6000,
    );
  }, []);
  const icon: Record<NonNullable<ToastInput['tone']>, IconName> = {
    success: 'check-circle',
    error: 'alert-circle',
    neutral: 'info',
  };
  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <View
        pointerEvents="box-none"
        style={[s.host, narrow ? { top: 60, bottom: undefined } : null]}
      >
        {toast && (
          <View style={s.toast} accessibilityLiveRegion="polite" accessibilityRole="text">
            <Icon
              name={icon[toast.tone ?? 'neutral']}
              color={
                toast.tone === 'error'
                  ? colors.inverseError
                  : toast.tone === 'success'
                    ? colors.inverseSuccess
                    : colors.inverseText
              }
            />
            <Text style={s.text}>{toast.message}</Text>
            {toast.action && (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  toast.action?.onPress();
                  setToast(null);
                }}
                style={s.action}
              >
                <Text style={s.actionText}>{toast.action.label}</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              onPress={() => setToast(null)}
              style={s.close}
            >
              <Icon name="x" color={colors.inverseText} size={16} />
            </Pressable>
          </View>
        )}
      </View>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast outside ToastProvider');
  return value;
}

const s = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 88,
    alignItems: 'center',
    paddingHorizontal: space.lg,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.inverseBg,
    borderRadius: 10,
    paddingLeft: space.lg,
    paddingRight: space.xs,
    paddingVertical: space.xs,
    maxWidth: 560,
    shadowColor: colors.shadow,
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  text: { color: colors.inverseText, fontSize: 14, flexShrink: 1, paddingVertical: space.sm },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.md },
  actionText: { color: colors.inverseLink, fontWeight: '700', fontSize: 14 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
