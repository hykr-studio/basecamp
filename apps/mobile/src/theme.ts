import { StyleSheet } from 'react-native';

/** Semantic tokens: accent for actions, selection and state only; never decoration. */
export const colors = {
  bg: '#f5f6f8',
  rail: '#eceff3', // a second neutral layer for navigation
  card: '#ffffff',
  border: '#dfe3e8',
  divider: '#eceef2',
  text: '#1c2430',
  muted: '#5f6b7d', // 5.3:1 on white
  primary: '#2f5bea',
  primaryTint: '#e9eefd',
  primaryText: '#ffffff',
  danger: '#b4302a',
  dangerTint: '#fdecea',
  warnBg: '#fff8db',
  warnBorder: '#efd36a',
  warnText: '#7a5600', // on warnBg: 6.1:1
  success: '#1b7f4b',
  successTint: '#e6f4ec',
  disabledBg: '#e7e9ee',
  disabledText: '#8a94a3',
  userBubble: '#2f5bea',
  agentBubble: '#eef1f5',
};

/** A 4-based spacing scale. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.xl, width: '100%', maxWidth: 960, alignSelf: 'center' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.md,
  },
  section: { gap: space.sm },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  heading: { fontSize: 16, fontWeight: '600', color: colors.text },
  label: { fontSize: 13, fontWeight: '600', color: colors.text },
  text: { fontSize: 15, color: colors.text, lineHeight: 21 },
  muted: { fontSize: 13, color: colors.muted, lineHeight: 18 },
  error: { fontSize: 14, color: colors.danger },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    minHeight: 44,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.card,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});

/** List rows inside one card, separated by hairlines rather than a card each. */
export function listRow(index: number, count: number) {
  return {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderTopWidth: index === 0 ? 1 : 0,
    borderBottomWidth: 1,
    borderBottomColor: index === count - 1 ? colors.border : colors.divider,
    borderTopLeftRadius: index === 0 ? 12 : 0,
    borderTopRightRadius: index === 0 ? 12 : 0,
    borderBottomLeftRadius: index === count - 1 ? 12 : 0,
    borderBottomRightRadius: index === count - 1 ? 12 : 0,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  } as const;
}
