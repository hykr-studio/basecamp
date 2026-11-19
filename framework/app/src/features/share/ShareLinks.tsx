import type {
  ShareCreated,
  ShareLinkInfo,
  ShareRecipient,
  ShareSendInfo,
  ShareTarget,
} from '@hykr/contracts';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { SectionHeading } from '../../components/ScreenTitle';
import { when } from '../../framework/dates';
import { errorMessage } from '../../framework/hooks';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { colors, space, styles } from '../../theme';
import {
  useCanShare,
  useCreateShare,
  useReissueShare,
  useRenewShare,
  useRevokeShare,
  useShareKinds,
  useShares,
} from './hooks';

const clipboard =
  Platform.OS === 'web' && typeof navigator !== 'undefined' ? navigator.clipboard : undefined;

type Otp = 'whatsapp' | 'email' | null;

/** A send's state, in words. */
function sendState(t: ReturnType<typeof useT>['t'], send: ShareSendInfo) {
  return send.status === 'sent'
    ? t('share.sent.status.sent', { channel: t(`acceptance.channel.${send.channel ?? 'email'}`) })
    : send.status === 'failed'
      ? t('share.sent.status.failed', { error: send.error ?? '' })
      : t(`share.sent.status.${send.status}`);
}

/**
 * One link: its state, how often it was opened or answered, its sends, and ways to renew it
 * (the same address, a new end date), make a new one in its place (sent to its recipient when
 * it has one) and revoke it.
 */
