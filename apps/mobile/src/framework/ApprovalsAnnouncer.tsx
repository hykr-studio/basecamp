import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, Text, View } from 'react-native';
import { useApprovals } from './hooks';

/**
 * Says so when a new request arrives for the person's decision: the approvals bar and dock
 * appear without moving focus, so a screen reader would otherwise miss them. Only increases
 * are announced (requests found waiting when the list first loads count as one), never a
 * decision taking one away.
 * The web and Android read the polite live region; iOS ignores live regions, so it is told.
 */
export function ApprovalsAnnouncer() {
  const { approvals } = useApprovals();
  const count = approvals.length;
  const previous = useRef<number | null>(null);
  // A new key each time, so the same sentence twice is still a change the reader hears.
  const [message, setMessage] = useState({ text: '', n: 0 });
  useEffect(() => {
    const before = previous.current;
    previous.current = count;
    if (before === null || count <= before) return;
    const said = `${count} request${count === 1 ? '' : 's'} waiting for your decision`;
    setMessage((m) => ({ text: said, n: m.n + 1 }));
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(said);
  }, [count]);
  return (
    <View style={hidden} accessibilityLiveRegion="polite" pointerEvents="none">
      <Text key={message.n}>{message.text}</Text>
    </View>
  );
}

/** Off screen but still read: the usual visually-hidden pattern. */
const hidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  left: -10000,
  top: 0,
} as const;
