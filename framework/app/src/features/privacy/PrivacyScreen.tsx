import type { PrivacyRequest } from '@hykr/contracts';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { ScreenTitle, SectionHeading } from '../../components/ScreenTitle';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Text } from '../../components/ui/text';
import { useScreenContext } from '../../framework/assistant-context';
import { when } from '../../framework/dates';
import { LoadError } from '../../framework/EmptyState';
import { errorMessage } from '../../framework/hooks';
import { Loading } from '../../framework/Loading';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { styles } from '../../theme';
import { FileThumbs } from '../files/FileThumbs';
import { useFilePrivacyRequest, useMyPrivacyRequests } from './hooks';

const TONE: Record<PrivacyRequest['status'], 'neutral' | 'info' | 'warn' | 'success' | 'danger'> = {
  received: 'info',
  in_progress: 'warn',
  completed: 'success',
  refused: 'neutral',
  failed: 'danger',
};

const KIND = {
  export: 'privacy.kind.export',
  erase: 'privacy.kind.erase',
} as const satisfies Record<PrivacyRequest['kind'], string>;

const STATUS = {
  received: 'privacy.status.received',
  in_progress: 'privacy.status.in_progress',
  completed: 'privacy.status.completed',
  refused: 'privacy.status.refused',
  failed: 'privacy.status.failed',
} as const satisfies Record<PrivacyRequest['status'], string>;

const open = (r: PrivacyRequest) => r.status === 'received' || r.status === 'in_progress';

/** Ask for a copy, or to be forgotten (asked twice: it cannot be undone). */
function Ask({ requests }: { requests: readonly PrivacyRequest[] }) {
  const { t } = useT();
  const toast = useToast();
  const file = useFilePrivacyRequest();
  const [confirming, setConfirming] = useState(false);
  const busy = (kind: PrivacyRequest['kind']) => requests.some((r) => r.kind === kind && open(r));
  const ask = (kind: PrivacyRequest['kind']) =>
    file.mutate(
      { kind },
      {
        onSuccess: () => setConfirming(false),
        onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
      },
    );
  return (
    <Card>
      <Text variant="muted">{t('privacy.hint')}</Text>
      <View className="flex-row flex-wrap gap-2">
        <Button
          disabled={busy('export') || file.isPending}
          accessibilityLabel={t('privacy.export')}
          onPress={() => ask('export')}
        >
          <Text>{t('privacy.export')}</Text>
        </Button>
        {!confirming ? (
          <Button
            variant="secondary"
            disabled={busy('erase') || file.isPending}
            accessibilityLabel={t('privacy.erase')}
            onPress={() => setConfirming(true)}
          >
            <Text>{t('privacy.erase')}</Text>
          </Button>
        ) : null}
      </View>
      {confirming ? (
        <View className="gap-2">
          <Text>{t('privacy.eraseConfirm')}</Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              variant="destructive"
              disabled={file.isPending}
              accessibilityLabel={t('privacy.eraseYes')}
              onPress={() => ask('erase')}
            >
              <Text>{t('privacy.eraseYes')}</Text>
            </Button>
            <Button
              variant="subtle"
              accessibilityLabel={t('privacy.cancel')}
              onPress={() => setConfirming(false)}
            >
              <Text>{t('privacy.cancel')}</Text>
            </Button>
          </View>
        </View>
      ) : null}
    </Card>
  );
}

/**
 * "Your data": ask the business for a copy of the personal data it keeps about you, or to erase
 * it; see your requests, their deadlines, and download a copy once it is made. For everyone in
 * the business (`privacyPlugin`).
 */
export function PrivacyScreen() {
  useScreenContext({ screen: 'privacy' });
  const { t } = useT();
  const requests = useMyPrivacyRequests();
  const items = requests.data ?? [];
  return (
    <ScrollView contentContainerStyle={[styles.content, { gap: 16 }]}>
      <ScreenTitle title={t('privacy.title')} />
      <Ask requests={items} />
      <SectionHeading>{t('privacy.yours')}</SectionHeading>
      {requests.error ? (
        <LoadError what="your requests" onRetry={() => requests.refetch()} />
      ) : requests.isPending ? (
        <Loading />
      ) : items.length ? (
        items.map((r) => (
          <Card key={r.id}>
            <View className="flex-row flex-wrap items-center gap-2">
              <Text className="font-semibold">{t(KIND[r.kind])}</Text>
              <Badge variant={TONE[r.status]}>
                <Text>{t(STATUS[r.status])}</Text>
              </Badge>
            </View>
            <Text variant="muted">
              {when(r.receivedAt)}
              {r.dueAt && open(r) ? ` · ${t('privacy.due', { date: when(r.dueAt) })}` : ''}
            </Text>
            {r.reason ? <Text variant="muted">{r.reason}</Text> : null}
            {r.files.length ? <FileThumbs ids={r.files} /> : null}
          </Card>
        ))
      ) : (
        <Text variant="muted">{t('privacy.none')}</Text>
      )}
    </ScrollView>
  );
}
