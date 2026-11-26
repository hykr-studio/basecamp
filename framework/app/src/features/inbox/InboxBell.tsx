import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../../framework/Icon';
import { inApp, webHref } from '../../framework/web-link';
import { colors } from '../../theme';
import { useInboxCount } from './hooks';

/** A bell that opens the inbox, with the number of unread items. Put it in a screen's header. */
export function InboxBell() {
  const unread = useInboxCount();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={unread ? `Inbox, ${unread} unread` : 'Inbox'}
      {...webHref('/inbox')}
      onPress={inApp(() => router.navigate('/inbox' as never))}
      hitSlop={8}
      style={s.bell}
    >
      <Icon name="bell" size={20} color={colors.text} />
      {unread ? (
        <View style={s.count}>
          <Text style={s.countText}>{unread > 99 ? '99+' : unread}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  bell: { padding: 6, position: 'relative' },
  count: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { color: colors.primaryText, fontSize: 10, fontWeight: '700' },
});
