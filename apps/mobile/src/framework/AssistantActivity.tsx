import type { HistoryEntry } from '@app/contracts';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { api } from '../api';
import { SectionHeading } from '../components/ScreenTitle';
import { colors, space, styles } from '../theme';
import { labelOf } from './ApprovalPreview';
import { AssistantMark } from './AssistantMark';
import { when } from './dates';
import { isHovered } from './hover';
import { Icon } from './Icon';
import { storage } from './storage';
import { TryPrompt } from './TryPrompt';
import { verbOf } from './verbs';
import { inApp, webHref } from './web-link';

const VISIT = 'today.visit';
const SHOWN = 5;
/** A gap this long starts a new visit; a reload or a quick trip elsewhere does not. */
const NEW_VISIT_MS = 30 * 60_000;

/**
 * When the person's previous visit ended, kept per device as { previous, last }. Each time
 * the app opens after a pause of NEW_VISIT_MS, the last visit becomes the previous one.
 */
let since: string | null | undefined;
function previousVisit(): string | null {
  if (since !== undefined) return since;
  let visit: { previous: string | null; last: string | null } = { previous: null, last: null };
  try {
    visit = { ...visit, ...JSON.parse(storage.get(VISIT) ?? '{}') };
  } catch {}
  const now = new Date();
  const fresh = !visit.last || now.getTime() - Date.parse(visit.last) > NEW_VISIT_MS;
  const previous = fresh ? visit.last : visit.previous;
  storage.set(VISIT, JSON.stringify({ previous, last: now.toISOString() }));
  since = previous;
  return since;
}

/** "Created to-do “Order cement”", "Asked to close meeting “Site review”". */
function line(e: HistoryEntry): { text: string; tone: string } {
  const verb = verbOf(e.action);
  const what = `${labelOf(e.resourceType ?? '')}${e.title ? ` “${e.title}”` : ''}`;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (e.outcome === 'needs_approval')
    return { text: `Asked to ${verb.do} ${what}`, tone: colors.approvalText };
  if (e.outcome === 'denied')
    return {
      text: `Tried to ${verb.do} ${what}; refused: ${e.reason ?? 'not allowed'}`,
      tone: colors.danger,
    };
  return {
    text: `${cap(verb.did)} ${what}${e.approvedByYou ? ', approved by you' : ''}`,
    tone: colors.text,
  };
}

/**
 * "What the assistant did since you were last here": the latest lines of the audit trail by
 * the assistant, each with its mark. `hrefFor` lets the domain link a line to its record,
 * where the record's full history lives; `ask` is what to try when there is nothing yet.
 */
export function AssistantActivity({
  hrefFor,
  ask,
}: {
  hrefFor?: (type: string, id: string) => string | undefined;
  ask?: string;
}) {
  const after = previousVisit();
  const q = useQuery({
    queryKey: ['history', 'recent'],
    queryFn: () => api.recentHistory({ actor: 'assistant' }),
  });
  // A command (close, move) also records the entity change it made: show the decision once.
  const commandRuns = new Set(
    (q.data ?? [])
      .filter((e) => e.outcome === 'committed' && !/\.(create|update|delete)$/.test(e.action))
      .map((e) => e.runId),
  );
  const all = (q.data ?? []).filter(
    (e) => !(e.action.endsWith('.update') && e.runId && commandRuns.has(e.runId)),
  );
  const entries = after ? all.filter((e) => e.at > after) : all;

  return (
    <View style={styles.section}>
      <View style={{ gap: 2 }}>
        <SectionHeading>What the assistant did</SectionHeading>
        {after && entries.length > 0 && <Text style={styles.muted}>Since your last visit</Text>}
      </View>
      {q.isLoading ? (
        <Text style={styles.muted}>Loading…</Text>
      ) : q.error ? (
        <Text style={styles.muted}>Couldn't load what the assistant did.</Text>
      ) : entries.length === 0 ? (
        <View style={{ gap: space.xs }}>
          <Text style={styles.muted}>
            {all.length
              ? 'Nothing new since your last visit.'
              : 'Nothing yet. What it does for you will show here.'}
          </Text>
          {ask && !all.length && <TryPrompt text={ask} />}
        </View>
      ) : (
        <View style={{ gap: 2 }}>
          {entries.slice(0, SHOWN).map((e) => {
            const d = line(e);
            const href = e.resourceType && e.resourceId && hrefFor?.(e.resourceType, e.resourceId);
            const body = (
              <>
                <AssistantMark size={18} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.text, { color: d.tone }]}>{d.text}</Text>
                  <Text style={styles.muted}>{when(e.at)}</Text>
                </View>
                {href ? <Icon name="chevron-right" color={colors.muted} size={16} /> : null}
              </>
            );
            const key = `${e.at}:${e.action}:${e.outcome}:${e.resourceId}`;
            const row = {
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: space.sm,
              paddingVertical: space.xs,
              minHeight: 44,
            } as const;
            return href ? (
              <Pressable
                key={key}
                accessibilityRole="link"
                accessibilityLabel={`${d.text}. Open it`}
                {...webHref(href)}
                onPress={inApp(() => router.navigate(href as never))}
                style={(state) => [
                  row,
                  { borderRadius: 8, paddingHorizontal: space.sm, marginHorizontal: -space.sm },
                  isHovered(state) && { backgroundColor: colors.card },
                ]}
              >
                {body}
              </Pressable>
            ) : (
              <View key={key} style={row}>
                {body}
              </View>
            );
          })}
          {entries.length > SHOWN && (
            <Text style={styles.muted}>
              And {entries.length - SHOWN} more. Each record keeps its own history.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
