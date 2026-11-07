import type { CallDirection, CallInfo } from '@hykr/contracts';
import type { MessageKey } from '@hykr/i18n';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { SectionHeading } from '../../components/ScreenTitle';
import { when } from '../../framework/dates';
import { LoadError } from '../../framework/EmptyState';
import { Field } from '../../framework/Field';
import { errorMessage } from '../../framework/hooks';
import { Icon, type IconName } from '../../framework/Icon';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { colors, space, styles } from '../../theme';
import { useCallProvider, useCalls, useDialCall, useLogCall } from './hooks';

/** E.164, as the API takes it: '+' and 8 to 15 digits (spaces and dashes typed are dropped). */
const E164 = /^\+[1-9]\d{7,14}$/;
const digits = (s: string) => s.replace(/[\s()-]/g, '');

const iconOf = (c: CallInfo): IconName =>
  c.status === 'missed' || c.status === 'failed'
    ? 'phone-missed'
    : c.direction === 'inbound'
      ? 'phone-incoming'
      : 'phone-outgoing';

function CallRow({ call }: { call: CallInfo }) {
  const { t } = useT();
  const number = call.direction === 'inbound' ? call.from : call.to;
  const parts = [
    t(`calls.status.${call.status}` as MessageKey),
    call.durationS
      ? t('calls.minutes', { n: String(Math.max(1, Math.round(call.durationS / 60))) })
      : '',
    when(call.startedAt ?? call.createdAt),
  ].filter(Boolean);
  return (
    <View style={[styles.row, { gap: space.sm, paddingVertical: space.xs }]}>
      <Icon
        name={iconOf(call)}
        color={call.status === 'failed' || call.status === 'missed' ? colors.danger : colors.muted}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.text} numberOfLines={1}>
          {number ?? t(call.direction === 'inbound' ? 'calls.inbound' : 'calls.outbound')}
        </Text>
        <Text style={styles.muted}>{parts.join(' · ')}</Text>
        {call.notes ? <Text style={styles.text}>{call.notes}</Text> : null}
        {call.error && call.status === 'failed' ? (
          <Text style={styles.muted}>{call.error}</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * A record's phone calls, and logging one: who called whom, how it went, notes. With a
 * telephony provider the business may use, a number can also be called from here (the
 * provider connects it). The API decides who sees which calls and who may call.
 */
export function RecordCalls({ entity, id }: { entity: string; id: string }) {
  const { t } = useT();
  const toast = useToast();
  const calls = useCalls(entity, id);
  const provider = useCallProvider();
  const logCall = useLogCall();
  const dial = useDialCall();
  const [direction, setDirection] = useState<CallDirection>('outbound');
  const [number, setNumber] = useState('');
  const [notes, setNotes] = useState('');
  const phone = digits(number);
  const validNumber = !phone || E164.test(phone);
  const fail = (e: unknown) => toast.show({ message: errorMessage(e), tone: 'error' });

  const log = () =>
    logCall.mutate(
      {
        entity,
        id,
        direction,
        status: 'completed',
        ...(phone ? (direction === 'inbound' ? { from: phone } : { to: phone }) : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
      {
        onSuccess: () => {
          setNumber('');
          setNotes('');
        },
        onError: fail,
      },
    );

  const call = () =>
    dial.mutate(
      { entity, id, to: phone },
      {
        onSuccess: (out) => {
          if (out.status === 'needs_approval')
            toast.show({ message: t('calls.dialWaiting'), tone: 'neutral' });
        },
        onError: fail,
      },
    );

  return (
    <View style={{ gap: space.sm }}>
      <SectionHeading>{t('calls.title')}</SectionHeading>
      {calls.error ? (
        <LoadError what="the calls" onRetry={() => calls.refetch()} />
      ) : calls.data?.length ? (
        calls.data.map((c) => <CallRow key={c.id} call={c} />)
      ) : (
        <Text style={styles.muted}>{t('calls.none')}</Text>
      )}
      <View style={[styles.row, { gap: space.sm }]}>
        {(['outbound', 'inbound'] as const).map((d) => (
          <Button
            key={d}
            title={t(d === 'inbound' ? 'calls.inbound' : 'calls.outbound')}
            icon={d === 'inbound' ? 'phone-incoming' : 'phone-outgoing'}
            variant={direction === d ? 'secondary' : 'ghost'}
            onPress={() => setDirection(d)}
          />
        ))}
      </View>
      <View style={[styles.row, { flexWrap: 'wrap', gap: space.sm, alignItems: 'flex-end' }]}>
        <Field
          label={t('calls.number')}
          value={number}
          onChangeText={setNumber}
          keyboardType="phone-pad"
          placeholder="+14155550123"
          error={validNumber ? undefined : '+14155550123'}
        />
        <Field label={t('calls.notes')} value={notes} onChangeText={setNotes} />
      </View>
      <View style={[styles.row, { flexWrap: 'wrap', gap: space.sm }]}>
        <Button
          title={t('calls.log')}
          icon="edit-3"
          variant="secondary"
          disabled={!validNumber || (!phone && !notes.trim())}
          busy={logCall.isPending}
          onPress={log}
        />
        {provider.data?.available ? (
          <Button
            title={t('calls.dial')}
            icon="phone-call"
            disabled={!phone || !validNumber}
            busy={dial.isPending}
            onPress={call}
          />
        ) : null}
      </View>
    </View>
  );
}
