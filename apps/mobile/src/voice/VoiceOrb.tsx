import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { colors } from '../theme';
import type { VoiceStatus } from './VoiceProvider';

const SIZE = 40;
/** The wave's bars: an id and how tall each one reaches. */
const BARS = [
  ['a', 0.5],
  ['b', 0.8],
  ['c', 1],
  ['d', 0.7],
  ['e', 0.45],
] as const;
const out = Easing.bezier(0.16, 1, 0.3, 1);
const breathe = Easing.inOut(Easing.sin);

/** A halo around the orb: it swells with the voice it is listening to. */
function Halo({
  level,
  scale,
  opacity,
}: {
  level: SharedValue<number>;
  scale: number;
  opacity: number;
}) {
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: 1.08 + level.value * scale }],
    opacity: opacity * (0.5 + level.value * 0.5),
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: 'absolute', width: SIZE, height: SIZE, borderRadius: SIZE / 2 },
        { backgroundColor: colors.assistant },
        style,
      ]}
    />
  );
}

/** One bar of the speaking wave, each on its own rhythm so the wave never repeats in step. */
function Bar({ i, active, still }: { i: number; active: boolean; still: boolean }) {
  const h = useSharedValue(0.3);
  useEffect(() => {
    if (!active || still) {
      cancelAnimation(h);
      h.value = withTiming(active ? BARS[i][1] * 0.7 : 0.3, { duration: 200, easing: out });
      return;
    }
    const beat = 260 + i * 70;
    h.value = withDelay(
      i * 60,
      withRepeat(
        withSequence(
          withTiming(BARS[i][1], { duration: beat, easing: breathe }),
          withTiming(0.18 + (i % 2) * 0.12, { duration: beat * 0.9, easing: breathe }),
        ),
        -1,
        true,
      ),
    );
    return () => cancelAnimation(h);
  }, [active, still, i, h]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleY: h.value }] }));
  return (
    <Animated.View
      style={[
        { width: 3, height: 22, borderRadius: 2, backgroundColor: colors.primaryText },
        style,
      ]}
    />
  );
}

/**
 * The assistant's presence while voice is on, in its own hue: it breathes while it connects,
 * swells with your voice while it listens, circles while it thinks, and carries a wave while it
 * speaks. With Reduce Motion it holds still and only its form says which state it is in.
 * `level` reads the live audio (0–1) for the side that is talking.
 */
export function VoiceOrb({
  status,
  muted,
  level,
}: {
  status: Exclude<VoiceStatus, 'off'>;
  muted: boolean;
  level: () => number;
}) {
  const still = useReducedMotion();
  const loud = useSharedValue(0);
  const breath = useSharedValue(0);
  const spin = useSharedValue(0);
  const listening = status === 'listening' && !muted;

  // The voice's loudness, eased so the halos follow speech rather than flicker with it.
  useEffect(() => {
    if (still || !(listening || status === 'speaking')) {
      loud.value = withTiming(0, { duration: 250, easing: out });
      return;
    }
    const tick = setInterval(() => {
      loud.value = withTiming(Math.min(1, level() * 2.2), { duration: 120, easing: out });
    }, 90);
    return () => clearInterval(tick);
  }, [listening, status, still, level, loud]);

  // Breath: slow while connecting, slower and smaller while listening in silence.
  useEffect(() => {
    if (still || !(status === 'connecting' || listening)) {
      cancelAnimation(breath);
      breath.value = withTiming(0, { duration: 200 });
      return;
    }
    const period = status === 'connecting' ? 900 : 1600;
    breath.value = withRepeat(withTiming(1, { duration: period, easing: breathe }), -1, true);
    return () => cancelAnimation(breath);
  }, [status, listening, still, breath]);

  // Thinking: an arc travelling round the orb.
  useEffect(() => {
    if (still || status !== 'thinking') {
      cancelAnimation(spin);
      return;
    }
    spin.value = 0;
    spin.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(spin);
  }, [status, still, spin]);

  const core = useAnimatedStyle(() => ({
    transform: [
      { scale: 1 + breath.value * (status === 'connecting' ? 0.06 : 0.035) + loud.value * 0.08 },
    ],
    opacity: status === 'connecting' ? 0.55 + breath.value * 0.35 : 1,
  }));
  // The halos follow your voice; in silence they still breathe a little, so listening never
  // looks frozen.
  const ring = useDerivedValue(() => Math.max(loud.value, 0.15 + breath.value * 0.45));
  const arc = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }] }));

  return (
    <View
      accessible={false}
      style={{
        width: SIZE + 16,
        height: SIZE + 16,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {listening && !still ? (
        <>
          <Halo level={ring} scale={0.6} opacity={0.2} />
          <Halo level={ring} scale={0.3} opacity={0.28} />
        </>
      ) : null}
      {status === 'thinking' ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              width: SIZE + 10,
              height: SIZE + 10,
              borderRadius: (SIZE + 10) / 2,
              borderWidth: 2,
              borderColor: 'transparent',
              borderTopColor: colors.assistant,
              borderRightColor: colors.assistant,
            },
            arc,
          ]}
        />
      ) : null}
      <Animated.View
        style={[
          {
            width: SIZE,
            height: SIZE,
            borderRadius: SIZE / 2,
            backgroundColor: muted ? colors.muted : colors.assistant,
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: 3,
            // A soft, offset shadow: the orb sits on the bar, it does not glow.
            shadowColor: colors.assistant,
            shadowOffset: { width: 0, height: 3 },
            shadowOpacity: 0.28,
            shadowRadius: 8,
            elevation: 3,
          },
          core,
        ]}
      >
        {status === 'speaking' ? (
          BARS.map(([id], i) => <Bar key={id} i={i} active still={still} />)
        ) : (
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: colors.primaryText,
              opacity: status === 'thinking' ? 0.6 : 0.95,
            }}
          />
        )}
      </Animated.View>
    </View>
  );
}
