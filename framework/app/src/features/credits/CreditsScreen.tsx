import type { CreditsStatus, LedgerEntry } from '@hykr/contracts';
import type { MessageKey } from '@hykr/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Linking, ScrollView, View } from 'react-native';
import { api } from '../../api';
import { ScreenTitle, SectionHeading } from '../../components/ScreenTitle';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Text } from '../../components/ui/text';
import { useScreenContext } from '../../framework/assistant-context';
import { when } from '../../framework/dates';
import { LoadError } from '../../framework/EmptyState';
import { Field } from '../../framework/Field';
import { errorMessage } from '../../framework/hooks';
import { Loading } from '../../framework/Loading';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { colors, styles } from '../../theme';
import { formatCredits, meterQuantity, parseCredits } from './money';

/** A bar for how much of a cap is used: warning past the alert, danger at the pause. */
function UsedBar({
  percent,
  alertAt,
  pauseAt,
}: {
  percent: number;
  alertAt: number;
  pauseAt: number;
}) {
  const tone =
    percent >= pauseAt ? colors.danger : percent >= alertAt ? colors.warnText : colors.primary;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.min(100, Math.round(percent)) }}
      style={{ height: 8, borderRadius: 4, backgroundColor: colors.divider, overflow: 'hidden' }}
    >
      <View style={{ width: `${Math.min(100, percent)}%`, height: 8, backgroundColor: tone }} />
    </View>
  );
}

/** The framework's meters have names in every language; a meter a module added shows its own. */
const METER_NAMES: Readonly<Record<string, MessageKey>> = {
  tokens: 'credits.meter.tokens',
  tool_calls: 'credits.meter.tool_calls',
  messages: 'credits.meter.messages',
  voice_seconds: 'credits.meter.voice_seconds',
  embedding_tokens: 'credits.meter.embedding_tokens',
};

function Meters({ status }: { status: CreditsStatus }) {
  const { t, lang } = useT();
  const shown = status.meters.filter((m) => m.quantity > 0 || m.limit !== undefined);
  if (!shown.length) return null;
  return (
    <Card>
      {shown.map((m) => (
        <View key={m.meter} className="gap-1">
          <View className="flex-row items-center justify-between gap-2">
            <Text className="font-semibold">
              {METER_NAMES[m.meter] ? t(METER_NAMES[m.meter]) : m.meter}
            </Text>
            <Text variant="muted">
              {meterQuantity(m.meter, m.quantity)}
              {m.limit !== undefined ? ` / ${meterQuantity(m.meter, m.limit)}` : ''}
              {m.cost !== undefined && status.currency
                ? ` · ${formatCredits(m.cost, status.currency, lang)}`
                : ''}
            </Text>
          </View>
          {m.usedPercent !== undefined && (
            <UsedBar percent={m.usedPercent} alertAt={status.alertAt} pauseAt={status.pauseAt} />
          )}
        </View>
      ))}
    </Card>
  );
}

function Buy({ currency }: { currency: string }) {
  const { t, lang } = useT();
  const toast = useToast();
  const client = useQueryClient();
  const [typed, setTyped] = useState('');
  const amount = parseCredits(typed, currency);
  const buy = useMutation({
    mutationFn: (minor: number) => api.credits.buy(minor),
    onSuccess: async (result) => {
      setTyped('');
      await client.invalidateQueries({ queryKey: ['credits'] });
      if (result.status === 'needs_approval') {
        toast.show({ message: t('credits.waiting'), tone: 'neutral' });
        return;
      }
      const purchase = result.value;
      if (purchase.status === 'open' && purchase.checkoutUrl)
        toast.show({
          message: formatCredits(purchase.amount, currency, lang),
          action: {
            label: t('credits.checkout'),
            onPress: () => Linking.openURL(purchase.checkoutUrl as string),
          },
          durationMs: 30_000,
        });
      else toast.show({ message: formatCredits(purchase.amount, currency, lang), tone: 'success' });
    },
    onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
  });
  return (
    <Card>
      <SectionHeading>{t('credits.buy')}</SectionHeading>
      <View className="flex-row flex-wrap items-end gap-2">
        <Field
          label={`${t('credits.amount')} (${currency})`}
          value={typed}
          onChangeText={setTyped}
          keyboardType="decimal-pad"
          placeholder="e.g. 500"
          width={180}
        />
        <Button
          disabled={!amount || buy.isPending}
          onPress={() => amount && buy.mutate(amount)}
          accessibilityLabel={t('credits.buy')}
        >
          <Text>{t('credits.buy')}</Text>
        </Button>
      </View>
    </Card>
  );
}

