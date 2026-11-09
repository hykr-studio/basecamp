import { ShareError } from '@hykr/api-client';
import type { PageSpec, Shared, SharedPage, SharedRecord } from '@hykr/contracts';
import { isMoney } from '@hykr/contracts';
import { type Labels, moneyText } from '@hykr/i18n';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { PageHost } from '../../canvas/PageHost';
import { Button } from '../../components/Button';
import { SectionHeading } from '../../components/ScreenTitle';
import { when } from '../../framework/dates';
import { Icon } from '../../framework/Icon';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { getCatalog } from '../../runtime';
import { colors, fonts, space, styles } from '../../theme';
import { InlineView } from '../../views/InlineView';
import { ViewDataProvider } from '../../views/view-data';
import { AcceptDocument } from '../acceptance/AcceptDocument';
import { type AcceptanceClient, AcceptanceClientProvider } from '../acceptance/hooks';
import { dropShareSession, keepShareSession, shareClientFor } from './client';
import { PublicForm } from './PublicForm';

type Client = ReturnType<typeof shareClientFor>;
type Values = Record<string, unknown>;

/** Why a link shows nothing, in words: withdrawn, ended, used up, or not a link at all. */
function refusalOf(
  error: unknown,
): 'share.revoked' | 'share.expired' | 'share.used' | 'share.missing' {
  const code = error instanceof ShareError ? (error.body as { error?: string } | null)?.error : '';
  if (code === 'link_revoked') return 'share.revoked';
  if (code === 'link_expired') return 'share.expired';
  if (code === 'link_used') return 'share.used';
  return 'share.missing';
}

const messageOf = (e: unknown) => {
  const body = e instanceof ShareError ? (e.body as { message?: string } | null) : null;
  return body?.message ?? (e instanceof Error ? e.message : String(e));
};