function LinkRow({
  link,
  lasting,
  onMade,
}: {
  link: ShareLinkInfo;
  lasting: boolean;
  onMade: (made: ShareCreated) => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const revoke = useRevokeShare();
  const renew = useRenewShare();
  const reissue = useReissueShare();
  const state =
    link.status === 'active'
      ? link.expiresAt
        ? t('share.status.active', { date: when(link.expiresAt) })
        : t('share.status.lasting')
      : t(`share.status.${link.status}`);
  const label = link.label ?? '';
  const failed = (e: unknown) => toast.show({ tone: 'error', message: errorMessage(e) });
  const hasRecipient = !!(link.to?.contactId || link.to?.customerId || link.to?.email);
  return (
    <View style={s.row}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.text} numberOfLines={1}>
          {label || state}
        </Text>
        <Text style={styles.muted}>
          {[
            label ? state : null,
            link.otp ? t('share.withCode', { channel: link.otp.sentTo }) : null,
            link.maxUses !== null
              ? t('share.uses', { uses: link.uses, max: link.maxUses })
              : t('share.seen', { views: link.views }),
            ...(link.sends ?? []).slice(0, 1).map((send) => sendState(t, send)),
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      {link.status !== 'revoked' && (
        <Button
          title={t('share.renew')}
          icon="refresh-cw"
          variant="ghost"
          busy={renew.isPending}
          onPress={() =>
            renew.mutate(
              { id: link.id, expiresInDays: lasting && !link.expiresAt ? null : 30 },
              {
                onSuccess: () => toast.show({ tone: 'success', message: t('share.renewed') }),
                onError: failed,
              },
            )
          }
        />
      )}
      {link.status !== 'revoked' && (
        <Button
          title={hasRecipient ? t('share.reissueSend') : t('share.reissue')}
          icon="send"
          variant="ghost"
          busy={reissue.isPending}
          onPress={() =>
            reissue.mutate(
              { id: link.id, send: hasRecipient },
              {
                onSuccess: (r) => {
                  if (r.status !== 'done') return;
                  onMade(r.value);
                  toast.show({ tone: 'success', message: t('share.reissued') });
                },
                onError: failed,
              },
            )
          }
        />
      )}
      {link.status === 'active' && (
        <Button
          title={t('share.revokeLink', { label })}
          icon="x-circle"
          iconOnly
          variant="ghost"
          busy={revoke.isPending}
          onPress={() => revoke.mutate(link.id, { onError: failed })}
        />
      )}
    </View>
  );
}

/** The link just made: shown once, to copy. */
function Made({ made }: { made: ShareCreated }) {
  const { t } = useT();
  const toast = useToast();
  return (
    <View style={[s.made, { gap: space.xs }]}>
      <Text style={styles.label}>{t('share.once')}</Text>
      <Text selectable style={styles.text}>
        {made.url}
      </Text>
      {clipboard ? (
        <Button
          title={t('share.copy')}
          icon="copy"
          variant="secondary"
          onPress={() =>
            void clipboard
              .writeText(made.url)
              .then(() => toast.show({ tone: 'success', message: t('share.copied') }))
          }
        />
      ) : null}
    </View>
  );
}

/**
 * A record's, a page's or a form's share links (decisions B9, B21), for people who may share
 * (`shares.create`): make one (for how many days, or with no end where allowed; with a code to
 * the recipient or not), copy it once or have it sent to its recipient, see how often each was
 * opened and how its send went, renew one, send a new one in its place, and revoke one. `to` is who a link is for (the record's
 * customer, say); without it a code can go to an email typed here.
 */
export function ShareLinks({
  target,
  to,
  maxUses,
}: {
  target: ShareTarget;
  to?: ShareRecipient;
  /** A form link: how many answers it takes. */
  maxUses?: number;
}) {
  const { t } = useT();
  const can = useCanShare();
  const links = useShares(target, can);
  const create = useCreateShare();
  const kinds = useShareKinds();
  const [days, setDays] = useState('');
  const [noEnd, setNoEnd] = useState(false);
  const [send, setSend] = useState(false);
  const [otp, setOtp] = useState<Otp>(null);
  const [email, setEmail] = useState('');
  const [made, setMade] = useState<ShareCreated | null>(null);
  if (!can) return null;
  const kind =
    'form' in target
      ? kinds.data?.forms.find((f) => f.name === target.form)
      : 'entity' in target
        ? kinds.data?.entities.find((e) => e.entity === target.entity)
        : undefined;
  const lasting = !!kind?.lasting && !!kinds.data?.allowLasting;
  const recipient: ShareRecipient | undefined =
    to ?? (otp === 'email' && email.trim() ? { email: email.trim() } : undefined);
  const make = () =>
    create.mutate(
      {
        target,
        ...(lasting && noEnd
          ? { expiresInDays: null }
          : days.trim()
            ? { expiresInDays: Number(days) }
            : {}),
        ...(send && recipient ? { send: {} } : {}),
        ...(otp ? { otp } : {}),
        ...(recipient ? { to: recipient } : {}),
        ...(maxUses ? { maxUses } : {}),
      },
      { onSuccess: (r) => r.status === 'done' && setMade(r.value) },
    );
  const choices: Otp[] = [null, 'whatsapp', 'email'];
  return (
    <View style={{ gap: space.sm }}>
      <SectionHeading>{t('share.links')}</SectionHeading>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
        {choices.map((c) => {
          const on = otp === c;
          return (
            <Pressable
              key={c ?? 'none'}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => setOtp(c)}
              style={[s.chip, on && s.chipOn]}
            >
              <Text style={{ color: on ? colors.primary : colors.text }}>
                {c
                  ? t('share.withCode', { channel: t(`acceptance.channel.${c}`) })
                  : t('share.noCode')}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
        {lasting ? (
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: noEnd }}
            onPress={() => setNoEnd(!noEnd)}
            style={[s.chip, noEnd && s.chipOn]}
          >
            <Text style={{ color: noEnd ? colors.primary : colors.text }}>
              {t('share.lasting')}
            </Text>
          </Pressable>
        ) : null}
        {recipient ? (
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: send }}
            accessibilityHint={t('share.sendIt.hint')}
            onPress={() => setSend(!send)}
            style={[s.chip, send && s.chipOn]}
          >
            <Text style={{ color: send ? colors.primary : colors.text }}>{t('share.sendIt')}</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={[styles.row, { gap: space.sm, flexWrap: 'wrap' }]}>
        {lasting && noEnd ? null : (
          <TextInput
            value={days}
            onChangeText={(v) => setDays(v.replace(/\D/g, '').slice(0, 4))}
            accessibilityLabel={t('share.days')}
            placeholder={t('share.days')}
            placeholderTextColor={colors.placeholder}
            keyboardType="number-pad"
            style={[styles.input, { width: 170 }]}
          />
        )}
        {otp === 'email' && !to ? (
          <TextInput
            value={email}
            onChangeText={setEmail}
            accessibilityLabel="Email"
            placeholder="name@example.com"
            placeholderTextColor={colors.placeholder}
            keyboardType="email-address"
            autoCapitalize="none"
            style={[styles.input, { flexGrow: 1, minWidth: 200 }]}
          />
        ) : null}
        <Button title={t('share.make')} icon="link" busy={create.isPending} onPress={make} />
      </View>
      {create.error ? <Text style={styles.error}>{errorMessage(create.error)}</Text> : null}
      {made ? <Made made={made} /> : null}
      {(links.data ?? []).length ? (
        (links.data ?? []).map((l) => (
          <LinkRow key={l.id} link={l} lasting={lasting} onMade={setMade} />
        ))
      ) : (
        <Text style={styles.muted}>{t('share.none')}</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  made: {
    padding: space.md,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primaryTint,
  },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipOn: { borderColor: colors.primary, backgroundColor: colors.primaryTint },
});
