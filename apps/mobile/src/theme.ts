import { StyleSheet } from 'react-native';

export const colors = {
  bg: '#f5f6f8',
  card: '#ffffff',
  border: '#dfe3e8',
  text: '#1c2430',
  muted: '#667085',
  primary: '#2f5bea',
  primaryText: '#ffffff',
  danger: '#c0362c',
  warnBg: '#fff8db',
  warnBorder: '#f0d264',
  userBubble: '#2f5bea',
  agentBubble: '#eef1f5',
};

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 16, width: '100%', maxWidth: 1100, alignSelf: 'center' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 12,
  },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  heading: { fontSize: 16, fontWeight: '600', color: colors.text },
  text: { fontSize: 15, color: colors.text },
  muted: { fontSize: 13, color: colors.muted },
  error: { fontSize: 14, color: colors.danger },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.card,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