/** The business the link is from: its logo and name. */
function Header({ shared }: { shared: Shared }) {
  const { t } = useT();
  return (
    <View style={{ gap: space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        {shared.business.logoUrl ? (
          <Image
            source={{ uri: shared.business.logoUrl }}
            accessibilityIgnoresInvertColors
            style={{ width: 32, height: 32, borderRadius: 6 }}
          />
        ) : null}
        <Text style={{ fontFamily: fonts.heading, fontSize: 20, color: colors.text }}>
          {shared.business.name}
        </Text>
      </View>
      {shared.link.label ? <Text style={styles.heading}>{shared.link.label}</Text> : null}
      <Text style={styles.muted}>{t('share.until', { date: when(shared.link.expiresAt) })}</Text>
    </View>
  );
}

/** A gated link: send the code to its recipient, then enter it. */
function Gate({
  token,
  client,
  gate,
  onOpened,
}: {
  token: string;
  client: Client;
  gate: NonNullable<Shared['gate']>;
  onOpened: () => void;
}) {
  const { t, lang } = useT();
  const [sent, setSent] = useState<{ id: string; sentTo: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.code(lang);
      if (r.status === 'done') setSent({ id: r.value.id, sentTo: r.value.sentTo });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    if (!sent || code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.verify(sent.id, code);
      if (r.status === 'done') {
        keepShareSession(token, r.value.session);
        onOpened();
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const channel = t(`acceptance.channel.${gate.channel}`);
  return (
    <View style={[styles.card, { gap: space.sm }]}>
      <Text style={styles.text}>{t('share.gate', { sentTo: gate.sentTo })}</Text>
      {sent ? (
        <>
          <Text style={styles.muted}>{t('share.codeSent', { sentTo: sent.sentTo })}</Text>
          <TextInput
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            accessibilityLabel={t('share.code')}
            placeholder="123456"
            placeholderTextColor={colors.placeholder}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            autoFocus
            onSubmitEditing={verify}
            style={styles.input}
          />
          <View style={[styles.row, { gap: space.sm, flexWrap: 'wrap' }]}>
            <Button
              title={t('share.openWithCode')}
              icon="unlock"
              busy={busy}
              disabled={code.length !== 6}
              onPress={verify}
            />
            <Button title={t('share.resend')} variant="ghost" onPress={() => setSent(null)} />
          </View>
        </>
      ) : (
        <Button
          title={t('share.sendCode', { channel })}
          icon={gate.channel === 'whatsapp' ? 'message-square' : 'mail'}
          variant="secondary"
          busy={busy}
          onPress={ask}
        />
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

/** A field's value as a guest reads it: money in their language, yes or no, dates, text. */
function useShown() {
  const { t, lang } = useT();
  return (value: unknown): string | null => {
    if (value === null || value === undefined || value === '') return null;
    if (isMoney(value)) return moneyText(value, lang);
    if (typeof value === 'boolean') return value ? t('share.form.yes') : t('share.form.no');
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return when(value);
    if (typeof value === 'object') return null;
    return String(value);
  };
}

/** The fields of a record its entity names (fieldLabels), as label: value lines. */
function Fields({ entity, value }: { entity: string; value: Values }) {
  const { pick } = useT();
  const shown = useShown();
  const labels = (getCatalog().entityByName(entity)?.fieldLabels ?? {}) as Record<string, Labels>;
  const keys = Object.keys(labels).length ? Object.keys(labels) : ['title', 'name'];
  const lines = keys
    .map((k) => ({ k, label: labels[k] ? pick(labels[k]) : k, text: shown(value[k]) }))
    .filter((l) => l.text !== null);
  if (!lines.length) return null;
  return (
    <View style={{ gap: 2 }}>
      {lines.map((l) => (
        <Text key={l.k} style={styles.text}>
          <Text style={styles.label}>{l.label}: </Text>
          {l.text}
        </Text>
      ))}
    </View>
  );
}

const headingOf = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);

/** A child entity's rows, one line each, indented under their parent row when nested. */
function Children({ group }: { group: SharedRecord['children'][number] }) {
  const spec = getCatalog().entityByName(group.entity);
  if (!group.items.length) return null;
  const nest = spec?.traits?.parent?.nest;
  const depth = new Map<string, number>();
  for (const row of group.items) {
    const up = nest ? (row[nest] as string | null | undefined) : null;
    depth.set(String(row.id), up ? (depth.get(up) ?? 0) + 1 : 0);
  }
  return (
    <View style={{ gap: space.sm }}>
      {/* A spec's label is written for sentences ("order item"); a heading starts with a capital. */}
      <SectionHeading>{headingOf(spec?.label ?? group.entity)}</SectionHeading>
      {group.items.map((row) => (
        <View
          key={String(row.id)}
          style={[s.childRow, { marginLeft: (depth.get(String(row.id)) ?? 0) * space.lg }]}
        >
          <Fields entity={group.entity} value={row} />
        </View>
      ))}
    </View>
  );
}

/** The record: its view (or its fields), its children, its PDFs and their acceptance. */
function RecordContent({
  token,
  client,
  record,
}: {
  token: string;
  client: Client;
  record: SharedRecord;
}) {
  const { t } = useT();
  const toast = useToast();
  const data = useMemo(
    () => ({
      readOnly: true,
      data: (key: string) => (key === 'record' ? { record: record.value } : undefined),
    }),
    [record],
  );
  const acceptances: AcceptanceClient = useMemo(
    () => ({
      scope: `share:${token}`,
      status: (documentId, lang) => client.acceptance.status(documentId, lang),
      challenge: (input) => client.acceptance.challenge(input),
      accept: (input) => client.acceptance.accept(input),
    }),
    [client, token],
  );
  const open = async (id: string) => {
    try {
      const doc = await client.document(id);
      if (doc.url) await Linking.openURL(doc.url);
    } catch (e) {
      toast.show({ tone: 'error', message: messageOf(e) });
    }
  };
  return (
    <View style={{ gap: space.lg }}>
      <ViewDataProvider value={data}>
        {record.view ? (
          <InlineView view={record.view} props={{ id: record.id }} dataKey="record" />
        ) : (
          <View style={{ gap: space.sm }}>
            <SectionHeading>{t('share.details')}</SectionHeading>
            <Fields entity={record.entity} value={record.value} />
          </View>
        )}
      </ViewDataProvider>
      {record.children.map((group) => (
        <Children key={group.entity} group={group} />
      ))}
      {record.documents.length ? (
        <View style={{ gap: space.sm }}>
          <SectionHeading>{t('share.documents')}</SectionHeading>
          {record.documents.map((d) => (
            <View key={d.id} style={s.docRow}>
              <Icon name="file-text" color={colors.muted} />
              <Text style={[styles.text, { flex: 1 }]} numberOfLines={1}>
                {d.name}
              </Text>
              <Button
                title={t('share.download', { name: d.name })}
                icon="external-link"
                iconOnly
                variant="ghost"
                onPress={() => void open(d.id)}
              />
            </View>
          ))}
        </View>
      ) : null}
      <AcceptanceClientProvider client={acceptances}>
        {record.documents
          .filter((d) => d.acceptable)
          .slice(0, 1)
          .map((d) => (
            <AcceptDocument key={d.id} documentId={d.id} />
          ))}
      </AcceptanceClientProvider>
    </View>
  );
}

/** A shared page: its blocks, with the data the link returned, actions off. */
function PageContent({ page }: { page: SharedPage }) {
  const data = useMemo(
    () => ({
      readOnly: true,
      data: (key: string) => page.blocks.find((b) => b.id === key)?.data,
    }),
    [page],
  );
  if (!page.blocks.length) return <EmptyShare />;
  const spec: PageSpec = {
    title: page.name,
    layout: page.layout,
    blocks: page.blocks.map((b) => ({
      id: b.id,
      view: b.view,
      ...(b.query ? { query: b.query } : {}),
      ...(b.props ? { props: b.props } : {}),
      span: b.span ?? 'half',
    })),
  };
  return (
    <ViewDataProvider value={data}>
      <Text style={styles.heading}>{page.name}</Text>
      <PageHost page={spec} />
    </ViewDataProvider>
  );
}

function EmptyShare() {
  const { t } = useT();
  return <Text style={styles.muted}>{t('share.empty')}</Text>;
}

/**
 * What a share link opens (`/share/:token`), for anyone holding it, signed in or not: the
 * business's name and logo, the code gate of a gated link, then the record (its view, children,
 * PDFs and acceptance), the page, or the form. Everything comes from the link's own routes.
 */
export function ShareScreen({ params }: { params: Readonly<Record<string, string>> }) {
  const { t } = useT();
  const token = params.token ?? '';
  const queries = useQueryClient();
  const client = useMemo(() => shareClientFor(token), [token]);
  const shared = useQuery({
    queryKey: ['share', token],
    queryFn: async () => {
      const got = await client.get();
      // A session the server no longer takes (ended, or the link's code changed): ask again.
      if (got.gate && !got.gate.verified) dropShareSession(token);
      return got;
    },
    retry: false,
  });
  const body = (() => {
    if (shared.isLoading)
      return <ActivityIndicator color={colors.primary} style={{ marginTop: space.xl }} />;
    if (shared.error || !shared.data)
      return <Text style={styles.text}>{t(refusalOf(shared.error))}</Text>;
    const d = shared.data;
    return (
      <View style={{ gap: space.lg }}>
        <Header shared={d} />
        {d.gate && !d.gate.verified ? (
          <Gate
            token={token}
            client={client}
            gate={d.gate}
            onOpened={() => void queries.invalidateQueries({ queryKey: ['share', token] })}
          />
        ) : d.record ? (
          <RecordContent token={token} client={client} record={d.record} />
        ) : d.page ? (
          <PageContent page={d.page} />
        ) : d.form ? (
          <PublicForm client={client} form={d.form} />
        ) : (
          <EmptyShare />
        )}
      </View>
    );
  })();
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{
        padding: space.lg,
        gap: space.lg,
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
      }}
    >
      {body}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  childRow: {
    paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
