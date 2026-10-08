import type { VoiceLang } from '@app/contracts';
import { LANG_NAMES } from '@app/i18n';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, Pressable, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon, type IconName } from '../framework/Icon';
import { useT } from '../framework/lang';
import { colors } from '../theme';
import { VoiceOrb } from './VoiceOrb';
import { useVoice, type VoiceStatus } from './VoiceProvider';

const CHOICES: VoiceLang[] = ['auto', 'en-IN', 'hi-IN', 'te-IN'];
const STATUS: Record<Exclude<VoiceStatus, 'off'>, Parameters<ReturnType<typeof useT>['t']>[0]> = {
  connecting: 'voice.connecting',
  listening: 'voice.listening',
  thinking: 'voice.thinking',
  speaking: 'voice.speaking',
};

function Control({
  icon,
  label,
  onPress,
  tone = colors.primary,
  iconOnly = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tone?: string;
  /** Narrow: the icon alone (the label is still what a screen reader says). */
  iconOnly?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className={`min-h-11 flex-row items-center gap-1.5 rounded-control web:hover:bg-bg ${iconOnly ? 'min-w-11 justify-center' : 'px-3'}`}
    >
      <Icon name={icon} color={tone} size={iconOnly ? 18 : 16} />
      {iconOnly ? null : (
        <Text className="font-semibold" style={{ color: tone }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * The phone sheet's voice bar: one row (state, language, mute, end), so the conversation keeps
 * its room above the keyboard.
 */
function CompactBar({ name }: { name: (v: VoiceLang) => string }) {
  const voice = useVoice();
  const { t } = useT();
  if (voice.status === 'off') return null;
  const next = CHOICES[(CHOICES.indexOf(voice.lang) + 1) % CHOICES.length];
  const level = () => {
    const { you, reply } = voice.levels();
    return voice.status === 'speaking' ? reply : you;
  };
  return (
    <View className="flex-row items-center gap-1 rounded-control border border-assistant-border bg-assistant-tint pr-1">
      <View style={{ transform: [{ scale: 0.75 }], marginVertical: -6 }}>
        <VoiceOrb status={voice.status} muted={voice.muted} level={level} />
      </View>
      <Text className="shrink font-semibold text-assistant" numberOfLines={1}>
        {voice.muted ? t('voice.muted') : t(STATUS[voice.status])}
      </Text>
      <View className="flex-1" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t('voice.language')}: ${name(voice.lang)}`}
        onPress={() => voice.setLang(next)}
        className="min-h-11 flex-row items-center gap-1 rounded-control px-2 web:hover:bg-bg"
      >
        <Icon name="globe" color={colors.primary} size={16} />
        <Text className="font-semibold text-primary">{name(voice.lang)}</Text>
      </Pressable>
      {voice.micReady ? (
        <Control
          iconOnly
          icon={voice.muted ? 'mic' : 'mic-off'}
          label={voice.muted ? t('voice.unmute') : t('voice.mute')}
          onPress={() => void voice.toggleMute()}
        />
      ) : null}
      <Control
        iconOnly
        icon="phone-off"
        label={t('voice.end')}
        tone={colors.danger}
        onPress={() => void voice.stop()}
      />
    </View>
  );
}

/**
 * Voice mode, above the message box: what the assistant is doing, the language (Auto follows
 * the person; a pin holds), mute and end. Typing still works: a typed line is answered as a
 * spoken turn while voice is on.
 */
export function VoiceBar({ compact = false }: { compact?: boolean }) {
  const voice = useVoice();
  const { t } = useT();
  // iOS ignores live regions: say each change of state, so it is heard without looking.
  const said =
    voice.status === 'off' ? undefined : t(voice.muted ? 'voice.muted' : STATUS[voice.status]);
  useEffect(() => {
    if (said && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(said);
  }, [said]);
  if (voice.status === 'off')
    return voice.problem ? (
      <Text variant="muted" accessibilityLiveRegion="polite">
        {t(voice.problem)}
      </Text>
    ) : null;

  const next = CHOICES[(CHOICES.indexOf(voice.lang) + 1) % CHOICES.length];
  const name = (v: VoiceLang) =>
    v === 'auto' ? t('voice.auto') : LANG_NAMES[v.slice(0, 2) as keyof typeof LANG_NAMES];
  if (compact)
    return (
      <View className="gap-1">
        <CompactBar name={name} />
        {voice.problem ? (
          <Text variant="muted" accessibilityLiveRegion="polite">
            {t(voice.problem)}
          </Text>
        ) : null}
      </View>
    );
  // The orb follows whoever is talking: the person while listening, the reply while speaking.
  const level = () => {
    const { you, reply } = voice.levels();
    return voice.status === 'speaking' ? reply : you;
  };
  return (
    <View className="gap-1 rounded-control border border-assistant-border bg-assistant-tint px-2 py-1">
      <View className="flex-row items-center justify-between gap-2">
        <View
          className="min-h-11 shrink flex-row items-center gap-2 px-1"
          accessibilityLiveRegion="polite"
        >
          <VoiceOrb status={voice.status} muted={voice.muted} level={level} />
          <Text className="font-semibold text-assistant">
            {voice.muted ? t('voice.muted') : t(STATUS[voice.status])}
          </Text>
        </View>
        <Control
          icon="phone-off"
          label={t('voice.end')}
          tone={colors.danger}
          onPress={() => void voice.stop()}
        />
      </View>
      <View className="flex-row flex-wrap items-center gap-1">
        <Control
          icon="globe"
          label={`${t('voice.language')}: ${name(voice.lang)}`}
          onPress={() => voice.setLang(next)}
        />
        {voice.micReady ? (
          <Control
            icon={voice.muted ? 'mic' : 'mic-off'}
            label={voice.muted ? t('voice.unmute') : t('voice.mute')}
            onPress={() => void voice.toggleMute()}
          />
        ) : null}
      </View>
      {voice.problem ? (
        <Text variant="muted" accessibilityLiveRegion="polite">
          {t(voice.problem)}
        </Text>
      ) : null}
      {__DEV__ ? <Diagnostics /> : null}
    </View>
  );
}

/**
 * Dev only: what the session is doing under the hood. "transcribes: nobody" means spoken
 * words go unheard (the worker is in fake mode and this device cannot transcribe): type, or
 * run the worker with VOICE_MODE=live.
 */
function Diagnostics() {
  const voice = useVoice();
  const [mic, setMic] = useState(0);
  useEffect(() => {
    const tick = setInterval(() => setMic(voice.levels().you), 250);
    return () => clearInterval(tick);
  }, [voice]);
  const { hears, transcribes, room } = voice.debug;
  return (
    <Text variant="muted" className="px-1 pb-1 font-mono text-small" selectable>
      worker hears {hears ?? '…'} · transcribes: {transcribes} · mic {mic.toFixed(2)} ·{' '}
      {room?.split(':').at(-1) ?? 'no room'}
    </Text>
  );
}

/** The mic beside Send: starts voice mode. */
export function MicButton() {
  const voice = useVoice();
  const { t } = useT();
  if (voice.status !== 'off') return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('voice.talk')}
      onPress={() => void voice.start()}
      className="min-h-11 min-w-11 items-center justify-center rounded-control border border-border bg-card web:hover:bg-bg"
    >
      <Icon name="mic" color={colors.assistant} size={18} />
    </Pressable>
  );
}

/**
 * On a phone, voice keeps running when the assistant sheet is closed or the canvas covers it:
 * this strip above the tabs keeps it visible, and ends it or brings the conversation back.
 */
export function VoiceStrip({ onOpen }: { onOpen: () => void }) {
  const voice = useVoice();
  const { t } = useT();
  if (voice.status === 'off') return null;
  const level = () => {
    const { you, reply } = voice.levels();
    return voice.status === 'speaking' ? reply : you;
  };
  return (
    <View className="flex-row items-center gap-1 border-t border-assistant-border bg-assistant-tint px-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t(voice.muted ? 'voice.muted' : STATUS[voice.status])}. Open the assistant`}
        onPress={onOpen}
        className="min-h-11 flex-1 flex-row items-center gap-1"
      >
        <View style={{ transform: [{ scale: 0.7 }] }}>
          <VoiceOrb status={voice.status} muted={voice.muted} level={level} />
        </View>
        <Text className="font-semibold text-assistant">
          {t(voice.muted ? 'voice.muted' : STATUS[voice.status])}
        </Text>
      </Pressable>
      <Control
        icon="phone-off"
        label={t('voice.end')}
        tone={colors.danger}
        onPress={() => void voice.stop()}
      />
    </View>
  );
}
