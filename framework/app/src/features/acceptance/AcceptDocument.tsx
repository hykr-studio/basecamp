import type { AcceptanceInfo, AcceptanceStatus } from '@hykr/contracts';
import { useState } from 'react';
import { Linking, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { SectionHeading } from '../../components/ScreenTitle';
import { when } from '../../framework/dates';
import { errorMessage } from '../../framework/hooks';
import { Icon } from '../../framework/Icon';
import { useT } from '../../framework/lang';
import { colors, space, styles } from '../../theme';
import { useDocuments } from '../documents/hooks';
import {
  useAccept,
  useAcceptanceClient,
  useAcceptanceKinds,
  useAcceptanceStatus,
  useRequestAcceptanceCode,
  useStartESign,
} from './hooks';

/** One acceptance: who accepted which version of the PDF, when, by which way. */
function Accepted({ a }: { a: AcceptanceInfo }) {
  const { t } = useT();
  return (
    <View style={s.row}>
      <Icon name="check-circle" color={a.verified === false ? colors.danger : colors.success} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.text}>
          {t('acceptance.accepted', {
            name: a.signer.name ?? t('acceptance.someone'),
            date: when(a.acceptedAt),
          })}
        </Text>
        <Text style={styles.muted}>
          {t('acceptance.pdf', { version: a.document.version })}
          {a.otp ? ` · ${t(`acceptance.channel.${a.otp.channel}`)} ${a.otp.sentTo}` : ''}
          {a.esign ? ` · ${a.esign.provider}` : ''}
        </Text>
        {a.verified === false && <Text style={styles.error}>{t('acceptance.tampered')}</Text>}
      </View>
    </View>
  );
}

/** The code step: where it went, the six digits, accept. */
function CodeEntry({
  challengeId,
  sentTo,
  onResend,
}: {
  challengeId: string;
  sentTo: string;
  onResend: () => void;
}) {
  const { t } = useT();
  const [code, setCode] = useState('');
  const accept = useAccept();
  const submit = () => code.length === 6 && accept.mutate({ challengeId, code });
  return (
    <View style={{ gap: space.sm }}>
      <Text style={styles.muted}>{t('acceptance.codeSent', { sentTo })}</Text>
      <TextInput
        value={code}
        onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
        accessibilityLabel={t('acceptance.code')}
        placeholder="123456"
        placeholderTextColor={colors.placeholder}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        autoFocus
        onSubmitEditing={submit}
        style={styles.input}
      />
      {accept.error && <Text style={styles.error}>{errorMessage(accept.error)}</Text>}
      <View style={[styles.row, { gap: space.sm, flexWrap: 'wrap' }]}>
        <Button
          title={t('acceptance.accept')}
          icon="check"
          busy={accept.isPending}
          disabled={code.length !== 6}
          onPress={submit}
        />
        <Button title={t('acceptance.resend')} variant="ghost" onPress={onResend} />
      </View>
    </View>
  );
}

/** What the person agrees to, and a button per way the code can reach them. */
function Ask({ status }: { status: AcceptanceStatus }) {
  const { t } = useT();
  const ask = useRequestAcceptanceCode();
  const esign = useStartESign();
  const canSign = !!useAcceptanceClient().esign;
  const [sent, setSent] = useState<{ id: string; sentTo: string } | null>(null);
  const request = (channel?: 'whatsapp' | 'email') =>
    ask.mutate(
      { documentId: status.document.id, channel, lang: status.lang },
      {
        onSuccess: (r) => {
          if (r.status === 'done') setSent({ id: r.value.id, sentTo: r.value.sentTo });
        },
      },
    );
  return (
    <View style={{ gap: space.sm }}>
      <Text style={styles.muted}>{t('acceptance.agree')}</Text>
      <Text style={styles.text}>{status.statement}</Text>
      <Text style={styles.muted}>
        {status.document.name} · {t('acceptance.pdf', { version: status.document.version })}
      </Text>
      {sent ? (
        <CodeEntry
          key={sent.id}
          challengeId={sent.id}
          sentTo={sent.sentTo}
          onResend={() => setSent(null)}
        />
      ) : (
        <View style={[styles.row, { gap: space.sm, flexWrap: 'wrap' }]}>
          {status.channels.map((c) => (
            <Button
              key={c.channel}
              title={t('acceptance.sendCode', {
                channel: t(`acceptance.channel.${c.channel}`),
                sentTo: c.sentTo,
              })}
              icon={c.channel === 'whatsapp' ? 'message-square' : 'mail'}
              variant="secondary"
              busy={ask.isPending && ask.variables?.channel === c.channel}
              onPress={() => request(c.channel)}
            />
          ))}
          {status.esign && canSign && (
            <Button
              title={t('acceptance.esign', { provider: status.esign })}
              icon="pen-tool"
              variant="secondary"
              busy={esign.isPending}
              onPress={() =>
                esign.mutate(
                  { documentId: status.document.id, lang: status.lang },
                  {
                    onSuccess: (r) => {
                      if (r.status === 'done' && r.value.url) void Linking.openURL(r.value.url);
                    },
                  },
                )
              }
            />
          )}
        </View>
      )}
      {ask.error && <Text style={styles.error}>{errorMessage(ask.error)}</Text>}
      {esign.error && <Text style={styles.error}>{errorMessage(esign.error)}</Text>}
    </View>
  );
}

/**
 * Accepting one PDF: the words the person agrees to, a code to their own WhatsApp number or
 * email (masked), the code entry, then who accepted it and when. Someone who may not accept it
 * sees only its acceptances (or nothing yet).
 */
export function AcceptDocument({ documentId }: { documentId: string }) {
  const { t, lang, pick } = useT();
  const status = useAcceptanceStatus(documentId, lang);
  if (!status.data) return null;
  const st = status.data;
  return (
    <View style={{ gap: space.sm }}>
      <SectionHeading>{pick(st.label)}</SectionHeading>
      {st.can.ok ? <Ask status={st} /> : null}
      {st.accepted.length ? (
        st.accepted.map((a) => <Accepted key={a.id} a={a} />)
      ) : st.can.ok ? null : (
        <Text style={styles.muted}>{t('acceptance.none')}</Text>
      )}
    </View>
  );
}

/**
 * A record's acceptance: the newest made PDF of the document its acceptance names, accepted
 * with `AcceptDocument`. Nothing shows for an entity without an acceptance, or before a PDF is
 * made.
 */
export function RecordAcceptance({ entity, id }: { entity: string; id: string }) {
  const kinds = useAcceptanceKinds(entity);
  const docs = useDocuments(entity, id);
  const kind = kinds.data?.[0];
  if (!kind) return null;
  const newest = (docs.data ?? []).find(
    (d) => d.document === kind.document && d.status === 'ready',
  );
  return newest ? <AcceptDocument documentId={newest.id} /> : null;
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
});
