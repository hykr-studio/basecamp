import { type HistoryEntry, stateLabel, statesOf } from '@hykr/contracts';
import type { Lang } from '@hykr/i18n';
import { useQuery } from '@tanstack/react-query';
import { Linking, Pressable, Text, View } from 'react-native';
import { api } from '../api';
import { appConfig } from '../config';
import { colors, space, styles } from '../theme';
import { AssistantMark } from './AssistantMark';
import { specs } from './hooks';
import { Icon, type IconName } from './Icon';
import { useT } from './lang';
import { verbOf } from './verbs';
import { inApp, webHref } from './web-link';

/** "Submitted → Approved": a state change in the words of the record's states. */
function moveOf(e: HistoryEntry, lang: Lang): string | null {
  if (!e.transition?.from || e.outcome !== 'committed') return null;
  const spec = Object.values(specs()).find((x) => x.name === e.resourceType);
  const trait = spec ? statesOf(spec) : undefined;
  if (!trait) return null;
  return `${stateLabel(trait, e.transition.from, lang)} → ${stateLabel(trait, e.transition.to, lang)}`;
}

function describe(e: HistoryEntry, lang: Lang): { text: string; icon: IconName; tone: string } {
  const verb = verbOf(e.action);
  const who = e.actor === 'assistant' ? 'The assistant' : 'You';
  const move = moveOf(e, lang);
  if (move)
    return {
      text: `${who} moved it: ${move}${e.approvedByYou ? ', approved by you' : ''}`,
      icon: 'arrow-right-circle',
      tone: colors.text,
    };
  if (e.outcome === 'needs_approval') {
    return {
      text: `${who} asked to ${verb.do} this`,
      icon: 'clock',
      tone: colors.approvalText,
    };
  }
  if (e.outcome === 'denied') {
    return {
      text: `${who} tried to ${verb.do} this; refused: ${e.reason ?? 'not allowed'}`,
      icon: 'x-circle',
      tone: colors.danger,
    };
  }
  return {
    text: `${who} ${verb.did} it${e.approvedByYou ? ', approved by you' : ''}`,
    icon: e.approvedByYou ? 'check-circle' : 'edit-3',
    tone: colors.text,
  };
}

/** What happened to this record, from the audit trail: who asked, who approved, when. */
/** `type` is an entity name from the catalog (the domain's or the framework's). */
export function History({ type, id }: { type: string; id: string }) {
  const { lang } = useT();
  const q = useQuery({ queryKey: ['history', type, id], queryFn: () => api.history(type, id) });
  // A command (close, move) also records the entity change it made: show the decision once.
  const commandRuns = new Set(
    (q.data ?? [])
      .filter((e) => e.outcome === 'committed' && !/\.(create|update|delete)$/.test(e.action))
      .map((e) => e.runId),
  );
  const entries = (q.data ?? []).filter(
    (e) => !(e.action.endsWith('.update') && e.runId && commandRuns.has(e.runId)),
  );
  if (!entries.length) return null;
  return (
    <View style={{ gap: space.sm }}>
      {entries.map((e) => {
        const d = describe(e, lang);
        return (
          <View
            key={`${e.at}:${e.action}:${e.outcome}:${e.actor}`}
            style={[styles.row, { alignItems: 'flex-start' }]}
          >
            {/* The assistant's rows carry its mark; the words and colour say what became of them. */}
            {e.actor === 'assistant' ? (
              <AssistantMark size={18} />
            ) : (
              <Icon name={d.icon} color={d.tone} size={16} />
            )}
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.text, { color: d.tone }]}>{d.text}</Text>
              <Text style={styles.muted}>
                {new Date(e.at).toLocaleString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {__DEV__ && e.runId ? ` · run ${e.runId.slice(0, 8)}` : ''}
              </Text>
              {__DEV__ && e.runId && e.runId.length === 32 && (
                <Pressable
                  accessibilityRole="link"
                  {...webHref(`${appConfig().studioUrl}/traces/${e.runId}`)}
                  onPress={inApp(() =>
                    Linking.openURL(`${appConfig().studioUrl}/traces/${e.runId}`),
                  )}
                  style={{ alignSelf: 'flex-start' }}
                >
                  <Text
                    style={[
                      styles.muted,
                      { color: colors.primary, textDecorationLine: 'underline' },
                    ]}
                  >
                    Open this run's trace in Studio
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}
