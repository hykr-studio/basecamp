import type { InviteInfo } from '@hykr/contracts';
import type { MessageKey } from '@hykr/i18n';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { SectionHeading } from '../../components/ScreenTitle';
import { Field } from '../../framework/Field';
import { errorMessage } from '../../framework/hooks';
import { Icon } from '../../framework/Icon';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { colors, space, styles } from '../../theme';
import { useInvites, useSendInvite } from './hooks';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function InviteRow({ invite }: { invite: InviteInfo }) {
  const { t } = useT();
  return (
    <View style={[styles.row, { gap: space.sm, paddingVertical: space.xs }]}>
      <Icon
        name={invite.method === 'CANCEL' ? 'x-circle' : 'mail'}
        color={invite.status === 'failed' ? colors.danger : colors.muted}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.text} numberOfLines={1}>
          {invite.name ? `${invite.name} · ${invite.email}` : invite.email}
        </Text>
        <Text style={styles.muted}>
          {t(`calendar.status.${invite.status}` as MessageKey)}
          {invite.error && invite.status === 'failed' ? ` · ${invite.error}` : ''}
        </Text>
      </View>
    </View>
  );
}

/**
 * A record's calendar invites: who was invited and whether each went out, and a field to invite
 * someone by email (an .ics their calendar adds; updates follow the record). The API decides who
 * may send and who sees which invites.
 */
export function RecordInvites({ entity, id }: { entity: string; id: string }) {
  const { t } = useT();
  const toast = useToast();
  const invites = useInvites(entity, id);
  const send = useSendInvite();
  const [email, setEmail] = useState('');
  const valid = EMAIL.test(email.trim());
  return (
    <View style={{ gap: space.sm }}>
      <SectionHeading>{t('calendar.invites')}</SectionHeading>
      {invites.data?.length ? (
        invites.data.map((i) => <InviteRow key={i.id} invite={i} />)
      ) : (
        <Text style={styles.muted}>{t('calendar.none')}</Text>
      )}
      <View style={[styles.row, { flexWrap: 'wrap', gap: space.sm, alignItems: 'flex-end' }]}>
        <Field
          label={t('calendar.inviteEmail')}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          placeholder="name@example.com"
        />
        <Button
          title={t('calendar.sendInvite')}
          icon="send"
          variant="secondary"
          disabled={!valid}
          busy={send.isPending}
          onPress={() =>
            send.mutate(
              { entity, id, to: [{ email: email.trim() }] },
              {
                onSuccess: (out) => {
                  setEmail('');
                  if (out.status === 'needs_approval')
                    toast.show({ message: t('calendar.inviteWaiting'), tone: 'neutral' });
                },
                onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
              },
            )
          }
        />
      </View>
    </View>
  );
}