function Ledger({ currency }: { currency: string }) {
  const { t, lang } = useT();
  const ledger = useQuery({ queryKey: ['credits', 'ledger'], queryFn: () => api.credits.ledger() });
  const items: LedgerEntry[] = ledger.data?.items ?? [];
  if (!items.length) return null;
  return (
    <Card>
      <SectionHeading>{t('credits.ledger')}</SectionHeading>
      {items.map((e) => (
        <View key={e.id} className="flex-row items-center justify-between gap-2">
          <View className="flex-1 gap-0.5">
            <Text className="font-semibold">{t(`credits.kind.${e.kind}` as MessageKey)}</Text>
            <Text variant="muted">
              {when(e.at)}
              {e.note ? ` · ${e.note}` : ''}
            </Text>
          </View>
          <Text style={{ color: e.amount < 0 ? colors.text : colors.success }}>
            {e.amount > 0 ? '+' : ''}
            {formatCredits(e.amount, currency, lang)}
          </Text>
        </View>
      ))}
    </Card>
  );
}

/**
 * The business's credits: how much of this period's caps it used, whether it is paused and why,
 * and, for the people who manage them, the balance, buying more and the history. The API decides
 * what each person sees (amounts only with `credits.manage`).
 */
export function CreditsScreen() {
  useScreenContext({ screen: 'credits' });
  const { t, lang } = useT();
  const status = useQuery({ queryKey: ['credits'], queryFn: () => api.credits.status() });
  const s = status.data;
  const manages = !!s && 'currency' in s;
  return (
    <ScrollView contentContainerStyle={[styles.content, { gap: 16 }]}>
      <ScreenTitle
        title={t('credits.title')}
        subtitle={s ? t('credits.periodEnds', { date: when(s.period.end) }) : undefined}
      />
      {status.error ? (
        <LoadError what="the credits" onRetry={() => status.refetch()} />
      ) : !s ? (
        <Loading />
      ) : (
        <>
          <Card>
            {s.paused && (
              <Badge variant="danger">
                <Text>{t('credits.pausedNow', { reason: s.paused.reason })}</Text>
              </Badge>
            )}
            {s.usedPercent === null ? (
              <Text variant="muted">{t('credits.notEnforced')}</Text>
            ) : (
              <View className="gap-2">
                <Text className="font-semibold">
                  {t('credits.used', { percent: Math.round(s.usedPercent) })}
                </Text>
                <UsedBar percent={s.usedPercent} alertAt={s.alertAt} pauseAt={s.pauseAt} />
              </View>
            )}
            {manages && s.currency && (
              <View className="flex-row flex-wrap gap-x-6 gap-y-1">
                {s.balance !== undefined && (
                  <Text>
                    {t('credits.balance')}: {formatCredits(s.balance, s.currency, lang)}
                  </Text>
                )}
                {s.allowance ? (
                  <Text>
                    {t('credits.allowance')}: {formatCredits(s.allowance, s.currency, lang)}
                  </Text>
                ) : null}
                {s.remaining !== undefined && (
                  <Text>
                    {t('credits.remaining')}: {formatCredits(s.remaining, s.currency, lang)}
                  </Text>
                )}
              </View>
            )}
          </Card>
          <Meters status={s} />
          {manages && s.currency && <Buy currency={s.currency} />}
          {manages && s.currency && <Ledger currency={s.currency} />}
        </>
      )}
    </ScrollView>
  );
}
