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
  success: '#146b3d', // on successTint: 5.8:1
  successTint: '#e6f4ec',
  disabledBg: '#e7e9ee',
  disabledText: '#6b7480', // 3.9:1 on disabledBg
  /** Placeholders: readable (4.6:1) but lighter than secondary text; examples start with "e.g.". */
  placeholder: '#6b7684',
  /** The approval surface: its own calm identity, not the warning style. */
  approvalBg: '#f3f6ff',
  approvalBorder: '#cdd7f6',
  approvalText: '#2f4a9e', // 7.5:1 on approvalBg
  dangerHover: '#962722',
  /** Your own words: ink, so they never read as a button. */
  userBubble: '#243042', // white text 13.3:1
  agentBubble: '#eef1f5',
  /**
   * The assistant's mark: one hue, used only where the assistant acted (its chat turns, what it
   * asked for, what it created). Never for actions, so it cannot be mistaken for a button.
   */
  assistant: '#6a3fc8', // 6.7:1 on white, 5.9:1 on assistantTint
  assistantTint: '#f4effd',
  assistantBorder: '#ddd0f7',
  /** Hover on a filled primary button. */
  primaryHover: '#264cc8',
  /** Hover on a rail item: one step darker than the rail. */
  railHover: '#e2e6ec',
  /** An unticked checkbox's outline: 3.3:1 on white, 3.1:1 on bg (WCAG 1.4.11). */
  controlBorder: '#858e9c',
  scrollbar: '#c3c9d3',
  shadow: '#000000',
  /** The toast: a dark surface, so an outcome reads apart from the page. */
  inverseBg: '#1c2430',
  inverseText: '#ffffff',
  inverseLink: '#a9c1ff',
  inverseSuccess: '#9be3bb',
  inverseError: '#ffb4ad',
};

/**
 * Headings use Schibsted Grotesk (loaded in the root layout), a sturdy news grotesque that
 * reads as a record of decisions; body text stays the platform face. Each weight is its own
 * family, so native platforms never synthesise a bold.
 */
export const fonts = {
  heading: 'SchibstedGrotesk_600SemiBold',
  title: 'SchibstedGrotesk_700Bold',
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
  title: { fontSize: 24, fontFamily: fonts.title, letterSpacing: -0.3, color: colors.text },
  heading: { fontSize: 17, fontFamily: fonts.heading, letterSpacing: -0.1, color: colors.text },
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
