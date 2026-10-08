import type { HistoryEntry } from '@app/contracts';
import { useQuery } from '@tanstack/react-query';
import { Linking, Pressable, Text, View } from 'react-native';
import { api } from '../api';
import { STUDIO_URL } from '../config';
import { colors, space, styles } from '../theme';
import { AssistantMark } from './AssistantMark';
import { Icon, type IconName } from './Icon';
import { verbOf } from './verbs';
import { inApp, webHref } from './web-link';

function describe(e: HistoryEntry): { text: string; icon: IconName; tone: string } {
  const verb = verbOf(e.action);
  const who = e.actor === 'assistant' ? 'The assistant' : 'You';
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
        const d = describe(e);
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
                  {...webHref(`${STUDIO_URL}/traces/${e.runId}`)}
                  onPress={inApp(() => Linking.openURL(`${STUDIO_URL}/traces/${e.runId}`))}
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
